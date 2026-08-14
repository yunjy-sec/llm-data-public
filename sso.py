"""SSO 로그인 id 조회 (stdlib only).

기존 기능과 완전히 분리된 모듈이다. 이 파일이 무슨 이유로 실패하든 앱은 그대로 동작하고
로그인 id만 guest로 표시된다. 서버 코드에서 이 모듈을 부르는 곳은 /api/whoami 하나뿐이다.

설정: config/sso.json (env LLM_DATA_SSO_CONFIG로 경로 재지정 가능)
llm.json과 같은 방식이다. url/header가 요청을 그대로 결정하고 etc는 전송되지 않는다.

- url:      로그인 사용자 조회 endpoint (예: http://12.23.31.72:8000/api/me)
            localhost가 아니라 그 호스트로 나간다 — 적은 주소 그대로 쓴다.
- header:   요청 헤더. 적은 이름과 값 그대로 전송된다(대소문자 보존).
- id_field / name_field / dept_field:
            응답 JSON에서 값을 꺼낼 경로. 점으로 중첩을 표현한다 (예: "data.EP_LOGINID").
            여러 후보를 배열로 줄 수 있고 먼저 값이 있는 것을 쓴다.
            기본값은 data.EP_LOGINID / data.EP_USERNAME / data.EP_DEPTNAME 이다.
- etc:      전송되지 않는 자유 영역. 아래 값을 넣으면 그대로 동작한다.
  - forward_headers: 브라우저 요청의 어떤 헤더를 SSO 서버로 그대로 넘길지 (기본 Cookie,
                     Authorization). 세션 쿠키를 넘겨야 누가 로그인했는지 알 수 있다.
  - timeout:         조회 대기 (초, 기본 3)
  - cache_seconds:   같은 세션의 조회 결과를 캐시할 시간 (초, 기본 60)
  - health_seconds:  서비스 생사 판정을 캐시할 시간 (초, 기본 10)

service 상태 (화면 LED 판단용)
  - "up":           서버가 HTTP 응답을 준 경우 (401 등도 서버는 살아 있다)
  - "down":         연결 자체가 안 됨 (DNS·거부·타임아웃) — id 왼쪽에 빨간 LED
  - "unconfigured": 설정 파일이 없거나 url이 비어 있음 — LED 없이 그냥 guest
id를 실제로 가져오면(source=sso) 화면에 초록 LED와 id 이름 부서가 함께 표시된다.
"""

import hashlib
import http.client
import json
import os
import threading
import time
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
_PERSIST = os.environ.get("LLM_DATA_PERSIST")
CONFIG_DEFAULT_PATH = os.path.join(ROOT, "config", "sso.json")
CONFIG_PATH = (os.environ.get("LLM_DATA_SSO_CONFIG")
               or (os.path.join(_PERSIST, "config", "sso.json") if _PERSIST else CONFIG_DEFAULT_PATH))

MAX_BYTES = 256 * 1024
DEFAULT_FORWARD = ("Cookie", "Authorization")
GUEST = "guest"

_LOCK = threading.Lock()
_CACHE = {}       # 세션키 -> (만료시각, 결과)
_HEALTH = [0.0, None]  # [만료시각, service 문자열]


def load_config():
    for p in (CONFIG_PATH, CONFIG_DEFAULT_PATH):
        try:
            with open(p, encoding="utf-8") as f:
                cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
        except (OSError, ValueError):
            continue
    return {}


def _etc(cfg, key, default):
    etc = cfg.get("etc")
    if isinstance(etc, dict) and key in etc:
        return etc[key]
    return cfg.get(key, default)


def _num(v, default):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def configured(cfg=None):
    cfg = load_config() if cfg is None else cfg
    return bool(str(cfg.get("url") or "").strip())


def _forward_names(cfg):
    names = _etc(cfg, "forward_headers", None)
    if isinstance(names, list) and names:
        return [str(n) for n in names if str(n).strip()]
    return list(DEFAULT_FORWARD)


def _headers(cfg, incoming):
    """SSO 서버로 보낼 헤더. 설정의 header를 그대로 쓰고, forward_headers에 적힌 것만
    브라우저 요청에서 옮겨 담는다 (세션 쿠키가 있어야 누구인지 알 수 있다)."""
    out = {"Accept": "application/json"}
    extra = cfg.get("header")
    if isinstance(extra, dict):
        for k, v in extra.items():
            if str(k) == "disabled":
                continue  # llm.json과 같은 규칙 — 적어두되 보내지 않는다
            out[str(k)] = str(v)
    if incoming is not None:
        for name in _forward_names(cfg):
            try:
                val = incoming.get(name)
            except AttributeError:
                val = None
            if val:
                out[str(name)] = str(val)
    return out


def _session_key(headers):
    """캐시 키. 세션을 식별하는 헤더 값만 해시한다 (값 자체는 남기지 않는다)."""
    raw = "|".join(str(headers.get(n) or "") for n in sorted(headers))
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:32]


