"""접근 제어 (stdlib only).

다른 곳에 그대로 떼어 쓸 수 있는 독립 모듈이다. 이 파일은 sso도 llm도 import하지 않는다.
"누구인지"는 밖에서 dict로 넘겨주고, 이 모듈은 "들여보낼지"만 판단한다.

  user = {"id": "...", "dept": "...", ...}   # 어디서 왔든 상관없다
  decide(user, token) -> {"allowed", "admin", "reason", "via"}

설정: config/access.json (env LLM_DATA_ACCESS_CONFIG로 경로 재지정 가능)

- allow.id     허용할 로그인 id 목록
- allow.dept   허용할 부서 목록 (부서 이름이 이 값을 포함하면 허용 — 부분 일치)
- admin.id     허가 목록을 편집할 수 있는 id 목록.
               SSO 로그인 id와 임시 접속 id 모두 여기 적을 수 있다.
               예: ["your.loginid", "temp"] -> 그 둘만 관리자, 다른 임시 id는 일반 사용자
- temp         임시 접속 자격 [{"id": "...", "pw": "...", "note": "..."}]
               SSO가 막혔을 때 이 id/pw로 들어올 수 있다. 토큰처럼 동작할 뿐이라
               화면의 사용자 표시는 SSO 결과 그대로 둔다.
- etc          설명·session_hours(임시 접속 유효시간, 기본 12) 등. 판단에 쓰지 않는다.

설정 파일이 없거나 allow가 비어 있으면 **아무도 막지 않는다**(fail-open).
접근 제어를 켜는 순간부터 목록에 있는 사람만 들어온다.

설정은 기동 시 한 번 읽고 그 뒤로는 파일이 바뀔 때만 다시 읽는다(수정시각·크기로 감지).
id/pw로 들어오는 요청은 무조건 파일을 다시 읽으므로, 자격을 추가하면 재기동 없이 바로 통한다.

임시 토큰은 서명(HMAC)만으로 검증한다. 서버를 재기동해도 유효하고 별도 저장이 필요 없다.
토큰은 쿠키(llm_access)로도 내려준다 — 페이지 이동에는 헤더를 붙일 수 없어서, 쿠키가 없으면
서버는 차단하고 화면은 통과로 판단해 무한 새로고침이 된다.
"""

import log as _log_mod
import base64
import hashlib
import hmac
import json
import os
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
_PERSIST = os.environ.get("LLM_DATA_PERSIST")
CONFIG_DEFAULT_PATH = os.path.join(ROOT, "config", "access.json")
_ENV_PATH = os.environ.get("LLM_DATA_ACCESS_CONFIG")
CONFIG_PATH = (_ENV_PATH
               or (os.path.join(_PERSIST, "config", "access.json") if _PERSIST else CONFIG_DEFAULT_PATH))
# 환경변수로 경로를 못박았으면 그 파일만 본다. 저장소 기본본으로 흘러가면
# "제어를 껐다고 생각한 곳에서 갑자기 켜지는" 사고가 난다.
_SEARCH_PATHS = (CONFIG_PATH,) if _ENV_PATH else (CONFIG_PATH, CONFIG_DEFAULT_PATH)

DEFAULT_SESSION_HOURS = 12
# 통행증을 담는 쿠키 이름. 헤더(X-Access-Token)만 쓰면 페이지 이동에는 실리지 않아
# 서버가 차단 -> 화면은 통과로 판단 -> 무한 새로고침이 된다.
COOKIE_NAME = "llm_access"
_LOCK = threading.Lock()          # 파일 쓰기 직렬화
_CFG_LOCK = threading.RLock()     # 설정 캐시 (쓰기 잠금과 분리 — _secret이 둘 다 잡는다)
_CFG = {"stamp": None, "cfg": {}}  # 파일이 바뀌면 stamp가 달라져 자동으로 다시 읽는다


def _log(msg):
    """오류만 남긴다. 정상 흐름은 조용히 지나간다. 앞에 yyyymmdd hhmmss 가 붙는다."""
    _log_mod.log("ACCESS", msg)


