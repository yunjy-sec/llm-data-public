"""OpenAI 호환 LLM API 게이트웨이 (stdlib only).

설정: config/llm.json (env LLM_DATA_CONFIG로 경로 재지정 가능)
- base_url: LLM API 루트 (기본 http://127.0.0.1:8820 = llm-api)
- model:    서비스 id (fable|opus|sonnet|haiku|gpt-5.6|...)
- url:      지정 시 base_url/model 조합 대신 이 주소를 그대로 사용
- headers:  요청에 그대로 합쳐지는 헤더. 토큰은 코드가 아니라 여기에 둔다.
            예: {"Authorization": "Bearer <token>"} 또는 {"X-Api-Key": "..."}
- api_key_env: 지정 시 해당 환경변수 값을 Authorization: Bearer로 주입
- timeout:  초 (기본 300 — llm-api 서비스 timeout과 동일)
- response_schema: true면 response_format(json_schema)로 구조화 출력 강제.
  기본 false — response_format을 지원하지 않는 LLM이 많아 시스템 프롬프트와
  lenient 파서만으로 동작하는 것이 기본이다. 지원이 확인된 LLM에서만 켠다.
"""

import json
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
# 설정 경로: LLM_DATA_CONFIG > LLM_DATA_PERSIST(volume)/config/llm.json > 이미지 기본본.
# 배포 시 token이 담기는 파일이므로 persistent volume에 두어야 재기동에도 유지된다.
_PERSIST = os.environ.get("LLM_DATA_PERSIST")
CONFIG_DEFAULT_PATH = os.path.join(ROOT, "config", "llm.json")
CONFIG_PATH = (os.environ.get("LLM_DATA_CONFIG")
               or (os.path.join(_PERSIST, "config", "llm.json") if _PERSIST else CONFIG_DEFAULT_PATH))

MAX_RESPONSE_BYTES = 4 * 1024 * 1024

# 오류 코드 → HTTP 상태 (issue-public pipeline._llm_http 규약)
HTTP_FOR = {
    "E-2001": 504,  # 전송 실패/타임아웃
    "E-2002": 502,  # 응답 형식 예상 밖
    "E-2004": 503,  # 설정 누락
    "E-2007": 401,  # 인증
    "E-3001": 422,  # 내용 파싱 실패
}


class LLMError(Exception):
    def __init__(self, code, message, http=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http = http or HTTP_FOR.get(code, 502)


def load_config():
    cfg = {}
    # 사용자 저장본(persist) 우선, 없으면 이미지의 기본본 — 첫 기동 bootstrap용
    for p in (CONFIG_PATH, CONFIG_DEFAULT_PATH):
        try:
            with open(p, encoding="utf-8") as f:
                cfg = json.load(f)
            break
        except FileNotFoundError:
            continue
    if not isinstance(cfg, dict):
        cfg = {}
    cfg.setdefault("base_url", "http://127.0.0.1:8820")
    cfg.setdefault("model", "sonnet")
    cfg.setdefault("timeout", 300)
    cfg.setdefault("response_schema", False)
    return cfg


# 프론트에서 편집을 허용하는 키 (그 외 키는 저장 시 버려진다)
EDITABLE_KEYS = ("base_url", "url", "model", "headers", "api_key_env", "timeout", "response_schema", "extra_payload")

# 이 환경에서는 사용하지 않지만 다른 환경 연동 시 쓰는 설정 — 값을 그대로 보존한다
# (빈 문자열도 유지; user_id/user_pw처럼 자리만 잡아두는 키가 있음)
PASSTHROUGH_KEYS = ("OPENAI_API_KEY", "credential_key", "send_system_name", "env_model",
                    "api_base_url", "user_id", "user_pw", "_비고",
                    "context_limit_tokens")  # 대화 탭 사용률 계산용 한계 토큰


def save_config(new_cfg):
    """설정 저장: 허용 키만, 타입 강제 후 원자적 기록. 저장된 설정을 반환."""
    if not isinstance(new_cfg, dict):
        raise LLMError("E-2004", "설정은 JSON 객체여야 함", http=400)
    out = {}
    for k in EDITABLE_KEYS:
        if k not in new_cfg or new_cfg[k] in (None, ""):
            continue
        v = new_cfg[k]
        if k in ("base_url", "url", "model", "api_key_env"):
            out[k] = str(v).strip()
        elif k == "timeout":
            try:
                out[k] = max(1, min(int(v), 600))
            except (TypeError, ValueError):
                raise LLMError("E-2004", "timeout은 정수(초)여야 함", http=400)
        elif k == "response_schema":
            out[k] = bool(v)
        elif k in ("headers", "extra_payload"):
            if not isinstance(v, dict):
                raise LLMError("E-2004", "%s는 객체여야 함" % k, http=400)
            if v:
                out[k] = {str(hk): (hv if k == "extra_payload" else str(hv)) for hk, hv in v.items()}
    for k in PASSTHROUGH_KEYS:
        if k in new_cfg and new_cfg[k] is not None:
            out[k] = str(new_cfg[k])
    if not out.get("base_url") and not out.get("url"):
        raise LLMError("E-2004", "base_url 또는 url 중 하나는 필요함", http=400)
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CONFIG_PATH)
    return load_config()