def _pick(obj, path):
    cur = obj
    for part in str(path).split("."):
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
                continue
            except (ValueError, IndexError):
                return None
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    if isinstance(cur, (str, int)) and str(cur).strip():
        return str(cur).strip()
    return None


# 응답에서 값을 꺼낼 기본 경로 (이 환경의 SSO 응답 형태)
DEFAULT_FIELDS = {
    "id_field": ["data.EP_LOGINID", "EP_LOGINID", "id", "user_id", "username"],
    "name_field": ["data.EP_USERNAME", "EP_USERNAME", "name", "username"],
    "dept_field": ["data.EP_DEPTNAME", "EP_DEPTNAME", "dept", "department"],
}


def _field(body, cfg, key):
    fields = cfg.get(key) or DEFAULT_FIELDS[key]
    if isinstance(fields, str):
        fields = [fields]
    for f in fields:
        got = _pick(body, f)
        if got:
            return got
    return None


def _preview(body, limit=600):
    """콘솔 확인용 응답 미리보기. 길면 자른다."""
    try:
        s = json.dumps(body, ensure_ascii=False)
    except (TypeError, ValueError):
        s = str(body)
    return s[:limit] + ("…" if len(s) > limit else "")


def _request(cfg, headers, timeout):
    parts = urlsplit(str(cfg.get("url")).strip())
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=timeout)
    try:
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        conn.request(str(_etc(cfg, "method", "GET")).upper(), path, headers=headers)
        r = conn.getresponse()
        return r.status, r.read(MAX_BYTES)
    finally:
        conn.close()


def whoami(incoming_headers=None):
    """로그인 id 조회. 어떤 실패에서도 예외를 던지지 않고 guest를 돌려준다.

    반환: {"id", "name", "dept", "source", "service", "error"}
      source  = "sso" | "none"
      service = "up" | "down" | "unconfigured"
    """
    cfg = load_config()
    if not configured(cfg):
        return {"id": GUEST, "source": "none", "service": "unconfigured"}
    url = str(cfg.get("url") or "")

    headers = _headers(cfg, incoming_headers)
    key = _session_key(headers)
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > now:
            return dict(hit[1])

    timeout = _num(_etc(cfg, "timeout", 3), 3)
    result = {"id": GUEST, "source": "none", "service": "down", "url": url}
    try:
        status, raw = _request(cfg, headers, timeout)
        # HTTP 응답이 왔다면 서버는 살아 있다. 401/403은 "로그인 안 됨"이지 장애가 아니다.
        result["service"] = "up"
        if status < 400:
            try:
                body = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                body = None
            uid = _field(body, cfg, "id_field") if body is not None else None
            if uid:
                result["id"] = uid
                result["source"] = "sso"
                name = _field(body, cfg, "name_field")
                dept = _field(body, cfg, "dept_field")
                if name:
                    result["name"] = name
                if dept:
                    result["dept"] = dept
            else:
                # 통신은 됐는데 찾는 값이 없는 경우. 화면 콘솔에서 원인을 보도록 응답을 일부 싣는다
                # (id를 못 찾았으므로 개인정보가 아니라 형태 확인용이다)
                result["error"] = "no id field in response (looked for %s)" % (
                    cfg.get("id_field") or DEFAULT_FIELDS["id_field"])
                result["response"] = _preview(body if body is not None else raw)
        else:
            result["error"] = "HTTP %s" % status
    except Exception as e:  # 연결 실패·타임아웃 — 서비스가 죽은 것으로 본다
        result["error"] = "%s: %s" % (type(e).__name__, e)

    ttl = _num(_etc(cfg, "cache_seconds", 60), 60)
    if result["service"] == "down":
        ttl = min(ttl, _num(_etc(cfg, "health_seconds", 10), 10))
    with _LOCK:
        _CACHE[key] = (now + ttl, dict(result))
        if len(_CACHE) > 512:  # 상한 — 오래된 것부터 버린다
            for k in sorted(_CACHE, key=lambda x: _CACHE[x][0])[:256]:
                _CACHE.pop(k, None)
        _HEALTH[0], _HEALTH[1] = now + _num(_etc(cfg, "health_seconds", 10), 10), result["service"]
    return dict(result)


def health():
    """서비스 생사만 가볍게 확인 (화면의 빨간 LED용). 캐시된 값이 있으면 그것을 쓴다."""
    cfg = load_config()
    if not configured(cfg):
        return {"service": "unconfigured", "url": ""}
    now = time.time()
    with _LOCK:
        if _HEALTH[0] > now and _HEALTH[1]:
            return {"service": _HEALTH[1], "url": str(cfg.get("url") or ""), "cached": True}
    timeout = _num(_etc(cfg, "health_seconds", 10), 10)
    service, err = "down", None
    try:
        _request(cfg, _headers(cfg, None), min(timeout, _num(_etc(cfg, "timeout", 3), 3)))
        service = "up"
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    with _LOCK:
        _HEALTH[0], _HEALTH[1] = now + timeout, service
    out = {"service": service, "url": str(cfg.get("url") or "")}
    if err:
        out["error"] = err
    return out