def load_config(force=False):
    """설정을 읽는다. 기동 시 한 번 읽어 두고, 파일이 바뀌면(수정시각·크기) 다시 읽는다.
    force=True면 무조건 다시 읽는다 — id/pw로 들어오는 요청은 방금 추가한 자격도 통해야 한다."""
    with _CFG_LOCK:
        for p in _SEARCH_PATHS:
            try:
                st = os.stat(p)
            except OSError:
                continue
            stamp = (p, st.st_mtime_ns, st.st_size)
            if not force and _CFG["stamp"] == stamp:
                return _CFG["cfg"]
            try:
                with open(p, encoding="utf-8") as f:
                    cfg = json.load(f)
            except OSError:
                continue
            except ValueError as e:
                _log("설정 파일 JSON 오류 %s: %s" % (p, e))
                return {}
            _CFG["stamp"], _CFG["cfg"] = stamp, cfg if isinstance(cfg, dict) else {}
            return _CFG["cfg"]
        _CFG["stamp"], _CFG["cfg"] = None, {}
        return {}


def _sec(cfg, name):
    v = cfg.get(name)
    return v if isinstance(v, dict) else {}


def _list(v):
    if isinstance(v, str):
        return [v.strip()] if v.strip() else []
    return [str(x).strip() for x in (v or []) if str(x).strip()]


def _etc(cfg, key, default=None):
    etc = cfg.get("etc")
    if isinstance(etc, dict) and key in etc:
        return etc[key]
    return cfg.get(key, default)


def enabled(cfg=None):
    """허용 목록이 하나라도 있으면 제어가 켜진 것이다."""
    cfg = load_config() if cfg is None else cfg
    allow = _sec(cfg, "allow")
    return bool(_list(allow.get("id")) or _list(allow.get("dept")))


def is_admin(user, cfg=None):
    """SSO 로그인 id가 admin.id 목록에 있는지."""
    cfg = load_config() if cfg is None else cfg
    uid = str((user or {}).get("id") or "").strip().lower()
    if not uid:
        return False
    return uid in [x.lower() for x in _list(_sec(cfg, "admin").get("id"))]


def can_admin(user, token=None, cfg=None):
    """관리자 권한. SSO 로그인 id가 admin.id에 있거나, 임시 접속한 id가 admin.id에 있으면 된다.
    임시 id도 admin.id에 적어 두면 그 id로 들어온 사람은 관리자다.
    admin.id에 없는 임시 id(guest, temp 등)로 들어오면 일반 사용자다."""
    cfg = load_config() if cfg is None else cfg
    if is_admin(user, cfg):
        return True
    tid = check_token(token, cfg)
    if not tid:
        return False
    return tid.strip().lower() in [x.lower() for x in _list(_sec(cfg, "admin").get("id"))]


def _matches(user, cfg):
    """허용 목록에 걸리는지. (걸린 이유, 값) 또는 (None, None)."""
    allow = _sec(cfg, "allow")
    uid = str((user or {}).get("id") or "").strip()
    dept = str((user or {}).get("dept") or "").strip()
    if uid and uid.lower() in [x.lower() for x in _list(allow.get("id"))]:
        return "id", uid
    if dept:
        for d in _list(allow.get("dept")):
            if d and d.lower() in dept.lower():   # 부분 일치 — 부서명 표기가 조금 달라도 걸린다
                return "dept", d
    return None, None


# ---- 임시 접속 토큰 -------------------------------------------------------------
def _secret(cfg):
    """토큰 서명 키. 설정에 없으면 파일에 한 번 만들어 넣는다."""
    s = str(_etc(cfg, "secret", "") or "").strip()
    if s:
        return s.encode("utf-8")
    s = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
    try:
        with _LOCK:
            cur = load_config()
            etc = cur.get("etc") if isinstance(cur.get("etc"), dict) else {}
            etc["secret"] = s
            cur["etc"] = etc
            _save(cur)
    except Exception as e:
        _log("서명 키 저장 실패 (이번 기동 동안만 유효): %s" % e)
    return s.encode("utf-8")