def chat_url(cfg):
    if cfg.get("url"):
        return cfg["url"]
    base = str(cfg.get("base_url", "")).rstrip("/")
    if not base:
        raise LLMError("E-2004", "llm.json에 base_url 또는 url 미설정")
    # llm-api는 모델별 독립 endpoint. 최상위 /v1/...는 response_format을 넘기지 않으므로
    # 구조화 출력을 위해 반드시 모델 경로를 쓴다.
    return "%s/%s/v1/chat/completions" % (base, cfg.get("model", "sonnet"))


def _headers(cfg):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    extra = cfg.get("headers")
    if isinstance(extra, dict):
        for k, v in extra.items():
            headers[str(k)] = str(v)
    key_env = cfg.get("api_key_env")
    if key_env:
        secret = os.environ.get(str(key_env))
        if not secret:
            raise LLMError("E-2007", "환경변수 %s에 API 토큰 없음" % key_env)
        headers["Authorization"] = "Bearer " + secret
    # 별도 토큰 미설정 시 OPENAI_API_KEY 값을 Bearer로 첨부 — 다른 환경(OpenAI 호환
    # 게이트웨이) 규약과 호환되고, keyless llm-api는 무시한다. 요청 전문에는 ****로 표시됨.
    if "Authorization" not in headers and cfg.get("OPENAI_API_KEY"):
        headers["Authorization"] = "Bearer " + str(cfg["OPENAI_API_KEY"])
    return headers


def _mask(value):
    """토큰류 헤더 값 마스킹 — 스킴만 남기고 값은 ****로 표기."""
    s = str(value)
    if s.lower().startswith("bearer "):
        return "Bearer ****"
    return "****"


def masked_headers(cfg):
    out = {}
    try:
        headers = _headers(cfg)
    except LLMError:
        headers = {"Content-Type": "application/json"}
    for k, v in headers.items():
        lk = k.lower()
        if lk in ("authorization", "cookie") or any(t in lk for t in ("token", "key", "secret", "auth")):
            out[k] = _mask(v)
        else:
            out[k] = v
    return out


def status():
    cfg = load_config()
    try:
        url = chat_url(cfg)
    except LLMError as e:
        url = "(미설정: %s)" % e.message
    return {
        "config_path": CONFIG_PATH,
        "url": url,
        "model": cfg.get("model"),
        "timeout": cfg.get("timeout"),
        "response_schema": bool(cfg.get("response_schema")),
        "headers": masked_headers(cfg),
        "credentials": "environment" if cfg.get("api_key_env") else ("config-headers" if cfg.get("headers") else "none"),
    }


