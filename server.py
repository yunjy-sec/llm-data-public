"""llm-data — 임의 형식 표 텍스트를 목표 JSON Schema 레코드로 정규화하는 서비스.

python server.py --host 127.0.0.1 --port 8821
"""

import argparse
import json
import os
import queue
import re
import secrets
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import llm
import sso

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")

# ---- 저장 영역 구분 (배포: container 재기동 시 유실 허용 여부로 반드시 나눈다) ----
# LOGIC   : 코드·기본본. 이미지에 포함, 재기동 시 유실 무관 — server.py, llm.py, web/,
#           prompts/(기본본), examples/, config/(기본본)
# PERSIST : persistent volume 필수. env LLM_DATA_PERSIST (기본 ROOT/data) —
#           dataset·데이터셋 저장본·편집 로그·chats·masters·사용자 저장 config/prompt
# RUNTIME : 유실 허용. env LLM_DATA_RUNTIME (기본 ROOT/data) — jobs 변환 작업 이력
PERSIST_ENV = os.environ.get("LLM_DATA_PERSIST")
RUNTIME_ENV = os.environ.get("LLM_DATA_RUNTIME")
DATA_DIR = PERSIST_ENV or os.path.join(ROOT, "data")
JOBS_DIR = os.path.join(RUNTIME_ENV or os.path.join(ROOT, "data"), "jobs")
# prompt는 사용자 편집 대상 — 저장은 항상 PERSIST 영역에, 기본본은 코드(LOGIC) 영역에.
# env 미설정이어도 코드 영역의 추적 파일을 덮어쓰지 않는다 (읽기는 저장본 → 기본본 순).
PROMPT_DEFAULT_PATH = os.path.join(ROOT, "prompts", "table_to_schema.md")
PROMPT_PATH = os.path.join(DATA_DIR, "prompts", "table_to_schema.md")
DEFAULT_SCHEMA_PATH = os.path.join(ROOT, "examples", "esd_schema.json")

MAX_BODY = 5_000_000
MAX_INPUT_CHARS = 200_000
JOB_ID_RE = re.compile(r"^JOB-\d{8}-\d{6}-[0-9A-F]{8}$")
CHATS_DIR = os.path.join(DATA_DIR, "chats")
CHAT_ID_RE = re.compile(r"^CHAT-\d{8}-\d{6}-[0-9A-F]{8}$")
STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "sheet.html": "text/html; charset=utf-8",
}
VENDOR_TYPES = {
    ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject", ".otf": "font/otf",
}
# 모델 목록은 설정(config/llm.json의 "models")에서 동적으로 읽는다 — llm.allowed_models()

_LOCK = threading.RLock()

# 업스트림 llm-api가 전역 직렬(한 번에 1호출)이므로 로컬도 단일 소비 큐로 맞춘다.
# 이래야 대기 중인 잡의 소켓 타임아웃이 큐 대기시간을 소모하지 않는다.
_JOB_QUEUE = queue.Queue()
_ACTIVE_JOB = None  # 워커 스레드(1개)만 쓰고 핸들러는 읽기만 한다

# LLM 응답을 강제할 출력 envelope. records 내부 필드 제약은 시스템 프롬프트가 담당
# (target schema를 여기 중첩하면 null 처리 규칙과 충돌해 구조화 출력이 실패할 수 있다).
ENVELOPE_SCHEMA = {
    "type": "object",
    "required": ["records", "mapping", "unmapped", "warnings"],
    "properties": {
        "records": {"type": "array", "items": {"type": "object"}},
        "mapping": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["source", "target", "rule"],
                "properties": {
                    "source": {"type": "string"},
                    "target": {},
                    "rule": {"type": "string"},
                },
            },
        },
        "unmapped": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["source", "reason"],
                "properties": {
                    "source": {"type": "string"},
                    "reason": {"type": "string"},
                    "values_sample": {"type": "array"},
                },
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


# 잡 진행 단계 — 프론트가 이 순서대로 흐름을 표시한다
STEPS = [
    ("submit", "입력 접수"),
    ("compose", "프롬프트 구성"),
    ("llm", "LLM 수행"),
    ("parse", "파싱·검증"),
]


def seed_steps():
    return [{"key": k, "label": lb, "status": "pending",
             "started_at_ms": None, "ended_at_ms": None, "duration_ms": None}
            for k, lb in STEPS]


def set_step(job_id, key, status, duration_ms=None):
    """단계 전이를 잡 파일에 즉시 반영해 폴링 클라이언트가 실시간으로 보게 한다."""
    with _LOCK:
        job = load_job(job_id)
        if job is None:
            return None
        now_ms = int(time.time() * 1000)
        for st in job.get("steps", []):
            if st["key"] != key:
                continue
            st["status"] = status
            if status == "running":
                st["started_at_ms"] = now_ms
            else:
                st["ended_at_ms"] = now_ms
                if duration_ms is not None:
                    st["duration_ms"] = duration_ms
                elif st.get("started_at_ms"):
                    st["duration_ms"] = now_ms - st["started_at_ms"]
                else:
                    st["duration_ms"] = 0
        save_job(job)
        return job


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def make_job_id():
    return "JOB-%s-%s" % (datetime.now().strftime("%Y%m%d-%H%M%S"), secrets.token_hex(4).upper())


def atomic_write_json(path, obj):
    tmp = path + ".tmp-%d" % threading.get_ident()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(6):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def atomic_write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)  # persist 모드 첫 저장 시 디렉터리 생성
    tmp = path + ".tmp-%d" % threading.get_ident()
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def job_path(job_id):
    return os.path.join(JOBS_DIR, job_id + ".json")