def _sign(secret, payload):
    return base64.urlsafe_b64encode(hmac.new(secret, payload.encode("utf-8"),
                                             hashlib.sha256).digest()).decode().rstrip("=")


def issue_token(uid, cfg=None):
    cfg = load_config() if cfg is None else cfg
    hours = float(_etc(cfg, "session_hours", DEFAULT_SESSION_HOURS) or DEFAULT_SESSION_HOURS)
    exp = int(time.time() + hours * 3600)
    payload = "%s|%d" % (uid, exp)
    return "%s|%s" % (payload, _sign(_secret(cfg), payload))


def check_token(token, cfg=None):
    """유효하면 임시 id, 아니면 None."""
    if not token:
        return None
    cfg = load_config() if cfg is None else cfg
    parts = str(token).split("|")
    if len(parts) != 3:
        return None
    uid, exp, sig = parts
    payload = "%s|%s" % (uid, exp)
    try:
        if int(exp) < time.time():
            return None
    except (TypeError, ValueError):
        return None
    if not hmac.compare_digest(sig, _sign(_secret(cfg), payload)):
        return None
    return uid


def token_from(headers, cfg=None):
    """요청에서 통행증 찾기. 헤더가 우선이고 없으면 쿠키를 본다.
    페이지 이동에는 헤더를 붙일 수 없으므로 쿠키가 있어야 서버가 같은 판단을 한다."""
    try:
        tok = (headers.get("X-Access-Token") or "").strip()
    except AttributeError:
        return ""
    if tok:
        return tok
    raw = headers.get("Cookie") or ""
    for part in raw.split(";"):
        name, _, val = part.strip().partition("=")
        if name == COOKIE_NAME and val.strip():
            return val.strip()
    return ""


def cookie_header(token, cfg=None):
    """통행증을 담는 Set-Cookie 값. 토큰이 비면 즉시 만료시킨다."""
    cfg = load_config() if cfg is None else cfg
    if not token:
        return "%s=; Path=/; Max-Age=0; SameSite=Lax" % COOKIE_NAME
    try:
        hours = float(_etc(cfg, "session_hours", DEFAULT_SESSION_HOURS) or DEFAULT_SESSION_HOURS)
    except (TypeError, ValueError):
        hours = DEFAULT_SESSION_HOURS
    return "%s=%s; Path=/; Max-Age=%d; SameSite=Lax" % (COOKIE_NAME, token, int(hours * 3600))


def temp_login(tid, pw, cfg=None):
    """임시 자격 확인. 맞으면 토큰, 아니면 None.
    방금 추가한 자격도 바로 통하도록 파일을 강제로 다시 읽는다."""
    cfg = load_config(force=True) if cfg is None else cfg
    tid = str(tid or "").strip()
    pw = str(pw or "")
    for row in (cfg.get("temp") or []):
        if not isinstance(row, dict):
            continue
        if str(row.get("id") or "").strip() == tid and hmac.compare_digest(str(row.get("pw") or ""), pw):
            return issue_token(tid, cfg)
    return None   # 실패 로그는 호출부가 IP와 함께 남긴다


# ---- 판단 ---------------------------------------------------------------------
def status(cfg=None):
    """지금 제어가 켜졌는지, 어느 파일을 읽었는지. 기동 로그와 진단용."""
    cfg = load_config() if cfg is None else cfg
    allow = _sec(cfg, "allow")
    found = next((p for p in _SEARCH_PATHS if os.path.exists(p)), "")
    return {
        "enabled": enabled(cfg),
        "config_path": CONFIG_PATH,
        "config_found": found,
        "allow_id": len(_list(allow.get("id"))),
        "allow_dept": len(_list(allow.get("dept"))),
        "admin_id": len(_list(_sec(cfg, "admin").get("id"))),
        "temp": len([r for r in (cfg.get("temp") or []) if isinstance(r, dict)]),
    }