def chat(system, user, schema=None, cfg=None, tag="CHAT", meta_out=None):
    """1회 blocking 호출 (system+user 2메시지). (content, usage, latency_ms) 반환."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return chat_messages(messages, schema=schema, cfg=cfg, tag=tag, meta_out=meta_out)


def chat_messages(messages, schema=None, cfg=None, tag="CHAT", meta_out=None):
    """임의 메시지 배열(다중 턴 대화 이력 포함)로 1회 blocking 호출.

    meta_out에 dict를 주면 실제 요청 정보(url, model, payload_bytes, response_format)를 채운다.
    """
    cfg = cfg or load_config()
    url = chat_url(cfg)
    payload = {
        "model": cfg.get("model", "sonnet"),
        "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
    }
    if schema is not None and cfg.get("response_schema"):
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "llm_data", "schema": schema},
        }
    extra = cfg.get("extra_payload")
    if isinstance(extra, dict):
        payload.update(extra)

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if isinstance(meta_out, dict):
        meta_out.update({
            "method": "POST",
            "url": url,
            "model": payload["model"],
            "payload_bytes": len(body),
            "response_format": "response_format" in payload,
            "timeout_s": max(1, min(int(cfg.get("timeout", 300)), 600)),
            "headers": masked_headers(cfg),  # 토큰류는 마스킹된 상태
            "payload": payload,              # 실제 전송 body 전문
        })
    timeout = max(1, min(int(cfg.get("timeout", 300)), 600))
    print("[LLM] -> %s POST %s | body %d bytes | response_format=%s | timeout=%ds"
          % (tag, url, len(body), "YES" if "response_format" in payload else "no", timeout))
    started = time.time()
    req = urllib.request.Request(url, data=body, headers=_headers(cfg), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as e:
        detail = ""
        err_type = ""
        try:
            eb = json.loads(e.read().decode("utf-8", "replace"))
            detail = str(eb.get("error", {}).get("message", ""))[:220]
            err_type = str(eb.get("error", {}).get("type", ""))
        except Exception:
            pass
        elapsed = time.time() - started
        print("[LLM] [X] %s 실패 | %.1fs | HTTP %s %s | %s" % (tag, elapsed, e.code, err_type, detail))
        if e.code == 401 or err_type == "auth_expired":
            raise LLMError("E-2007", "LLM 인증 만료/실패: %s" % (detail or e.code))
        http = e.code if 400 <= e.code <= 599 else 502
        raise LLMError("E-2001", "LLM HTTP %s (%s): %s" % (e.code, err_type or "?", detail), http=http)
    except Exception as e:
        elapsed = time.time() - started
        print("[LLM] [X] %s 실패 | %.1fs | %s | %s: %s" % (tag, elapsed, url, type(e).__name__, e))
        raise LLMError("E-2001", "LLM 전송 실패(%.0fs 경과, %s): %s" % (elapsed, type(e).__name__, e))

    latency_ms = int((time.time() - started) * 1000)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise LLMError("E-2002", "LLM 응답이 %dMB 초과" % (MAX_RESPONSE_BYTES // 1024 // 1024))
    try:
        resp = json.loads(raw.decode("utf-8"))
        content = resp["choices"][0]["message"]["content"]
    except Exception:
        raise LLMError("E-2002", "LLM 응답 형식 예상 밖: %s" % raw[:220])
    usage = resp.get("usage") or {}
    if isinstance(meta_out, dict):
        meta_out["response_envelope"] = resp   # 응답 전문 (chat.completion envelope)
        meta_out["response_bytes"] = len(raw)
    print("[LLM] <- %s HTTP 200 | %.2fs | %d bytes" % (tag, latency_ms / 1000.0, len(raw)))
    if not isinstance(content, str) or not content.strip():
        raise LLMError("E-2002", "LLM 응답 content 비어 있음")
    return content, usage, latency_ms


def parse_json_content(text):
    """코드펜스·잡문 방어적 JSON 객체 파싱 (issue-public lenient 파서 규약)."""
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith("```")]
    cleaned = "\n".join(lines).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        pass
    a, b = cleaned.find("{"), cleaned.rfind("}")
    if a != -1 and b > a:
        try:
            return json.loads(cleaned[a:b + 1])
        except Exception:
            pass
    raise LLMError("E-3001", "LLM 출력에서 JSON 객체를 파싱하지 못함: %s" % cleaned[:220])


def _api_root(cfg):
    """/cancel, /api/health용 API 루트. base_url 조합이면 base_url 그대로(prefix 보존),
    명시적 url이면 '/v1/chat/completions'와 모델 세그먼트를 벗긴다. 폴백은 scheme+netloc."""
    explicit = cfg.get("url")
    if not explicit:
        return str(cfg.get("base_url", "")).rstrip("/")
    u = str(explicit).rstrip("/")
    suffix = "/v1/chat/completions"
    if u.endswith(suffix):
        return u[:-len(suffix)]
    parts = urlsplit(u)
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def cancel(cfg=None):
    """실행 중 호출 취소 (llm-api POST /cancel). 실패해도 무시하는 best-effort."""
    cfg = cfg or load_config()
    try:
        url = _api_root(cfg) + "/cancel"
        req = urllib.request.Request(url, data=b"{}", headers=_headers(cfg), method="POST")
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return {"cancelled": False}


def upstream_services(cfg=None):
    """llm-api의 모델 서비스 상세 목록 — 대화 탭 모델 카드용.
    각 항목만으로 해당 LLM과 대화 가능한 정보(endpoint·timeout 등)를 담는다."""
    cfg = cfg or load_config()
    try:
        root = _api_root(cfg)
        req = urllib.request.Request(root + "/api/health", headers=_headers(cfg))
        with urllib.request.urlopen(req, timeout=5) as r:
            h = json.loads(r.read().decode("utf-8"))
        out = []
        for s in h.get("services") or []:
            c = s.get("config") or {}
            st = s.get("status") or {}
            out.append({
                "id": c.get("id"), "label": c.get("label"), "model": c.get("model"),
                "backend": c.get("backend"), "tier": c.get("tier"), "note": c.get("note"),
                "enabled": c.get("enabled"), "timeout": c.get("timeout"),
                "max_inflight": c.get("max_inflight"),
                "endpoint": "%s/%s/v1/chat/completions" % (root, c.get("id")),
                "health": s.get("health"), "ok": st.get("ok"), "err": st.get("err"),
                "ewma_latency_ms": st.get("ewma_latency_ms"),
                "last_error": (st.get("last_error") or "")[:120] or None,
            })
        return {"reachable": True, "auth": (h.get("auth") or {}).get("state"),
                "headers": masked_headers(cfg), "models": out}
    except Exception as e:
        return {"reachable": False, "error": "%s: %s" % (type(e).__name__, e), "models": []}


def upstream_health(cfg=None):
    """llm-api /api/health 요약 (프론트 상태 표시용). 실패 시 reachable:false."""
    cfg = cfg or load_config()
    try:
        url = _api_root(cfg) + "/api/health"
        req = urllib.request.Request(url, headers=_headers(cfg))
        with urllib.request.urlopen(req, timeout=3) as r:
            h = json.loads(r.read().decode("utf-8"))
        return {
            "reachable": True,
            "auth": (h.get("auth") or {}).get("state"),
            "executor": {
                "running": (h.get("executor") or {}).get("running"),
                "model": (h.get("executor") or {}).get("model"),
                "queued": (h.get("executor") or {}).get("queued"),
            },
        }
    except Exception as e:
        return {"reachable": False, "error": "%s: %s" % (type(e).__name__, e)}