def load_job(job_id):
    with _LOCK:
        try:
            with open(job_path(job_id), encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None


def save_job(job):
    with _LOCK:
        atomic_write_json(job_path(job["id"]), job)


def update_job(job_id, **fields):
    with _LOCK:
        job = load_job(job_id)
        if job is None:
            return None
        job.update(fields)
        save_job(job)
        return job


def safe_update(job_id, **fields):
    """잡을 종결 상태로 옮기는 마지막 기록은 실패해도 스레드를 죽이면 안 된다."""
    for attempt in range(2):
        try:
            return update_job(job_id, **fields)
        except Exception as e:
            if attempt == 0:
                time.sleep(0.3)
            else:
                print("[llm-data] [X] job %s 상태 기록 실패: %s: %s" % (job_id, type(e).__name__, e))
    return None


def list_jobs(limit=30):
    with _LOCK:
        try:
            names = [n for n in os.listdir(JOBS_DIR) if n.endswith(".json")]
        except FileNotFoundError:
            return []
        names.sort(reverse=True)
        out = []
        for n in names[:limit]:
            try:
                with open(os.path.join(JOBS_DIR, n), encoding="utf-8") as f:
                    j = json.load(f)
            except Exception:
                continue
            out.append({
                "id": j.get("id"),
                "state": j.get("state"),
                "created_at": j.get("created_at"),
                "mode": j.get("mode") or "fill",
                "model": j.get("model"),
                "input_preview": j.get("input_preview"),
                "input_chars": j.get("input_chars"),
                "started_at_ms": j.get("started_at_ms"),
                "latency_ms": j.get("latency_ms"),
                "record_count": len((j.get("result") or {}).get("records") or []),
                "error": j.get("error"),
                "cancel_requested": bool(j.get("cancel_requested")),
                "steps": [{"key": s.get("key"), "label": s.get("label"), "status": s.get("status"),
                           "started_at_ms": s.get("started_at_ms"), "duration_ms": s.get("duration_ms")}
                          for s in (j.get("steps") or [])],
            })
        return out


def reap_running():
    """서버 재기동 시 죽은 워커의 잡을 error로 정리 (issue-public reap_running 규약)."""
    with _LOCK:
        try:
            names = os.listdir(JOBS_DIR)
        except FileNotFoundError:
            return
        for n in names:
            if not n.endswith(".json"):
                continue
            jid = n[:-5]
            job = load_job(jid)
            if job and job.get("state") in ("queued", "running"):
                job["state"] = "error"
                job["error"] = {"code": "E-2008", "message": "서버 재기동으로 변환 작업 중단"}
                job["finished_at"] = now_iso()
                save_job(job)


DATASET_PATH = os.path.join(DATA_DIR, "dataset.json")
EXPORTS_DIR = os.path.join(DATA_DIR, "exports")  # Save As 스냅샷 — PERSIST 영역
DATASET_LOG_PATH = os.path.join(DATA_DIR, "dataset-log.jsonl")
MASTERS_DIR = os.path.join(DATA_DIR, "masters")
MASTER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def seed_masters():
    """masters가 비어 있으면 예시 스키마로 시드 (schema·코드 테이블의 초기 마스터)."""
    os.makedirs(MASTERS_DIR, exist_ok=True)
    if any(n.endswith(".json") for n in os.listdir(MASTERS_DIR)):
        return
    for src, name in (("esd_schema.json", "esd"),):  # 마스터 관리 대상은 esd만
        try:
            with open(os.path.join(ROOT, "examples", src), encoding="utf-8-sig") as f:
                schema = json.load(f)
            atomic_write_json(os.path.join(MASTERS_DIR, name + ".json"), schema)
        except (OSError, ValueError):
            pass


def migrate_masters():
    """기존 마스터 파일 중 구형(properties) 스키마를 v4로 변환해 다시 쓴다 (기동 시 1회)."""
    try:
        names = [n for n in os.listdir(MASTERS_DIR) if n.endswith(".json")]
    except OSError:
        return
    for n in names:
        p = os.path.join(MASTERS_DIR, n)
        try:
            with open(p, encoding="utf-8-sig") as f:
                schema = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(schema, dict) and not isinstance(schema.get("columns"), list):
            converted = normalize_schema(schema)
            if converted.get("columns"):
                atomic_write_json(p, converted)


def master_path(name):
    return os.path.join(MASTERS_DIR, name + ".json")


# ---- 스키마 형식 v4: {schema_name, description, version, columns:[{group, fields:[...]}]} ----
# field = {id(key), label, type, description, description_detail,
#          mapping_logic_ip_eval_esd, mapping_logic_chatbot} (+ 선택 enum 코드 목록)
# group은 표 헤더의 묶음(병합)일 뿐이며 레코드는 id를 key로 하는 평면 객체다.
FIELD_KEYS = ("id", "label", "type", "description", "description_detail",
              "mapping_logic_ip_eval_esd", "mapping_logic_chatbot")


def migrate_legacy_schema(schema):
    """구형 {properties:{...}} 스키마를 v4(columns/group/fields)로 변환. 신형은 그대로 반환."""
    if not isinstance(schema, dict):
        return schema
    if isinstance(schema.get("columns"), list):
        return schema
    props = schema.get("properties")
    if not isinstance(props, dict):
        return schema
    fields = []
    for fid, spec in props.items():
        spec = spec if isinstance(spec, dict) else {}
        t = spec.get("type")
        if isinstance(t, list):  # ["string","null"] → string (모든 값은 문자열 규약)
            t = next((x for x in t if x != "null"), "string")
        f = {"id": str(fid), "label": str(spec.get("label") or ""), "type": str(t or "string"),
             "description": str(spec.get("description") or ""), "description_detail": "",
             "mapping_logic_ip_eval_esd": "", "mapping_logic_chatbot": ""}
        if isinstance(spec.get("enum"), list):
            f["enum"] = [str(x) for x in spec["enum"]]
        fields.append(f)
    return {"schema_name": str(schema.get("title") or schema.get("schema_name") or ""),
            "description": str(schema.get("description") or ""),
            "version": str(schema.get("version") or "1"),
            "columns": [{"group": "", "fields": fields}] if fields else []}


def schema_fields(schema):
    """columns 순서 → fields 순서를 보존한 field dict 리스트 (열 순서 = 표 열 순서)."""
    out = []
    for col in (migrate_legacy_schema(schema) or {}).get("columns") or []:
        if not isinstance(col, dict):
            continue
        for f in col.get("fields") or []:
            if isinstance(f, dict) and f.get("id"):
                out.append(dict(f, group=str(col.get("group") or "")))
    return out


def schema_field_map(schema):
    """{id: field} — id 중복 시 선행 우선 (id는 JSON 연산 key라 중복은 저장 시 차단)."""
    m = {}
    for f in schema_fields(schema):
        m.setdefault(str(f["id"]), f)
    return m


def schema_field_ids(schema):
    return [str(f["id"]) for f in schema_fields(schema)]


def schema_title(schema):
    s = schema or {}
    return s.get("schema_name") or s.get("title") or ""


def validate_row_values(schema, values):
    """행 편집 정합성: 스키마에 없는 열 차단(헤더 변경 방지) + enum 코드 검증."""
    errs = []
    props = schema_field_map(schema)
    for k, v in values.items():
        if k not in props:
            errs.append("스키마에 없는 열 '%s' — 헤더(스키마)는 데이터 편집에서 변경할 수 없음" % k)
            continue
        if v in (None, ""):
            continue
        spec = props[k]
        if isinstance(spec, dict) and isinstance(spec.get("enum"), list) and v not in spec["enum"]:
            errs.append("'%s' 값 '%s'는 허용 코드(%s)가 아님" % (k, v, ", ".join(map(str, spec["enum"]))))
    return errs


def validate_master_schema(schema):
    if not isinstance(schema, dict):
        return "schema는 JSON 객체여야 함"
    if isinstance(schema.get("properties"), dict) and schema["properties"]:
        return None  # 구형 — 저장 시 migrate_legacy_schema로 변환된다
    cols = schema.get("columns")
    if not isinstance(cols, list) or not cols:
        return "schema에 columns 배열이 필요함 (columns: [{group, fields: [...]}])"
    seen = set()
    for col in cols:
        if not isinstance(col, dict):
            return "columns의 각 원소는 {group, fields} 객체여야 함"
        fields = col.get("fields")
        if not isinstance(fields, list) or not fields:
            return "group '%s'에 fields 배열이 필요함" % (col.get("group") or "")
        for f in fields:
            if not isinstance(f, dict) or not str(f.get("id") or "").strip():
                return "각 field에는 id가 필요함 (id가 JSON 연산의 key)"
            fid = str(f["id"]).strip()
            if fid in seen:
                return "중복된 field id '%s' — id는 스키마 전체에서 유일해야 함" % fid
            seen.add(fid)
    return None


def normalize_schema(schema):
    """저장 직전 정규화: 구형은 v4로 변환하고, 비어 있는 field 키는 ""로 채운다."""
    s = migrate_legacy_schema(schema)
    if not isinstance(s, dict) or not isinstance(s.get("columns"), list):
        return s
    cols = []
    for col in s["columns"]:
        fields = []
        for f in col.get("fields") or []:
            nf = {k: str(f.get(k) or "") for k in FIELD_KEYS}
            nf["id"] = str(f.get("id") or "").strip()
            if not nf["type"]:
                nf["type"] = "string"
            if isinstance(f.get("enum"), list) and f["enum"]:
                nf["enum"] = [str(x) for x in f["enum"]]
            fields.append(nf)
        cols.append({"group": str(col.get("group") or ""), "fields": fields})
    return {"schema_name": str(s.get("schema_name") or ""),
            "description": str(s.get("description") or ""),
            "version": str(s.get("version") or "1"),
            "columns": cols}


def clean_uid(v):
    return re.sub(r"[^A-Za-z0-9_-]", "", str(v or "")) or "guest"


def append_ds_log(action, user, file, detail):
    """데이터셋 CRUD·작업 감사 로그 (append-only JSONL)."""
    entry = {"ts": now_iso(), "user": user or "guest", "action": action,
             "file": file, "detail": detail}
    with _LOCK:
        with open(DATASET_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def load_dataset():
    with _LOCK:
        try:
            with open(DATASET_PATH, encoding="utf-8") as f:
                ds = json.load(f)
        except (FileNotFoundError, ValueError):
            ds = None
    if not isinstance(ds, dict):
        ds = {}
    if isinstance(ds.get("schema"), dict):
        ds["schema"] = migrate_legacy_schema(ds["schema"])  # 구형 파일도 v4로 읽힌다
    ds.setdefault("schema", None)
    ds.setdefault("rows", [])
    ds.setdefault("inserted_jobs", [])
    ds.setdefault("last_insert", None)
    ds.setdefault("updated_at", None)
    ds.setdefault("file", "dataset.json")  # 현재 파일 — Save는 여기에, Save As는 새 이름 발급
    ds.setdefault("next_id", 1)            # 행 내부 식별자(id) 순번 발급기 — 표시용 아님
    for r in ds["rows"]:                   # 표시 meta 열은 user_id/created_at/updated_at
        r.setdefault("user_id", "guest")
        if isinstance(r.get("id"), int):   # 저장 데이터는 모두 string — 행 id 포함
            r["id"] = str(r["id"])
    return ds


def write_snapshot(ds, fname, uid):
    os.makedirs(EXPORTS_DIR, exist_ok=True)
    snapshot = {"name": fname, "saved_at": now_iso(), "user": uid,
                "source": "data/dataset.json", "count": len(ds["rows"]),
                "schema": ds["schema"], "rows": ds["rows"]}
    with _LOCK:
        atomic_write_json(os.path.join(EXPORTS_DIR, fname), snapshot)


def save_dataset(ds):
    with _LOCK:
        atomic_write_json(DATASET_PATH, ds)


def chat_path(chat_id):
    return os.path.join(CHATS_DIR, chat_id + ".json")


def load_chat(chat_id):
    with _LOCK:
        try:
            with open(chat_path(chat_id), encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return None


def save_chat(chat):
    with _LOCK:
        os.makedirs(CHATS_DIR, exist_ok=True)
        atomic_write_json(chat_path(chat["id"]), chat)


_CHAT_LOCKS = {}
_CHAT_LOCKS_GUARD = threading.Lock()
# chat별 in-flight 전송 표시 — 프론트가 새로고침돼도 진행 과정을 복원해 렌더링한다.
# 값: {"message", "ts", "model", "title", ("edit_index"), ("cancelled")}. 저장 완료·실패 시 제거.
_CHAT_PENDING = {}


def chat_cfg_with_options(body, cfg):
    """요청의 model·temperature·reasoning_effort를 cfg에 반영 (지원하지 않는 값은 무시).
    잘못된 값이면 오류 메시지를 반환한다."""
    model = body.get("model")
    if model is not None:
        if model not in llm.allowed_models(cfg):
            return None, "지원하지 않는 model"
        cfg = dict(cfg, model=model)
    # 선택 가능한 body 항목(설정 body의 배열·범위)만 요청에서 받는다
    choices = llm.model_options(cfg).get(str(llm.current_model(cfg))) or {}
    for key, spec in choices.items():
        val = body.get(key)
        if val in (None, ""):
            continue
        if llm.choice_value(spec, val) is None:
            hint = (", ".join(map(str, spec.get("values") or [])) if spec.get("kind") == "enum"
                    else "%s~%s" % (spec.get("min"), spec.get("max")))
            return None, "'%s'는 %s 모델의 %s 허용 범위(%s)가 아님" % (val, llm.current_model(cfg), key, hint)
        cfg = dict(cfg, **{key: str(val)})
    return cfg, None


def chat_lock(chat_id):
    # chat 단위 직렬화: send의 load→LLM→save 구간과 branch/update의 load→save 구간이
    # 같은 chat에서 겹치며 서로의 저장을 덮어쓰는 lost update를 막는다 (다른 chat은 병행).
    with _CHAT_LOCKS_GUARD:
        lk = _CHAT_LOCKS.get(chat_id)
        if lk is None:
            lk = _CHAT_LOCKS[chat_id] = threading.Lock()
        return lk


def apply_branch_switch(chat, idx, to):
    # 한 fork의 활성 variant 전환 (메모리 내 — 저장은 호출자가). 실패 시 오류 문자열 반환.
    alts = chat.setdefault("alts", {})
    entry = alts.get(str(idx)) if isinstance(idx, int) else None
    if not entry or not isinstance(to, int) or not (0 <= to < len(entry["variants"])):
        return "분기 정보가 없음"
    if to == entry["active"]:
        return None
    msgs = chat.get("messages") or []
    entry["variants"][entry["active"]] = {
        "messages": msgs[idx:],
        "alts": {k: v for k, v in alts.items() if k.isdigit() and int(k) > idx}}
    for k in [k for k in list(alts.keys()) if k.isdigit() and int(k) > idx]:
        del alts[k]
    target = entry["variants"][to]
    chat["messages"] = msgs[:idx] + (target.get("messages") or [])
    for k, v in (target.get("alts") or {}).items():
        alts[k] = v
    # unpack한 슬롯은 비운다 — 같은 서브트리가 top-level과 variant 양쪽에 중복 직렬화되는 것 방지
    entry["variants"][to] = {"messages": [], "alts": {}}
    entry["active"] = to
    return None


def list_chats():
    with _LOCK:
        try:
            names = sorted((n for n in os.listdir(CHATS_DIR) if n.endswith(".json")), reverse=True)
        except FileNotFoundError:
            return []
        out = []
        for n in names[:50]:
            c = load_chat(n[:-5])
            if c:
                cum = 0
                ctx = 0
                for m in c.get("messages") or []:
                    u = m.get("usage") or {}
                    if u.get("total_tokens"):
                        cum += u["total_tokens"]
                        ctx = (u.get("prompt_tokens") or 0) + (u.get("completion_tokens") or 0)
                out.append({"id": c["id"], "title": c.get("title") or c["id"],
                            "updated_at": c.get("updated_at"), "count": len(c.get("messages") or []),
                            "cum_tokens": cum, "ctx_tokens": ctx, "model": c.get("model"),
                            "pinned": bool(c.get("pinned")), "project": c.get("project")})
        return out


# ---- 프로젝트 (대화 묶음) — PERSIST 영역 projects.json ----
PROJECTS_PATH = os.path.join(DATA_DIR, "projects.json")


def load_projects():
    with _LOCK:
        try:
            with open(PROJECTS_PATH, encoding="utf-8") as f:
                p = json.load(f)
            return p if isinstance(p, dict) else {}
        except (FileNotFoundError, ValueError):
            return {}


def save_projects(projects):
    with _LOCK:
        atomic_write_json(PROJECTS_PATH, projects)


def load_prompt_template():
    # 사용자 저장본(PERSIST) 우선, 없으면 이미지의 기본본
    for p in (PROMPT_PATH, PROMPT_DEFAULT_PATH):
        try:
            with open(p, encoding="utf-8-sig") as f:
                return f.read()
        except FileNotFoundError:
            continue
    return ""


def default_schema():
    with open(DEFAULT_SCHEMA_PATH, encoding="utf-8-sig") as f:
        return migrate_legacy_schema(json.load(f))


def build_system_prompt(schema):
    return load_prompt_template().replace(
        "{{TARGET_SCHEMA}}", json.dumps(schema, ensure_ascii=False, indent=2)
    )


def normalize_result(parsed):
    """LLM 출력 envelope의 누락 키를 보정하고 형태를 강제한다."""
    if not isinstance(parsed, dict):
        raise llm.LLMError("E-3001", "LLM 출력이 JSON 객체가 아님")
    records = parsed.get("records")
    if not isinstance(records, list):
        raise llm.LLMError("E-3001", "LLM 출력에 records 배열 없음")
    return {
        "records": [r for r in records if isinstance(r, dict)],
        "mapping": parsed.get("mapping") if isinstance(parsed.get("mapping"), list) else [],
        "unmapped": parsed.get("unmapped") if isinstance(parsed.get("unmapped"), list) else [],
        "warnings": [str(w) for w in parsed.get("warnings", []) if w] if isinstance(parsed.get("warnings"), list) else [],
    }


def run_convert_job(job_id):
    job = load_job(job_id)
    if job is None:
        return
    if job.get("cancel_requested"):
        safe_update(job_id, state="cancelled", finished_at=now_iso())
        return
    step = None
    try:
        update_job(job_id, state="running", started_at=now_iso(), started_at_ms=int(time.time() * 1000))
        step = "compose"
        set_step(job_id, "compose", "running")
        cfg = llm.load_config()
        if job.get("model"):
            cfg = dict(cfg, model=job["model"])
        system = build_system_prompt(job["schema"])
        set_step(job_id, "compose", "done")
        update_job(job_id, request={"system_prompt": system, "system_prompt_chars": len(system),
                                    "user_chars": len(job["input_text"])})

        step = "llm"
        set_step(job_id, "llm", "running")
        req_meta = {}
        content, usage, latency_ms = llm.chat(
            system, job["input_text"], schema=ENVELOPE_SCHEMA, cfg=cfg, tag=job_id, meta_out=req_meta
        )
        set_step(job_id, "llm", "done", duration_ms=latency_ms)
        req_meta.pop("response_envelope", None)  # 잡 문서에는 raw_content로 이미 저장됨
        req_meta.pop("response_bytes", None)
        with _LOCK:
            j = load_job(job_id)
            if j is not None:
                j.setdefault("request", {}).update(req_meta)
                j["response"] = {"raw_content": content, "raw_chars": len(content), "usage": usage}
                save_job(j)

        step = "parse"
        set_step(job_id, "parse", "running")
        result = normalize_result(llm.parse_json_content(content))
        set_step(job_id, "parse", "done")
        update_job(
            job_id,
            state="done",
            finished_at=now_iso(),
            latency_ms=latency_ms,
            usage=usage,
            result=result,
        )
    except llm.LLMError as e:
        try:
            if step:
                set_step(job_id, step, "error")
        except Exception:
            pass
        cur = load_job(job_id)
        if cur is not None and cur.get("cancel_requested"):
            safe_update(job_id, state="cancelled", finished_at=now_iso())
        else:
            safe_update(job_id, state="error", finished_at=now_iso(),
                        error={"code": e.code, "message": e.message, "http": e.http})
    except Exception as e:  # 워커는 어떤 예외로도 조용히 죽지 않는다
        try:
            if step:
                set_step(job_id, step, "error")
        except Exception:
            pass
        safe_update(job_id, state="error", finished_at=now_iso(),
                    error={"code": "E-5000", "message": "%s: %s" % (type(e).__name__, e)})


def worker_loop():
    """단일 소비 워커 — 업스트림의 전역 직렬화와 1:1로 맞춘 로컬 실행 큐."""
    global _ACTIVE_JOB
    while True:
        job_id = _JOB_QUEUE.get()
        _ACTIVE_JOB = job_id
        try:
            run_convert_job(job_id)
        except Exception as e:
            print("[llm-data] [X] worker 예외: %s: %s" % (type(e).__name__, e))
            safe_update(job_id, state="error", finished_at=now_iso(),
                        error={"code": "E-5000", "message": "worker 예외: %s" % e})
        finally:
            _ACTIVE_JOB = None
            _JOB_QUEUE.task_done()


EXAMPLES = [
    ("esd-excel", "ESD 한계평가 · Excel 복사", "input_esd_excel.txt", "esd_schema.json", "fill"),
    ("esd-missing", "ESD 빈 값 데이터 · Excel 복사", "input_esd_missing.txt", "esd_schema.json", "missing"),
    ("esd-batch1", "ESD 1차 평가분 · Excel 복사", "input_esd_excel.txt", "esd_schema.json", "dataset"),
    ("esd-batch2", "ESD 추가 평가분 · Excel 복사", "input_esd_batch2.txt", "esd_schema.json", "dataset"),
]

JOB_MODES = ("fill", "missing", "dataset")


def load_examples():
    out = []
    for eid, label, fname, schema_name, mode in EXAMPLES:
        try:
            with open(os.path.join(ROOT, "examples", fname), encoding="utf-8-sig") as f:
                text = f.read()
            with open(os.path.join(ROOT, "examples", schema_name), encoding="utf-8-sig") as f:
                schema = json.load(f)
        except OSError:
            continue
        out.append({"id": eid, "label": label, "text": text, "schema": schema, "mode": mode})
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "llm-data/0.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload, ctype="application/json; charset=utf-8", cache=False):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # vendor 라이브러리는 캐시 허용 — sheet.html iframe이 잡 전환마다 재생성되므로
        # no-store면 매번 6MB를 다시 받는다
        self.send_header("Cache-Control", "public, max-age=86400" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, obj)

    def _error(self, code, message, ecode):
        self._json({"error": message, "code": ecode}, code)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    # ---- GET ----

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        # _global 프록시 stripPrefix 없이 접근하는 경우 방어적으로 prefix 제거
        if path.startswith("/apps/llm-data"):
            path = path[len("/apps/llm-data"):] or "/"
        try:
            if path in ("/", "/index.html"):
                return self._static("index.html")
            name = path.lstrip("/")
            if name in STATIC_FILES:
                return self._static(name)
            if path.startswith("/vendor/"):
                return self._vendor(path)
            if path == "/api/health":
                running = sum(1 for j in list_jobs(10) if j.get("state") in ("queued", "running"))
                return self._json({"app": "llm-data", "ok": True, "llm": llm.status(), "jobs_active": running})
            if path == "/api/llm/health":
                return self._json(llm.upstream_health())
            if path == "/api/llm/models":
                return self._json(llm.upstream_services())
            if path == "/api/schema":
                return self._json(default_schema())
            if path == "/api/config":
                return self._json({"config": llm.load_config(), "config_path": llm.CONFIG_PATH,
                                   "status": llm.status()})
            if path == "/api/storage":
                # 저장 영역 안내 — 배포 시 persistent volume 대상과 유실 허용 대상을 구분
                return self._json({"areas": [
                    {"key": "logic",
                     "label": "LOGIC — 코드·기본본 (이미지 포함, 재기동 시 유실 무관)",
                     "root": ROOT, "env": None, "env_active": False,
                     "entries": [
                         {"name": "서버 코드", "path": os.path.join(ROOT, "server.py") + " · llm.py · web/"},
                         {"name": "변환 프롬프트 기본본", "path": PROMPT_DEFAULT_PATH},
                         {"name": "LLM 설정 기본본", "path": llm.CONFIG_DEFAULT_PATH},
                         {"name": "예시 스키마", "path": DEFAULT_SCHEMA_PATH}]},
                    {"key": "persist",
                     "label": "PERSIST — persistent volume 필수 (재기동에도 반드시 유지)",
                     "root": DATA_DIR, "env": "LLM_DATA_PERSIST", "env_active": bool(PERSIST_ENV),
                     "entries": [
                         {"name": "데이터셋 (현재본)", "path": DATASET_PATH},
                         {"name": "데이터셋 저장본 (Save As 스냅샷)", "path": EXPORTS_DIR},
                         {"name": "데이터셋 편집 로그", "path": DATASET_LOG_PATH},
                         {"name": "대화", "path": CHATS_DIR},
                         {"name": "프로젝트 (대화 묶음)", "path": PROJECTS_PATH},
                         {"name": "마스터 스키마", "path": MASTERS_DIR},
                         {"name": "변환 프롬프트 (사용자 저장본)", "path": PROMPT_PATH},
                         {"name": "LLM 설정 (token 포함 가능)", "path": llm.CONFIG_PATH,
                          "note": ("LLM_DATA_CONFIG 지정됨" if os.environ.get("LLM_DATA_CONFIG")
                                   else ("PERSIST 영역" if PERSIST_ENV
                                         else "env 미설정 — 코드 영역 config/ (git 추적 제외)"))}]},
                    {"key": "runtime",
                     "label": "RUNTIME — 유실 허용 (재기동 시 사라져도 되는 작업 이력)",
                     "root": JOBS_DIR, "env": "LLM_DATA_RUNTIME", "env_active": bool(RUNTIME_ENV),
                     "entries": [
                         {"name": "변환 작업 이력·중간 산출물", "path": JOBS_DIR}]},
                ], "warning": (None if (PERSIST_ENV and RUNTIME_ENV) else
                               "운영·CI/CD 환경에서는 LLM_DATA_PERSIST와 LLM_DATA_RUNTIME을 반드시 지정하세요. "
                               "미지정 시 데이터가 코드 디렉터리 아래(<repo>/data)에 쌓여, 릴리스 디렉터리 교체나 "
                               "read-only 배포에서 유실·저장 실패로 이어집니다.")})
            if path == "/api/prompt":
                return self._send(200, load_prompt_template().encode("utf-8"), "text/plain; charset=utf-8")
            if path == "/api/examples":
                return self._json({"examples": load_examples()})
            if path == "/api/whoami":
                # 로그인 id. SSO 조회는 sso.py가 전담하며 실패해도 guest로만 떨어진다.
                # 프록시가 헤더로 직접 넣어 주는 환경(X-SSO-User)이 우선이다.
                uid = (self.headers.get("X-SSO-User") or "").strip()
                if uid:
                    return self._json({"id": uid, "source": "header", "service": "up"})
                try:
                    return self._json(sso.whoami(self.headers))
                except Exception as e:  # sso 모듈 문제로 화면이 막히지 않게 한다
                    return self._json({"id": "guest", "source": "none", "service": "down",
                                       "error": "%s: %s" % (type(e).__name__, e)})
            if path == "/api/sso/config":
                # 1단계(로컬 에이전트 웹소켓)를 브라우저가 수행하는 데 필요한 정보만 — 자격 정보는 없다
                try:
                    return self._json(sso.public_config())
                except Exception as e:
                    return self._json({"configured": False, "error": "%s: %s" % (type(e).__name__, e)})
            if path == "/api/sso/health":
                try:
                    return self._json(sso.health())
                except Exception as e:
                    return self._json({"service": "down", "error": "%s: %s" % (type(e).__name__, e)})
            if path == "/api/chats":
                chats = list_chats()
                pend = dict(_CHAT_PENDING)
                known = set()
                for c in chats:
                    known.add(c["id"])
                    if c["id"] in pend:
                        c["pending"] = True
                for pcid, p in pend.items():
                    if pcid not in known:
                        # 첫 전송이 진행 중인 새 대화 — 저장 전이라 목록에 합성 항목으로 노출
                        chats.insert(0, {"id": pcid,
                                         "title": p.get("title") or " ".join(str(p.get("message", "")).split())[:40],
                                         "updated_at": p.get("ts"), "count": 0, "cum_tokens": 0,
                                         "ctx_tokens": 0, "model": p.get("model"), "pending": True})
                return self._json({"chats": chats, "projects": load_projects()})
            if path == "/api/chat":
                q = parse_qs(u.query)
                cid = (q.get("id") or [""])[0]
                if not CHAT_ID_RE.fullmatch(cid):
                    return self._error(400, "bad id", "E-1001")
                c = load_chat(cid)
                p = _CHAT_PENDING.get(cid)
                if c is None:
                    if p:
                        # 첫 전송이 진행 중인 새 대화 — 아직 저장 전이므로 합성 문서로 응답
                        return self._json({"id": cid, "title": p.get("title") or "",
                                           "messages": [], "pending": p})
                    return self._error(404, "chat not found", "E-1002")
                if p:
                    c = dict(c, pending=p)
                return self._json(c)
            if path == "/api/masters":
                out = []
                try:
                    names = sorted(os.listdir(MASTERS_DIR))
                except FileNotFoundError:
                    names = []
                for n in names:
                    if not n.endswith(".json"):
                        continue
                    try:
                        with open(os.path.join(MASTERS_DIR, n), encoding="utf-8") as f:
                            schema = json.load(f)
                    except (OSError, ValueError):
                        continue
                    flds = schema_fields(schema)
                    out.append({"name": n[:-5], "title": schema_title(schema), "fields": len(flds),
                                "groups": len((migrate_legacy_schema(schema) or {}).get("columns") or []),
                                "version": schema.get("version") or "",
                                "codes": sum(1 for p in flds if isinstance(p.get("enum"), list))})
                return self._json({"masters": out})
            if path == "/api/master":
                q = parse_qs(u.query)
                name = (q.get("name") or [""])[0]
                if not MASTER_NAME_RE.fullmatch(name):
                    return self._error(400, "잘못된 마스터 이름", "E-1001")
                try:
                    with open(master_path(name), encoding="utf-8") as f:
                        return self._json({"name": name, "schema": migrate_legacy_schema(json.load(f))})
                except (OSError, ValueError):
                    return self._error(404, "마스터 없음", "E-1002")
            if path == "/api/dataset/log":
                q = parse_qs(u.query)
                try:
                    limit = max(1, min(int((q.get("limit") or ["100"])[0]), 500))
                except ValueError:
                    limit = 100
                with _LOCK:
                    try:
                        with open(DATASET_LOG_PATH, encoding="utf-8") as f:
                            lines = f.readlines()
                    except FileNotFoundError:
                        lines = []
                entries = []
                for ln in lines[-limit:]:
                    try:
                        entries.append(json.loads(ln))
                    except ValueError:
                        continue
                entries.reverse()
                return self._json({"logs": entries})
            if path == "/api/dataset/files":
                try:
                    names = sorted(
                        [n for n in os.listdir(EXPORTS_DIR)
                         if re.fullmatch(r"dataset_\d{8}_\d{6}_[A-Za-z0-9_-]+\.json", n)],
                        reverse=True)
                except FileNotFoundError:
                    names = []
                return self._json({"files": ["dataset.json"] + names})
            if path == "/api/dataset":
                ds = load_dataset()
                return self._json({"schema": ds["schema"], "rows": ds["rows"],
                                   "inserted_jobs": ds["inserted_jobs"], "last_insert": ds["last_insert"],
                                   "updated_at": ds["updated_at"], "count": len(ds["rows"]),
                                   "file": ds["file"]})
            if path == "/api/models":
                cfg = llm.load_config()
                return self._json({"models": list(llm.allowed_models(cfg)), "default": llm.current_model(cfg),
                                   "options": llm.model_options(cfg)})
            if path == "/api/jobs":
                q = parse_qs(u.query)
                try:
                    limit = max(1, min(int((q.get("limit") or ["30"])[0]), 100))
                except ValueError:
                    limit = 30
                return self._json({"jobs": list_jobs(limit)})
            if path == "/api/job":
                q = parse_qs(u.query)
                jid = (q.get("id") or [""])[0]
                if not JOB_ID_RE.fullmatch(jid):
                    return self._error(400, "bad id", "E-1001")
                job = load_job(jid)
                if job is None:
                    return self._error(404, "job not found", "E-1002")
                return self._json(job)
            return self._error(404, "not found", "E-1002")
        except Exception as e:
            return self._error(500, "%s: %s" % (type(e).__name__, e), "E-5001")

    def _static(self, name):
        ctype = STATIC_FILES.get(name)
        if ctype is None:
            return self._error(404, "not found", "E-1002")
        try:
            with open(os.path.join(WEB, name), "rb") as f:
                return self._send(200, f.read(), ctype)
        except OSError:
            return self._error(404, "not found", "E-1002")

    def _vendor(self, path):
        """web/vendor/ 아래 자체 호스팅 라이브러리 서빙 (경로 탈출 방지)."""
        ext = os.path.splitext(path)[1].lower()
        ctype = VENDOR_TYPES.get(ext)
        if ctype is None:
            return self._error(404, "not found", "E-1002")
        full = os.path.abspath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(os.path.abspath(os.path.join(WEB, "vendor")) + os.sep):
            return self._error(400, "bad path", "E-1001")
        try:
            with open(full, "rb") as f:
                return self._send(200, f.read(), ctype, cache=True)
        except OSError:
            return self._error(404, "not found", "E-1002")

    def do_HEAD(self):
        self.do_GET()

    # ---- DELETE ----

    def do_DELETE(self):
        u = urlparse(self.path)
        path = u.path
        if path.startswith("/apps/llm-data"):
            path = path[len("/apps/llm-data"):] or "/"
        try:
            if path == "/api/job":
                q = parse_qs(u.query)
                jid = (q.get("id") or [""])[0]
                if not JOB_ID_RE.fullmatch(jid):
                    return self._error(400, "bad id", "E-1001")
                with _LOCK:
                    job = load_job(jid)
                    if job is None:
                        return self._error(404, "job not found", "E-1002")
                    if job.get("state") not in ("done", "error", "cancelled"):
                        return self._error(409, "진행 중인 작업은 삭제할 수 없음", "E-1009")
                    os.remove(job_path(jid))
                return self._json({"deleted": True, "id": jid})
            return self._error(404, "not found", "E-1002")
        except Exception as e:
            return self._error(500, "%s: %s" % (type(e).__name__, e), "E-5000")

    # ---- POST ----

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path
        if path.startswith("/apps/llm-data"):
            path = path[len("/apps/llm-data"):] or "/"
        try:
            if path == "/api/sso/verify":
                # 1단계에서 브라우저가 받은 토큰으로 2단계(verify_sso) 확인.
                # 실패해도 guest를 돌려줄 뿐 다른 기능에 영향이 없다.
                body = self._body() or {}
                vals = body.get("values")
                if not isinstance(vals, dict):
                    vals = {"token": body.get("token")} if body.get("token") else {}
                try:
                    return self._json(sso.whoami(self.headers, vals))
                except Exception as e:
                    return self._json({"id": "guest", "source": "none", "service": "down",
                                       "error": "%s: %s" % (type(e).__name__, e)})
            if path == "/api/jobs":
                return self._create_job()
            if path == "/api/cancel":
                body = self._body() or {}
                jid = body.get("id") or ""
                if not JOB_ID_RE.fullmatch(jid):
                    return self._error(400, "취소할 작업 id 필요", "E-1001")
                with _LOCK:
                    job = load_job(jid)
                    if job is None:
                        return self._error(404, "job not found", "E-1002")
                    if job.get("state") in ("done", "error", "cancelled"):
                        return self._json({"requested": False, "state": job["state"]})
                    job["cancel_requested"] = True
                    save_job(job)
                upstream = llm.cancel() if _ACTIVE_JOB == jid else {"cancelled": False}
                return self._json({"requested": True, "active": _ACTIVE_JOB == jid, "upstream": upstream})
            if path == "/api/dataset/insert":
                body = self._body() or {}
                jid = body.get("job_id") or ""
                if not JOB_ID_RE.fullmatch(jid):
                    return self._error(400, "job_id 필요", "E-1001")
                with _LOCK:
                    job = load_job(jid)
                    if job is None:
                        return self._error(404, "job not found", "E-1002")
                    records = ((job.get("result") or {}).get("records")) or []
                    if job.get("state") != "done" or not records:
                        return self._error(409, "완료된 결과(records)가 있는 작업만 추가 가능", "E-1010")
                    ds = load_dataset()
                    if jid in ds["inserted_jobs"]:
                        return self._json({"inserted": 0, "already": True, "total": len(ds["rows"])})
                    job_keys = set(schema_field_ids(job.get("schema")))
                    if ds["schema"] is None:
                        ds["schema"] = normalize_schema(job.get("schema"))
                    else:
                        ds_keys = set(schema_field_ids(ds["schema"]))
                        if job_keys != ds_keys:
                            return self._error(409, "데이터셋 스키마와 필드 구성이 다름", "E-1011")
                    ts = now_iso()
                    uid = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("user") or "")) or "guest"
                    for r in records:
                        row = dict(r)
                        row["id"] = str(ds["next_id"])     # 내부 식별자 (CRUD용, 표시 안 함) — string
                        ds["next_id"] += 1
                        row["user_id"] = uid               # tested_at 우측 표시 열들
                        row["created_at"] = ts
                        row["updated_at"] = ts
                        row["_job"] = jid
                        ds["rows"].append(row)
                    ds["inserted_jobs"].append(jid)
                    ds["last_insert"] = {"job_id": jid, "count": len(records), "at": now_iso()}
                    ds["updated_at"] = now_iso()
                    save_dataset(ds)
                    append_ds_log("insert", uid, ds["file"], {"job_id": jid, "count": len(records)})
                    return self._json({"inserted": len(records), "total": len(ds["rows"])})
            if path == "/api/dataset/save":
                # Save: 현재 파일에 덮어쓰기 (기본 dataset.json = 라이브 저장소 커밋,
                # Save As 이후에는 그 스냅샷 파일을 같은 이름으로 갱신)
                body = self._body() or {}
                uid = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("user") or "")) or "guest"
                with _LOCK:
                    ds = load_dataset()
                    if not ds["rows"]:
                        return self._error(409, "저장할 행이 없음", "E-1012")
                    ds["updated_at"] = now_iso()
                    save_dataset(ds)
                    if ds["file"] != "dataset.json":
                        write_snapshot(ds, ds["file"], uid)
                append_ds_log("save", uid, ds["file"], {"count": len(ds["rows"])})
                return self._json({"saved": True, "file": ds["file"], "count": len(ds["rows"]),
                                   "saved_as_new": False})
            if path == "/api/dataset/saveas":
                # Save As: dataset_yyyymmdd_hhmmss_{id}.json 새 이름으로 저장하고 현재 파일로 지정
                body = self._body() or {}
                uid = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("user") or "")) or "guest"
                with _LOCK:
                    ds = load_dataset()
                    if not ds["rows"]:
                        return self._error(409, "저장할 행이 없음", "E-1012")
                    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                    fname = "dataset_%s_%s.json" % (ts, uid)
                    write_snapshot(ds, fname, uid)
                    ds["file"] = fname
                    ds["updated_at"] = now_iso()
                    save_dataset(ds)
                append_ds_log("saveas", uid, fname, {"count": len(ds["rows"])})
                return self._json({"saved": True, "file": fname, "count": len(ds["rows"]),
                                   "saved_as_new": True})
            if path == "/api/dataset/load":
                # 드롭다운에서 선택한 파일을 현재 데이터셋으로 로드 (Save 대상도 그 파일이 됨)
                body = self._body() or {}
                name = str(body.get("file") or "")
                if name != "dataset.json" and not re.fullmatch(r"dataset_\d{8}_\d{6}_[A-Za-z0-9_-]+\.json", name):
                    return self._error(400, "잘못된 파일 이름", "E-1001")
                with _LOCK:
                    if name == "dataset.json":
                        ds = load_dataset()
                        ds["file"] = "dataset.json"
                        save_dataset(ds)
                    else:
                        try:
                            with open(os.path.join(EXPORTS_DIR, name), encoding="utf-8") as f:
                                snap = json.load(f)
                        except (OSError, ValueError):
                            return self._error(404, "파일을 읽을 수 없음", "E-1002")
                        rows = snap.get("rows") or []
                        # meta 열 도입 전에 저장된 스냅샷은 id/created_at/updated_at 백필
                        ids = [r.get("id") for r in rows if isinstance(r.get("id"), int)]
                        nid = (max(ids) + 1) if ids else 1
                        stamp = snap.get("saved_at") or now_iso()
                        for r in rows:
                            if not isinstance(r.get("id"), int):
                                r["id"] = nid
                                nid += 1
                            r.setdefault("user_id", snap.get("user") or "guest")
                            r.setdefault("created_at", stamp)
                            r.setdefault("updated_at", stamp)
                        ds = {"schema": migrate_legacy_schema(snap.get("schema")), "rows": rows,
                              "inserted_jobs": sorted({r.get("_job") for r in rows if r.get("_job")}),
                              "last_insert": None, "updated_at": now_iso(),
                              "file": name, "next_id": nid}
                        save_dataset(ds)
                append_ds_log("load", clean_uid(body.get("user")), ds["file"], {"count": len(ds["rows"])})
                return self._json({"loaded": True, "file": ds["file"], "count": len(ds["rows"])})
            if path == "/api/dataset/row/create":
                body = self._body() or {}
                values = body.get("values")
                if not isinstance(values, dict):
                    return self._error(400, "values 객체 필요", "E-1000")
                with _LOCK:
                    ds = load_dataset()
                    if not isinstance(ds.get("schema"), dict):
                        return self._error(409, "스키마가 없는 빈 데이터셋 — 먼저 insert 또는 파일 로드 필요", "E-1013")
                    errs = validate_row_values(ds["schema"], values)
                    if errs:
                        return self._error(400, " / ".join(errs[:5]), "E-1017")
                    ts = now_iso()
                    row = {k: values.get(k) for k in schema_field_ids(ds["schema"])}
                    for k, v in values.items():
                        if k not in row and k not in ("id", "user_id", "created_at", "updated_at", "_job"):
                            row[k] = v
                    row["id"] = str(ds["next_id"])
                    ds["next_id"] += 1
                    row["user_id"] = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("user") or "")) or "guest"
                    row["created_at"] = ts
                    row["updated_at"] = ts
                    row["_job"] = None  # 수동 추가 행
                    ds["rows"].append(row)
                    ds["updated_at"] = ts
                    save_dataset(ds)
                    append_ds_log("row_create", row["user_id"], ds["file"],
                                  {"id": row["id"], "values": {k: v for k, v in row.items() if k != "_job"}})
                    return self._json({"created": True, "id": row["id"], "total": len(ds["rows"])})
            if path == "/api/dataset/row/update":
                body = self._body() or {}
                rid = body.get("id")
                rid = str(rid) if rid not in (None, "") else None
                values = body.get("values")
                if rid is None or not isinstance(values, dict):
                    return self._error(400, "id와 values 객체 필요", "E-1000")
                with _LOCK:
                    ds = load_dataset()
                    row = next((r for r in ds["rows"] if str(r.get("id")) == rid), None)
                    if row is None:
                        return self._error(404, "해당 id의 행 없음", "E-1002")
                    errs = validate_row_values(ds.get("schema"), {k: v for k, v in values.items()
                                                                 if k not in ("id", "user_id", "created_at", "updated_at", "_job")})
                    if errs:
                        return self._error(400, " / ".join(errs[:5]), "E-1017")
                    # user_id·id·created_at은 편집 불가, updated_at은 서버가 스탬프
                    changes = {}
                    for k, v in values.items():
                        if k not in ("id", "user_id", "created_at", "updated_at", "_job"):
                            if row.get(k) != v:
                                changes[k] = {"from": row.get(k), "to": v}
                            row[k] = v
                    row["updated_at"] = now_iso()
                    ds["updated_at"] = row["updated_at"]
                    save_dataset(ds)
                    append_ds_log("row_update", clean_uid(body.get("user")), ds["file"],
                                  {"id": rid, "changes": changes})
                    return self._json({"updated": True, "id": rid, "changed": len(changes)})
            if path == "/api/dataset/row/delete":
                body = self._body() or {}
                rid = body.get("id")
                rid = str(rid) if rid not in (None, "") else None
                if rid is None:
                    return self._error(400, "id 필요", "E-1000")
                with _LOCK:
                    ds = load_dataset()
                    removed = next((r for r in ds["rows"] if str(r.get("id")) == rid), None)
                    if removed is None:
                        return self._error(404, "해당 id의 행 없음", "E-1002")
                    ds["rows"] = [r for r in ds["rows"] if str(r.get("id")) != rid]
                    ds["updated_at"] = now_iso()
                    save_dataset(ds)
                    append_ds_log("row_delete", clean_uid(body.get("user")), ds["file"],
                                  {"id": rid, "row": {k: v for k, v in removed.items() if k != "_job"}})
                    return self._json({"deleted": True, "id": rid, "total": len(ds["rows"])})
            if path == "/api/chat/send":
                # 다중 턴 대화: 이력 전체를 매 턴 LLM에 보내 컨텍스트를 유지한다.
                # blocking — 클라이언트는 긴 타임아웃으로 대기 (llm-api 전역 직렬 큐 뒤에 설 수 있음)
                body = self._body() or {}
                msg = body.get("message")
                if not isinstance(msg, str) or not msg.strip():
                    return self._error(400, "message가 비어 있음", "E-1003")
                if len(msg) > MAX_INPUT_CHARS:
                    return self._error(413, "메시지가 %d자 초과" % MAX_INPUT_CHARS, "E-1004")
                cid = body.get("id")
                if cid and not CHAT_ID_RE.fullmatch(str(cid)):
                    return self._error(400, "bad id", "E-1001")
                # chat 단위 락: LLM 응답을 기다리는 동안 같은 chat의 분기 전환·수정이 끼어들어
                # 이 핸들러의 마지막 저장에 통째로 덮어써지는(lost update) 것을 막는다.
                with chat_lock(str(cid) if cid else "-new-"):
                    if cid:
                        chat = load_chat(cid)
                        if chat is None:
                            return self._error(404, "chat not found", "E-1002")
                    else:
                        chat = {"id": "CHAT-%s-%s" % (datetime.now().strftime("%Y%m%d-%H%M%S"),
                                                      secrets.token_hex(4).upper()),
                                "title": " ".join(msg.strip().split())[:40],
                                "created_at": now_iso(), "messages": []}
                    system = body.get("system")
                    if isinstance(system, str):
                        chat["system"] = system.strip()
                    history = list(chat.get("messages") or [])
                    history.append({"role": "user", "content": msg, "ts": now_iso()})
                    llm_messages = ([{"role": "system", "content": chat["system"]}]
                                    if chat.get("system") else []) + history
                    cfg, opt_err = chat_cfg_with_options(body, llm.load_config())
                    if opt_err:
                        return self._error(400, opt_err, "E-1006")
                    req_meta = {}
                    # 새로고침 복원용 in-flight 표시 — 저장 완료(또는 실패)까지 유지
                    _CHAT_PENDING[chat["id"]] = {"message": msg, "ts": now_iso(),
                                                 "model": llm.current_model(cfg),
                                                 "title": chat.get("title") or "",
                                                 "token": str(body.get("client_token") or "")}
                    try:
                        try:
                            content, usage, latency_ms = llm.chat_messages(
                                llm_messages, cfg=cfg, tag=chat["id"], meta_out=req_meta)
                        except llm.LLMError as e:
                            # 사용자가 정지한 경우엔 오류가 아니라 취소로 응답한다
                            if (_CHAT_PENDING.get(chat["id"]) or {}).get("cancelled"):
                                return self._error(409, "사용자가 전송을 정지했습니다", "E-1022")
                            # 실패 시 user 메시지는 저장하지 않는다 (재전송 가능하게)
                            return self._error(e.http, e.message, e.code)
                        if (_CHAT_PENDING.get(chat["id"]) or {}).get("cancelled"):
                            # 응답이 도착했어도 정지 요청이 있었으면 저장하지 않는다
                            return self._error(409, "사용자가 전송을 정지했습니다", "E-1022")
                        req_meta["ts"] = now_iso()
                        chat["last_response"] = {"envelope": req_meta.pop("response_envelope", None),
                                                 "bytes": req_meta.pop("response_bytes", 0),
                                                 "latency_ms": latency_ms, "ts": req_meta["ts"]}
                        chat["last_request"] = req_meta  # 실제 전송된 요청 전문 (headers는 마스킹)
                        history.append({"role": "assistant", "content": content, "ts": now_iso(),
                                        "model": llm.current_model(cfg), "latency_ms": latency_ms,
                                        "usage": usage or {}})
                        chat["messages"] = history
                        chat["model"] = llm.current_model(cfg)
                        chat["updated_at"] = now_iso()
                        save_chat(chat)
                    finally:
                        _CHAT_PENDING.pop(chat["id"], None)
                return self._json({"id": chat["id"], "title": chat["title"], "reply": content,
                                   "latency_ms": latency_ms, "count": len(history)})
            if path == "/api/chat/edit":
                # 과거 user 메시지 수정 → 그 지점부터 분기 생성 (기존 이후 대화는 variant로 보존)
                body = self._body() or {}
                msg = body.get("message")
                idx = body.get("index")
                cid = str(body.get("id") or "")
                if not isinstance(msg, str) or not msg.strip():
                    return self._error(400, "message가 비어 있음", "E-1003")
                if not CHAT_ID_RE.fullmatch(cid):
                    return self._error(400, "bad id", "E-1001")
                with chat_lock(cid):
                    chat = load_chat(cid)
                    if chat is None:
                        return self._error(404, "chat not found", "E-1002")
                    msgs = chat.get("messages") or []
                    if not (isinstance(idx, int) and 0 <= idx < len(msgs) and msgs[idx].get("role") == "user"):
                        return self._error(400, "index가 user 메시지가 아님", "E-1019")
                    system = body.get("system")
                    if isinstance(system, str):
                        chat["system"] = system.strip()
                    new_user = {"role": "user", "content": msg, "ts": now_iso()}
                    llm_messages = ([{"role": "system", "content": chat["system"]}]
                                    if chat.get("system") else []) + msgs[:idx] + [new_user]
                    cfg, opt_err = chat_cfg_with_options(body, llm.load_config())
                    if opt_err:
                        return self._error(400, opt_err, "E-1006")
                    req_meta = {}
                    # 새로고침 복원용 in-flight 표시 (edit_index로 수정-재전송임을 구분)
                    _CHAT_PENDING[cid] = {"message": msg, "ts": now_iso(),
                                          "model": llm.current_model(cfg),
                                          "title": chat.get("title") or "", "edit_index": idx,
                                          "token": str(body.get("client_token") or "")}
                    try:
                        try:
                            content, usage, latency_ms = llm.chat_messages(
                                llm_messages, cfg=cfg, tag=cid, meta_out=req_meta)
                        except llm.LLMError as e:
                            if (_CHAT_PENDING.get(cid) or {}).get("cancelled"):
                                return self._error(409, "사용자가 전송을 정지했습니다", "E-1022")
                            return self._error(e.http, e.message, e.code)  # 실패 시 분기 생성 안 함
                        if (_CHAT_PENDING.get(cid) or {}).get("cancelled"):
                            return self._error(409, "사용자가 전송을 정지했습니다", "E-1022")
                        # 성공 후에만 분기 패킹: 현재 suffix(+하위 분기)를 variant로 보존
                        alts = chat.setdefault("alts", {})
                        key = str(idx)
                        packed = {"messages": msgs[idx:],
                                  "alts": {k: v for k, v in alts.items() if k.isdigit() and int(k) > idx}}
                        entry = alts.get(key)
                        if entry is None:
                            entry = {"variants": [packed], "active": 0}
                            alts[key] = entry
                        else:
                            entry["variants"][entry["active"]] = packed
                        for k in [k for k in list(alts.keys()) if k.isdigit() and int(k) > idx]:
                            del alts[k]
                        assistant = {"role": "assistant", "content": content, "ts": now_iso(),
                                     "model": llm.current_model(cfg), "latency_ms": latency_ms, "usage": usage or {}}
                        chat["messages"] = msgs[:idx] + [new_user, assistant]
                        entry["variants"].append({"messages": chat["messages"][idx:], "alts": {}})
                        entry["active"] = len(entry["variants"]) - 1
                        req_meta["ts"] = now_iso()
                        chat["last_response"] = {"envelope": req_meta.pop("response_envelope", None),
                                                 "bytes": req_meta.pop("response_bytes", 0),
                                                 "latency_ms": latency_ms, "ts": req_meta["ts"]}
                        chat["last_request"] = req_meta
                        chat["model"] = llm.current_model(cfg)
                        chat["updated_at"] = now_iso()
                        save_chat(chat)
                    finally:
                        _CHAT_PENDING.pop(cid, None)
                return self._json({"id": cid, "reply": content, "count": len(chat["messages"]),
                                   "branch": {"index": idx, "active": entry["active"],
                                              "total": len(entry["variants"])}})
            if path == "/api/chat/branch":
                # 분기 전환 (LLM 호출 없음). {index,to} 단일 또는 switches=[{index,to},...]로
                # 중첩 checkout의 다단계 전환을 한 요청·한 저장으로 원자 적용한다.
                body = self._body() or {}
                cid = str(body.get("id") or "")
                if not CHAT_ID_RE.fullmatch(cid):
                    return self._error(400, "bad id", "E-1001")
                switches = body.get("switches")
                if not isinstance(switches, list):
                    switches = [{"index": body.get("index"), "to": body.get("to")}]
                if not switches:
                    return self._error(400, "분기 정보가 없음", "E-1020")
                with chat_lock(cid):
                    chat = load_chat(cid)
                    if chat is None:
                        return self._error(404, "chat not found", "E-1002")
                    for s in switches:
                        err = apply_branch_switch(chat, (s or {}).get("index"), (s or {}).get("to"))
                        if err:
                            # 저장 전 실패 → 아무것도 적용되지 않음 (원자성)
                            return self._error(400, err, "E-1020")
                    chat["updated_at"] = now_iso()
                    save_chat(chat)
                return self._json({"id": cid, "count": len(chat["messages"])})
            if path == "/api/chat/cancel":
                # 전송 정지: in-flight 표시에 취소 플래그를 세우고 업스트림 생성을 중단시킨다.
                # 진행 중이던 send/edit 핸들러는 결과를 저장하지 않고 E-1022로 종결된다.
                body = self._body() or {}
                cid = str(body.get("id") or "")
                token = str(body.get("token") or "")
                p = _CHAT_PENDING.get(cid) if cid else None
                if p is None and token:
                    # 새 대화 첫 전송은 클라이언트가 chat id를 모른다 — 전송 토큰으로 찾는다
                    p = next((v for v in list(_CHAT_PENDING.values()) if v.get("token") == token), None)
                if not p:
                    return self._json({"cancelled": False, "reason": "진행 중인 전송이 없음"})
                p["cancelled"] = True
                upstream = llm.cancel()  # best-effort — 업스트림이 지원하면 즉시 생성 중단
                return self._json({"cancelled": True, "upstream": upstream})
            if path == "/api/chat/meta":
                # 대화 메타 수정: 이름(title)·상위 고정(pinned)·프로젝트 이동(project) — LLM 호출 없음
                body = self._body() or {}
                cid = str(body.get("id") or "")
                if not CHAT_ID_RE.fullmatch(cid):
                    return self._error(400, "bad id", "E-1001")
                with chat_lock(cid):
                    chat = load_chat(cid)
                    if chat is None:
                        return self._error(404, "chat not found", "E-1002")
                    if "title" in body:
                        t = " ".join(str(body.get("title") or "").split())
                        if not t:
                            return self._error(400, "title이 비어 있음", "E-1003")
                        chat["title"] = t[:60]
                    if "pinned" in body:
                        chat["pinned"] = bool(body.get("pinned"))
                    if "project" in body:
                        pid = str(body.get("project") or "")
                        if pid:
                            if pid not in load_projects():
                                return self._error(404, "project not found", "E-1002")
                            chat["project"] = pid
                        else:
                            chat.pop("project", None)  # 프로젝트에서 제거 → 최상위 목록
                    # 이름·고정·이동은 대화 활동이 아니므로 updated_at(최근 활동순 정렬 기준)을 건드리지 않는다
                    save_chat(chat)
                return self._json({"id": cid, "title": chat.get("title"),
                                   "pinned": bool(chat.get("pinned")),
                                   "project": chat.get("project")})
            if path == "/api/project/create":
                body = self._body() or {}
                name = " ".join(str(body.get("name") or "").split())
                if not name:
                    return self._error(400, "프로젝트 이름이 비어 있음", "E-1003")
                with _LOCK:
                    projects = load_projects()
                    pid = "PROJ-%s" % secrets.token_hex(4).upper()
                    projects[pid] = {"name": name[:60], "created_at": now_iso()}
                    save_projects(projects)
                return self._json({"id": pid, "name": projects[pid]["name"]})
            if path == "/api/project/delete":
                # 프로젝트만 삭제 — 소속 대화는 지우지 않고 최상위 목록으로 되돌린다
                body = self._body() or {}
                pid = str(body.get("id") or "")
                with _LOCK:
                    projects = load_projects()
                    if pid not in projects:
                        return self._error(404, "project not found", "E-1002")
                    del projects[pid]
                    save_projects(projects)
                moved = 0
                for meta in list_chats():
                    if meta.get("project") != pid:
                        continue
                    with chat_lock(meta["id"]):
                        chat = load_chat(meta["id"])
                        if chat and chat.get("project") == pid:
                            chat.pop("project", None)
                            save_chat(chat)
                            moved += 1
                return self._json({"deleted": True, "id": pid, "chats_moved": moved})
            if path == "/api/project/rename":
                body = self._body() or {}
                pid = str(body.get("id") or "")
                name = " ".join(str(body.get("name") or "").split())
                if not name:
                    return self._error(400, "프로젝트 이름이 비어 있음", "E-1003")
                with _LOCK:
                    projects = load_projects()
                    if pid not in projects:
                        return self._error(404, "project not found", "E-1002")
                    projects[pid]["name"] = name[:60]
                    save_projects(projects)
                return self._json({"id": pid, "name": name[:60]})
            if path == "/api/chat/update":
                # context 편집: 활성 경로 메시지(user·assistant)의 내용을 제자리에서 수정.
                # LLM 호출·분기 생성 없음 — 다음 질문부터 수정된 이력이 그대로 전송된다.
                body = self._body() or {}
                cid = str(body.get("id") or "")
                idx = body.get("index")
                content = body.get("content")
                if not CHAT_ID_RE.fullmatch(cid):
                    return self._error(400, "bad id", "E-1001")
                if not isinstance(content, str) or not content.strip():
                    return self._error(400, "content가 비어 있음", "E-1003")
                if len(content) > MAX_INPUT_CHARS:
                    return self._error(413, "내용이 %d자 초과" % MAX_INPUT_CHARS, "E-1004")
                with chat_lock(cid):
                    chat = load_chat(cid)
                    if chat is None:
                        return self._error(404, "chat not found", "E-1002")
                    msgs = chat.get("messages") or []
                    if not (isinstance(idx, int) and 0 <= idx < len(msgs)):
                        return self._error(400, "index 범위 밖", "E-1021")
                    msgs[idx]["content"] = content
                    msgs[idx]["edited_at"] = now_iso()
                    chat["updated_at"] = now_iso()
                    save_chat(chat)
                return self._json({"id": cid, "index": idx, "edited": True,
                                   "role": msgs[idx].get("role")})
            if path == "/api/master/save":
                body = self._body() or {}
                name = str(body.get("name") or "")
                schema = body.get("schema")
                if not MASTER_NAME_RE.fullmatch(name):
                    return self._error(400, "잘못된 마스터 이름", "E-1001")
                err = validate_master_schema(schema)
                if err:
                    return self._error(400, err, "E-1005")
                schema = normalize_schema(schema)  # 구형 입력도 v4로 저장
                with _LOCK:
                    atomic_write_json(master_path(name), schema)
                flds = schema_fields(schema)
                append_ds_log("master_save", clean_uid(body.get("user")), "master:" + name,
                              {"fields": len(flds),
                               "groups": [{"group": c.get("group"),
                                           "field_ids": [f.get("id") for f in c.get("fields") or []]}
                                          for c in schema.get("columns") or []],
                               "codes": {f["id"]: f.get("enum") for f in flds if isinstance(f.get("enum"), list)}})
                return self._json({"saved": True, "name": name})
            if path == "/api/master/create":
                body = self._body() or {}
                name = str(body.get("name") or "")
                if not MASTER_NAME_RE.fullmatch(name):
                    return self._error(400, "이름은 영문·숫자·-·_ 만 (1~40자)", "E-1001")
                if os.path.exists(master_path(name)):
                    return self._error(409, "이미 존재하는 마스터", "E-1014")
                schema = body.get("schema")
                if validate_master_schema(schema):
                    schema = {"schema_name": name, "description": "", "version": "1",
                              "columns": [{"group": "req info", "fields": [
                                  {"id": "field1", "label": "", "type": "string", "description": "",
                                   "description_detail": "", "mapping_logic_ip_eval_esd": "",
                                   "mapping_logic_chatbot": ""}]}]}
                schema = normalize_schema(schema)
                with _LOCK:
                    os.makedirs(MASTERS_DIR, exist_ok=True)
                    atomic_write_json(master_path(name), schema)
                append_ds_log("master_create", clean_uid(body.get("user")), "master:" + name, {})
                return self._json({"created": True, "name": name})
            if path == "/api/master/apply":
                # 저장된 마스터 스키마를 현재 데이터셋에 적용.
                # 추가 필드 = null 채움 / mapping(rename) = 데이터 이관 /
                # 제거 필드 = 데이터가 있으면 차단(행 id 나열), 빈 열만 제거.
                body = self._body() or {}
                name = str(body.get("name") or "")
                if not MASTER_NAME_RE.fullmatch(name):
                    return self._error(400, "잘못된 마스터 이름", "E-1001")
                try:
                    with open(master_path(name), encoding="utf-8") as f:
                        mschema = json.load(f)
                except (OSError, ValueError):
                    return self._error(404, "마스터 없음", "E-1002")
                if validate_master_schema(mschema):
                    return self._error(400, "마스터 스키마가 유효하지 않음", "E-1005")
                mapping = body.get("mapping") if isinstance(body.get("mapping"), dict) else {}
                mapping = {str(k): str(v) for k, v in mapping.items()}
                dry = bool(body.get("dry_run"))
                uid = clean_uid(body.get("user"))
                mschema = normalize_schema(mschema)
                with _LOCK:
                    ds = load_dataset()
                    m_keys = schema_field_ids(mschema)
                    ds_keys = schema_field_ids(ds.get("schema"))
                    added = [k for k in m_keys if k not in ds_keys]
                    removed = [k for k in ds_keys if k not in m_keys]
                    # mapping 검증: old는 removed, new는 added 여야 함
                    for old, new in mapping.items():
                        if old not in removed or new not in added:
                            return self._error(400, "이관 매핑이 diff와 맞지 않음: %s→%s" % (old, new), "E-1015")
                    removed_rest = [k for k in removed if k not in mapping]
                    def has_data(f):
                        return [str(r.get("id")) for r in ds["rows"] if r.get(f) not in (None, "")]
                    blocked = [{"field": f, "count": len(has_data(f)), "ids": has_data(f)}
                               for f in removed_rest if has_data(f)]
                    if dry:
                        return self._json({
                            "dry_run": True, "file": ds["file"],
                            "added": [k for k in added if k not in mapping.values()],
                            "removed_empty": [f for f in removed_rest if not has_data(f)],
                            "removed_blocked": blocked,
                            "rename_candidates": {"removed_with_data": [b["field"] for b in blocked],
                                                  "added": [k for k in added if k not in mapping.values()]},
                        })
                    if blocked:
                        return self._error(409, "데이터가 있는 열은 제거할 수 없음: " +
                                           ", ".join(b["field"] for b in blocked), "E-1016")
                    ts = now_iso()
                    for r in ds["rows"]:
                        for old, new in mapping.items():   # rename: 데이터 이관
                            if old in r:
                                r[new] = r.pop(old)
                        for f in removed_rest:             # 빈 열 제거
                            r.pop(f, None)
                        for f in added:                    # 새 필드 null 채움
                            if f not in mapping.values():
                                r.setdefault(f, None)
                    ds["schema"] = mschema
                    ds["updated_at"] = ts
                    save_dataset(ds)
                    # 적용 후 enum(코드) 불일치 값 리포트
                    mismatch = {}
                    for spec in schema_fields(mschema):
                        f = str(spec["id"])
                        if isinstance(spec.get("enum"), list):
                            bad = sorted({str(r.get(f)) for r in ds["rows"]
                                          if r.get(f) not in (None, "") and r.get(f) not in spec["enum"]})
                            if bad:
                                mismatch[f] = bad
                    append_ds_log("schema_apply", uid, ds["file"],
                                  {"master": name, "added": added, "removed": removed_rest,
                                   "renamed": mapping, "enum_mismatch": mismatch})
                    return self._json({"applied": True, "file": ds["file"],
                                       "added": [k for k in added if k not in mapping.values()],
                                       "removed": removed_rest, "renamed": mapping,
                                       "enum_mismatch": mismatch, "total": len(ds["rows"])})
            if path == "/api/master/delete":
                body = self._body() or {}
                name = str(body.get("name") or "")
                if not MASTER_NAME_RE.fullmatch(name):
                    return self._error(400, "잘못된 마스터 이름", "E-1001")
                try:
                    with open(master_path(name), encoding="utf-8") as f:
                        mschema = json.load(f)
                except (OSError, ValueError):
                    return self._error(404, "마스터 없음", "E-1002")
                # 연결된 데이터가 있으면 스키마(마스터) 삭제 불가 — 하드 가드
                with _LOCK:
                    ds = load_dataset()
                if ds["rows"] and isinstance(ds.get("schema"), dict):
                    ds_keys = set(schema_field_ids(ds["schema"]))
                    m_keys = set(schema_field_ids(mschema))
                    same_title = bool(schema_title(ds["schema"])) and schema_title(ds["schema"]) == schema_title(mschema)
                    if ds_keys == m_keys or same_title:
                        ids = [str(r.get("id")) for r in ds["rows"]]
                        preview = ", ".join(ids[:20]) + (" 외 %d건" % (len(ids) - 20) if len(ids) > 20 else "")
                        return self._error(409, "연결된 데이터가 있어 삭제 불가 — '%s' %d행 (id: %s)"
                                           % (ds["file"], len(ids), preview), "E-1018")
                try:
                    os.remove(master_path(name))
                except OSError:
                    return self._error(404, "마스터 없음", "E-1002")
                append_ds_log("master_delete", clean_uid(body.get("user")), "master:" + name, {})
                return self._json({"deleted": True, "name": name})
            if path == "/api/dataset/bulk":
                # Luckysheet 전체 편집 반영: 시트의 현재 상태를 정본으로 재구성
                # (id 일치 행은 update, id 없는 행은 create, 시트에서 사라진 행은 delete)
                body = self._body() or {}
                rows_in = body.get("rows")
                if not isinstance(rows_in, list):
                    return self._error(400, "rows 배열 필요", "E-1000")
                uid = clean_uid(body.get("user"))
                RESERVED = ("id", "user_id", "created_at", "updated_at", "_job")
                with _LOCK:
                    ds = load_dataset()
                    if not isinstance(ds.get("schema"), dict):
                        return self._error(409, "스키마가 없는 빈 데이터셋", "E-1013")
                    # 정합성 사전 검증 (전체 원자적 반영 — 오류가 하나라도 있으면 전체 거부)
                    all_errs = []
                    for idx, item in enumerate(rows_in):
                        if not isinstance(item, dict):
                            continue
                        vals = item.get("values") if isinstance(item.get("values"), dict) else {}
                        vals = {k: v for k, v in vals.items() if k not in RESERVED}
                        for e in validate_row_values(ds.get("schema"), vals):
                            all_errs.append("행 %s: %s" % (item.get("id") or ("신규#%d" % (idx + 1)), e))
                    if all_errs:
                        return self._error(400, " / ".join(all_errs[:8]) +
                                           (" (외 %d건)" % (len(all_errs) - 8) if len(all_errs) > 8 else ""), "E-1017")
                    ts = now_iso()
                    by_id = {str(r.get("id")): r for r in ds["rows"]}
                    seen = set()
                    updated, created, deleted = [], [], []
                    upd_changes = {}
                    new_rows = []
                    for item in rows_in:
                        if not isinstance(item, dict):
                            continue
                        rid = item.get("id")
                        rid = str(rid) if rid not in (None, "") else None
                        values = item.get("values") if isinstance(item.get("values"), dict) else {}
                        if rid is not None and rid in by_id and rid not in seen:
                            row = by_id[rid]
                            seen.add(rid)
                            changes = {}
                            for k, v in values.items():
                                if k in RESERVED:
                                    continue
                                if row.get(k) != v:
                                    changes[k] = {"from": row.get(k), "to": v}
                                row[k] = v
                            if changes:
                                row["updated_at"] = ts
                                updated.append(rid)
                                upd_changes[rid] = changes
                            new_rows.append(row)
                        else:
                            row = {k: values.get(k) for k in schema_field_ids(ds["schema"])}
                            for k, v in values.items():
                                if k not in row and k not in RESERVED:
                                    row[k] = v
                            row["id"] = ds["next_id"]
                            ds["next_id"] += 1
                            row["user_id"] = uid
                            row["created_at"] = ts
                            row["updated_at"] = ts
                            row["_job"] = None
                            created.append(row["id"])
                            new_rows.append(row)
                    for r in ds["rows"]:
                        if str(r.get("id")) not in seen:
                            deleted.append(r.get("id"))
                    ds["rows"] = new_rows
                    ds["last_insert"] = None
                    ds["updated_at"] = ts
                    save_dataset(ds)
                    if updated or created or deleted:
                        append_ds_log("sheet_apply", uid, ds["file"],
                                      {"updated": [{"id": i, "changes": upd_changes[i]} for i in updated],
                                       "created": created, "deleted": deleted})
                    return self._json({"updated": len(updated), "created": len(created),
                                       "deleted": len(deleted), "total": len(ds["rows"])})
            if path == "/api/dataset/clear":
                body = self._body() or {}
                save_dataset({"schema": None, "rows": [], "inserted_jobs": [],
                              "last_insert": None, "updated_at": now_iso(),
                              "file": "dataset.json", "next_id": 1})
                append_ds_log("clear", clean_uid(body.get("user")), "dataset.json", {})
                return self._json({"cleared": True})
            if path == "/api/config":
                body = self._body()
                if body is None:
                    return self._error(400, "본문이 JSON 객체가 아님", "E-1000")
                try:
                    saved = llm.save_config(body.get("config", body))
                except llm.LLMError as e:
                    return self._error(e.http, e.message, e.code)
                return self._json({"config": saved, "status": llm.status()})
            if path == "/api/prompt":
                body = self._body()
                if body is None or not isinstance(body.get("text"), str):
                    return self._error(400, "본문에 text(문자열) 필요", "E-1000")
                text = body["text"]
                if "{{TARGET_SCHEMA}}" not in text:
                    return self._error(400, "프롬프트에 {{TARGET_SCHEMA}} 자리표시자가 있어야 함", "E-1007")
                with _LOCK:
                    atomic_write_text(PROMPT_PATH, text)
                return self._json({"saved": True, "chars": len(text)})
            return self._error(404, "not found", "E-1002")
        except Exception as e:
            return self._error(500, "%s: %s" % (type(e).__name__, e), "E-5000")

    def _create_job(self):
        body = self._body()
        if body is None:
            return self._error(400, "본문이 JSON 객체가 아님", "E-1000")
        text = body.get("input_text")
        if not isinstance(text, str) or not text.strip():
            return self._error(400, "input_text가 비어 있음", "E-1003")
        if len(text) > MAX_INPUT_CHARS:
            return self._error(413, "입력이 %d자 초과" % MAX_INPUT_CHARS, "E-1004")

        schema = body.get("schema")
        if isinstance(schema, str) and schema.strip():
            try:
                schema = json.loads(schema)
            except Exception:
                return self._error(400, "schema가 올바른 JSON이 아님", "E-1005")
        if schema is None or schema == "":
            schema = default_schema()
        err = validate_master_schema(schema)
        if err:
            return self._error(400, err, "E-1005")
        schema = normalize_schema(schema)  # 구형 입력도 v4로 정규화해 잡에 저장

        model = body.get("model")
        if model is not None:
            if model not in llm.allowed_models():
                return self._error(400, "지원하지 않는 model", "E-1006")

        mode = body.get("mode") or "fill"
        if mode not in JOB_MODES:
            return self._error(400, "지원하지 않는 mode", "E-1008")

        preview = " ".join(text.strip().split())[:80]
        steps = seed_steps()
        now_ms = int(time.time() * 1000)
        steps[0].update(status="done", started_at_ms=now_ms, ended_at_ms=now_ms, duration_ms=0)
        job = {
            "id": make_job_id(),
            "created_at": now_iso(),
            "state": "queued",
            "mode": mode,
            "model": model or llm.load_config().get("model"),
            "input_text": text,
            "input_chars": len(text),
            "input_preview": preview,
            "schema": schema,
            "steps": steps,
            "request": None,
            "response": None,
            "result": None,
            "error": None,
        }
        save_job(job)
        try:
            _JOB_QUEUE.put(job["id"])
        except Exception as e:
            safe_update(job["id"], state="error", finished_at=now_iso(),
                        error={"code": "E-5000", "message": "작업 큐 등록 실패: %s" % e})
            return self._error(500, "작업 큐 등록 실패", "E-5000")
        return self._json({"job_id": job["id"], "state": "queued", "queue_position": _JOB_QUEUE.qsize()}, 202)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8821)
    args = ap.parse_args()
    os.makedirs(JOBS_DIR, exist_ok=True)
    seed_masters()
    migrate_masters()  # 구형 스키마 마스터를 v4로 1회 변환
    reap_running()
    threading.Thread(target=worker_loop, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("[llm-data] http://%s:%d (LLM: %s)" % (args.host, args.port, llm.status().get("url")))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