def log_status():
    """기동 시 한 줄. 켜졌는지 꺼졌는지를 눈으로 바로 확인할 수 있어야 한다."""
    st = status()
    if st["enabled"]:
        _log("접근 제어 켜짐 — 허용 id %d개 부서 %d개, 관리자 %d명, 임시 %d개 (%s)"
             % (st["allow_id"], st["allow_dept"], st["admin_id"], st["temp"], st["config_found"]))
    else:
        _log("접근 제어 꺼짐 — 아무도 막지 않습니다. 켜려면 %s 에 allow.id 를 채우세요%s"
             % (st["config_path"], "" if st["config_found"] else " (지금 그 파일이 없습니다)"))
    return st


def decide(user, token=None, cfg=None):
    """들여보낼지 판단한다.

    반환: {"allowed", "admin", "reason", "via", "enabled"}
      via = "off"(제어 꺼짐) | "id" | "dept" | "temp"
    """
    cfg = load_config() if cfg is None else cfg
    admin = can_admin(user, token, cfg)
    if not enabled(cfg):
        return {"allowed": True, "admin": admin, "via": "off", "enabled": False}

    how, hit = _matches(user, cfg)
    if how:
        return {"allowed": True, "admin": admin, "via": how, "match": hit, "enabled": True}

    tid = check_token(token, cfg)
    if tid:
        # 임시 접속은 통행증일 뿐이다. 화면의 사용자 표시는 SSO 결과를 그대로 둔다.
        return {"allowed": True, "admin": admin, "via": "temp", "temp_id": tid, "enabled": True}

    # 로그는 호출부가 남긴다 — 이 모듈은 IP를 모른다 (server.py가 IP와 함께 찍는다)
    uid = str((user or {}).get("id") or "").strip()
    return {"allowed": False, "admin": False, "via": None, "enabled": True,
            "reason": "허가되지 않은 사용자입니다",
            "checked": {"id": uid, "dept": str((user or {}).get("dept") or "")}}


# ---- 허가 목록 관리 (admin) ------------------------------------------------------
def rules(cfg=None):
    """편집 화면에 보여줄 현재 목록. 임시 자격의 pw는 내보내지 않는다."""
    cfg = load_config() if cfg is None else cfg
    allow, adm = _sec(cfg, "allow"), _sec(cfg, "admin")
    return {
        "enabled": enabled(cfg),
        "allow": {"id": _list(allow.get("id")), "dept": _list(allow.get("dept"))},
        "admin": {"id": _list(adm.get("id"))},
        "temp": [{"id": str(r.get("id") or ""), "note": str(r.get("note") or "")}
                 for r in (cfg.get("temp") or []) if isinstance(r, dict)],
        "config_path": CONFIG_PATH,
    }


def _save(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CONFIG_PATH)


def save_rules(new_rules):
    """허가 목록 저장. 서명 키와 임시 자격의 pw는 기존 값을 보존한다."""
    if not isinstance(new_rules, dict):
        raise ValueError("허가 목록은 JSON 객체여야 함")
    with _LOCK:
        cur = load_config()
        allow = _sec(new_rules, "allow")
        adm = _sec(new_rules, "admin")
        cur["allow"] = {"id": _list(allow.get("id")), "dept": _list(allow.get("dept"))}
        cur["admin"] = {"id": _list(adm.get("id"))}
        if isinstance(new_rules.get("temp"), list):
            old = {str(r.get("id") or ""): r for r in (cur.get("temp") or []) if isinstance(r, dict)}
            out = []
            for r in new_rules["temp"]:
                if not isinstance(r, dict) or not str(r.get("id") or "").strip():
                    continue
                tid = str(r["id"]).strip()
                pw = str(r.get("pw") or "")
                if not pw:  # 화면에서 pw를 비워 보내면 기존 값을 유지한다
                    pw = str((old.get(tid) or {}).get("pw") or "")
                if not pw:
                    continue
                out.append({"id": tid, "pw": pw, "note": str(r.get("note") or "")})
            cur["temp"] = out
        _save(cur)
    return rules()
