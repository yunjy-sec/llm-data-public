"""SSO 로그인 확인 (stdlib only).

기존 기능과 완전히 분리된 모듈이다. 이 파일이 무슨 이유로 실패하든 앱은 그대로 동작하고
로그인 id만 guest로 표시된다. 서버에서 이 모듈을 부르는 곳은 /api/whoami 와 /api/sso/* 뿐이다.

설정: config/sso.json (env LLM_DATA_SSO_CONFIG로 경로 재지정 가능)
llm.json과 같은 방식이다. 주고받는 key와 value를 설정에 모두 적고, etc는 전송되지 않는다.

구조는 두 단계다.

  "local"  1단계 — 브라우저가 사용자 PC의 로컬 에이전트에 웹소켓으로 붙어 토큰을 받는다.
           여기서 localhost는 서버가 아니라 사용자 PC이므로 브라우저만 할 수 있다.
    - url:       ws://localhost:<포트>/<경로>
    - request:   에이전트로 보낼 메시지. 객체면 JSON으로, 문자열이면 그대로 보낸다.
                 비우면 보내지 않고 받기만 한다.
    - response:  받은 메시지에서 값을 꺼낼 경로를 이름마다 적는다.
                 예: {"userInfo": "userInfo", "key": "key"}
                 경로 대신 ""를 적으면 받은 메시지 전체를 그 값으로 쓴다.
    - etc:       timeout(초, 기본 3) 등. 전송되지 않는다.

  "verify" 2단계 — 서버가 그 토큰을 얹어 로그인 확인 endpoint로 POST한다.
    - url:       예 http://12.23.31.72:8000/api/verify_sso
                 localhost가 아니라 적은 호스트로 그대로 나간다.
                 경로를 빼고 호스트만 적으면 /api/verify_sso를 붙인다.
    - header:    요청 헤더. 적은 이름과 값 그대로 전송된다(대소문자 보존).
    - body:      요청 본문. 값에 "{이름}"을 쓰면 1단계에서 받은 그 값으로 치환된다.
                 {"json": {...}} 로 감싸면 그 안을 채운 뒤 JSON 문자열로 만든다
                 (token 안에 JSON 문자열을 넣어야 하는 규약용).
    - response:  응답에서 값을 꺼낼 경로. {"id": ..., "name": ..., "dept": ...}
                 경로 중간이 JSON 문자열이면 자동으로 객체로 바꾸고 계속 내려간다.
                 배열로 후보 경로를 여러 개 줄 수 있다.
    - etc:       method(기본 POST) timeout forward_headers 등. 전송되지 않는다.

1단계 설정이 없으면 2단계만 수행한다 (쿠키를 그대로 넘겨 확인하는 구성).
forward_headers(기본 Cookie, Authorization)에 적힌 헤더는 브라우저 요청에서 그대로 넘긴다.

service 상태 (화면 LED 판단용)
  - "up":           서버가 HTTP 응답을 준 경우 (401 등도 서버는 살아 있다)
  - "down":         연결 자체가 안 됨 (DNS·거부·타임아웃) — id 왼쪽에 빨간 LED
  - "unconfigured": 설정 파일이 없거나 verify.url이 비어 있음 — LED 없이 그냥 guest
id를 실제로 가져오면 초록 LED와 함께 id 이름 부서가 표시된다.

로그는 실패했을 때만 남긴다. 서버 터미널의 [SSO] 줄과 브라우저 console의 [sso] 줄이며,
어디로 무엇을 보냈고 무엇을 받았는지가 함께 찍힌다. 정상 흐름은 조용히 지나간다.
자격 정보가 담긴 헤더(Cookie·Authorization 등)는 로그에서 값 대신 길이만 표시된다.
"""

import hashlib
import http.client
import json
import os
import socket
import threading
import time
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
_PERSIST = os.environ.get("LLM_DATA_PERSIST")
CONFIG_DEFAULT_PATH = os.path.join(ROOT, "config", "sso.json")
CONFIG_PATH = (os.environ.get("LLM_DATA_SSO_CONFIG")
               or (os.path.join(_PERSIST, "config", "sso.json") if _PERSIST else CONFIG_DEFAULT_PATH))

MAX_BYTES = 256 * 1024
GUEST = "guest"

# 경로를 적지 않았을 때 붙이는 확인 endpoint
VERIFY_PATH = "/api/verify_sso"
DEFAULT_METHOD = "POST"          # 이 endpoint는 POST를 받는다
DEFAULT_FORWARD = ("Cookie", "Authorization")
# 응답에서 값을 꺼낼 기본 경로. 후보를 여러 개 두어 중첩이 조금 달라도 찾는다.
# 후보 경로를 여러 개 두어 응답 중첩이 달라도 찾는다. 마지막 후보(EP_ 이름만)는
# 본문 전체가 JSON 문자열이고 그 안에 EP_ 필드가 바로 있는 경우를 잡는다.
DEFAULT_RESPONSE = {
    "id": ["data.response.EP_LOGINID", "data.EP_LOGINID", "response.EP_LOGINID",
           "userInfo.EP_LOGINID", "EP_LOGINID"],
    "name": ["data.response.EP_USERNAME", "data.EP_USERNAME", "response.EP_USERNAME",
             "userInfo.EP_USERNAME", "EP_USERNAME"],
    "dept": ["data.response.EP_DEPTNAME", "data.EP_DEPTNAME", "response.EP_DEPTNAME",
             "userInfo.EP_DEPTNAME", "EP_DEPTNAME"],
}

_LOCK = threading.Lock()
_CACHE = {}            # 세션키 -> (만료시각, 결과)
_HEALTH = [0.0, None]  # [만료시각, service]


def _log(msg):
    """터미널(서버 stdout) 로그. llm.py의 [LLM] 로그와 같은 자리에서 보인다."""
    try:
        print("[SSO] %s" % msg, flush=True)
    except Exception:
        pass


def load_config():
    for p in (CONFIG_PATH, CONFIG_DEFAULT_PATH):
        try:
            with open(p, encoding="utf-8") as f:
                cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
        except OSError:
            continue
        except ValueError as e:
            _log("설정 파일 JSON 오류 %s: %s" % (p, e))
            return {}
    return {}


def _sec(cfg, name):
    v = cfg.get(name)
    return v if isinstance(v, dict) else {}


def _etc(sec, key, default=None):
    etc = sec.get("etc")
    if isinstance(etc, dict) and key in etc:
        return etc[key]
    return sec.get(key, default)


def _num(v, default):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def endpoint(cfg=None):
    """2단계 endpoint. 경로가 없으면 VERIFY_PATH를 붙인다 (호스트만 적어도 동작)."""
    cfg = load_config() if cfg is None else cfg
    url = str(_sec(cfg, "verify").get("url") or cfg.get("url") or "").strip()
    if not url:
        return ""
    parts = urlsplit(url)
    if not parts.path or parts.path == "/":
        return url.rstrip("/") + VERIFY_PATH
    return url


def configured(cfg=None):
    return bool(endpoint(load_config() if cfg is None else cfg))


def poll_seconds(cfg=None):
    """화면이 상태를 다시 물어보는 주기(초). etc.poll_seconds, 기본 30."""
    cfg = load_config() if cfg is None else cfg
    try:
        return max(5, min(int(_etc(cfg, "poll_seconds", 30) or 30), 3600))
    except (TypeError, ValueError):
        return 30


def public_config(cfg=None):
    """브라우저가 1단계를 수행하는 데 필요한 정보만. 자격 정보는 담지 않는다."""
    cfg = load_config() if cfg is None else cfg
    local = _sec(cfg, "local")
    return {
        "configured": configured(cfg),
        "verify_url": endpoint(cfg),
        "poll_seconds": poll_seconds(cfg),
        "local": {
            "url": str(local.get("url") or "").strip(),
            "request": local.get("request"),
            "response": local.get("response") or {},
            "timeout": _num(_etc(local, "timeout", 3), 3),
        },
    }


def _mask(name, value):
    lk = str(name).lower()
    if any(t in lk for t in ("cookie", "authorization", "token", "key", "secret", "ticket", "auth")):
        return "****(%d자)" % len(str(value))
    return str(value)


def _forward_names(verify):
    names = _etc(verify, "forward_headers", None)
    if isinstance(names, list) and names:
        return [str(n) for n in names if str(n).strip()]
    return list(DEFAULT_FORWARD)


def _headers(verify, incoming):
    """2단계 요청 헤더. 설정의 header를 그대로 쓰고, forward_headers에 적힌 것만
    브라우저 요청에서 옮겨 담는다 (세션 쿠키가 있어야 누구인지 알 수 있다)."""
    out = {"Accept": "application/json"}
    extra = verify.get("header")
    if isinstance(extra, dict):
        for k, v in extra.items():
            if str(k) == "disabled":
                continue  # llm.json과 같은 규칙 — 적어두되 보내지 않는다
            out[str(k)] = str(v)
    if incoming is not None:
        for name in _forward_names(verify):
            try:
                val = incoming.get(name)
            except AttributeError:
                val = None
            if val:
                out[str(name)] = str(val)
    return out


def _fill(value, values):
    """설정 값의 {이름} 자리를 1단계에서 받은 값으로 치환한다.
    {"json": {...}} 로 감싸면 그 안을 채운 뒤 JSON 문자열로 만든다
    (token 안에 JSON 문자열을 넣어야 하는 규약용)."""
    if isinstance(value, str):
        out = value
        for k, v in (values or {}).items():
            out = out.replace("{%s}" % k, "" if v is None else str(v))
        return out
    if isinstance(value, dict):
        if list(value.keys()) == ["json"]:
            return json.dumps(_fill(value["json"], values), ensure_ascii=False)
        return {k: _fill(v, values) for k, v in value.items() if str(k) != "disabled"}
    if isinstance(value, list):
        return [_fill(v, values) for v in value]
    return value


def _body(verify, values):
    """2단계 요청 본문. 설정의 body를 그대로 쓰되 {이름} 자리를 치환한다."""
    b = verify.get("body")
    if not isinstance(b, dict):
        b = {}
    raw = json.dumps(b, ensure_ascii=False)
    missing = [k for k in (values or {}) if ("{%s}" % k) not in raw]
    if missing:
        _log("주의: verify.body에 %s 자리가 없어 1단계 값이 실리지 않는다"
             % ", ".join("{%s}" % m for m in missing))
    return _fill(b, values)


def _session_key(headers, values):
    raw = ("|".join("%s=%s" % (k, headers[k]) for k in sorted(headers)) + "|"
           + json.dumps(values or {}, sort_keys=True, ensure_ascii=False))
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:32]


def _pick(obj, path):
    """점으로 이어진 경로로 값 꺼내기. 경로가 ""면 obj 자체를 값으로 본다.
    내려가는 도중 값이 JSON 문자열이면 한 번 파싱하고 계속 내려간다
    (KnoxTray의 raw.data처럼 문자열 안에 JSON이 들어 있는 응답용)."""
    cur = obj
    if str(path) != "":
        for part in str(path).split("."):
            if isinstance(cur, str):
                try:
                    cur = json.loads(cur)
                except ValueError:
                    return None
            if isinstance(cur, list):
                try:
                    cur = cur[int(part)]
                    continue
                except (ValueError, IndexError):
                    return None
            if not isinstance(cur, dict) or part not in cur:
                return None
            cur = cur[part]
    if isinstance(cur, (str, int, float)) and str(cur).strip():
        return str(cur).strip()
    return None


def _pick_any(obj, paths):
    """경로 하나 또는 후보 여러 개로 값 찾기. 먼저 값이 있는 경로를 쓴다."""
    for path in ([paths] if isinstance(paths, str) else (paths or [])):
        got = _pick(obj, path)
        if got:
            return got
    return None


def _response_map(verify):
    """응답에서 값을 꺼낼 경로 후보. 설정에 적은 경로를 먼저 쓰고, 못 찾으면 기본 후보로
    넘어간다. 설정 경로 하나만 시도하고 끝내면 응답 구조가 조금만 달라도 실패한다."""
    m = verify.get("response") if isinstance(verify.get("response"), dict) else {}
    out = {}
    for k, dflt in DEFAULT_RESPONSE.items():
        v = m.get(k)
        paths = [v] if isinstance(v, str) and v else [str(x) for x in (v or []) if str(x)]
        out[k] = paths + [p for p in dflt if p not in paths]
    for k, v in m.items():  # 설정에만 있는 추가 필드도 그대로 쓴다
        if k in out or str(k) == "disabled":
            continue
        out[k] = [v] if isinstance(v, str) else [str(x) for x in (v or [])]
    return out


def _preview(body, limit=600):
    try:
        s = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    except (TypeError, ValueError):
        s = str(body)
    return s[:limit] + ("…" if len(s) > limit else "")


def _request(verify, url, headers, body, timeout, method):
    parts = urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=timeout)
    try:
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        data = None
        if method in ("POST", "PUT", "PATCH"):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers = dict(headers, **{"Content-Type": "application/json",
                                       "Content-Length": str(len(data))})
        started = time.time()
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        raw = r.read(MAX_BYTES)
        if r.status >= 400:  # 정상 응답은 조용히 지나간다 — 오류만 남긴다
            _log("%s %s -> %s (%dms, %dB)" % (method, url, r.status,
                                              int((time.time() - started) * 1000), len(raw)))
        return r.status, raw
    finally:
        conn.close()


def whoami(incoming_headers=None, values=None):
    """로그인 확인. 어떤 실패에서도 예외를 던지지 않고 guest를 돌려준다.

    반환: {"id", "name", "dept", "source", "service", "status", "error", "response"}
      source  = "sso" | "none"
      service = "up" | "down" | "unconfigured"
    """
    cfg = load_config()
    url = endpoint(cfg)
    if not url:
        return {"id": GUEST, "source": "none", "service": "unconfigured"}
    verify = _sec(cfg, "verify") or cfg

    if isinstance(values, str):
        values = {"token": values}   # 값 하나만 넘어온 옛 호출부 호환
    values = values if isinstance(values, dict) else {}

    headers = _headers(verify, incoming_headers)
    key = _session_key(headers, values)
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > now:
            return dict(hit[1])

    body = _body(verify, values)
    method = str(_etc(verify, "method", DEFAULT_METHOD)).upper()
    timeout = _num(_etc(verify, "timeout", 3), 3)
    result = {"id": GUEST, "source": "none", "service": "down", "url": url}

    try:
        status, raw = _request(verify, url, headers, body, timeout, method)
        if status == 405:
            alt = "GET" if method == "POST" else "POST"
            _log("405 Method Not Allowed — %s로 재시도한다 (verify.etc.method로 고정할 수 있다)" % alt)
            status, raw = _request(verify, url, headers, body, timeout, alt)
            if status < 400:
                result["method_used"] = alt
        # HTTP 응답이 왔다면 서버는 살아 있다. 401/403은 "로그인 안 됨"이지 장애가 아니다.
        result["service"] = "up"
        result["status"] = status
        text = raw.decode("utf-8", "replace")
        if status < 400:
            try:
                doc = json.loads(text)
            except ValueError:
                doc = None
            fields = _response_map(verify)
            got = {k: _pick_any(doc, v) for k, v in fields.items()} if doc is not None else {}
            if got.get("id"):
                result["source"] = "sso"
                for k, v in got.items():
                    if v:
                        result[k] = v
            else:
                # 통신은 됐는데 찾는 값이 없는 경우. 원인을 보도록 응답을 일부 싣는다
                result["error"] = "응답에서 id를 찾지 못함 (시도한 경로 %s)" % ", ".join(fields.get("id") or [])
                result["response"] = _preview(doc if doc is not None else text)
        else:
            result["error"] = "HTTP %s" % status
            result["response"] = _preview(text)
    except Exception as e:  # 연결 실패·타임아웃 — 서비스가 죽은 것으로 본다
        result["error"] = "%s: %s" % (type(e).__name__, e)

    if result["source"] != "sso":
        # 실패만 남긴다. 어디로 무엇을 보냈는지까지 함께 적어야 원인을 찾을 수 있다.
        _log("실패 %s | service=%s | 1단계 값 %s | body %s | %s%s" % (
            url, result["service"],
            ", ".join("%s(%d자)" % (k, len(str(v))) for k, v in sorted(values.items())) or "없음",
            _preview({k: _mask(k, v) for k, v in body.items()}, 160),
            result.get("error", ""),
            " | 응답 " + result["response"] if result.get("response") else ""))

    ttl = _num(_etc(cfg, "cache_seconds", 60), 60)
    if result["service"] == "down":
        ttl = min(ttl, _num(_etc(cfg, "health_seconds", 10), 10))
    with _LOCK:
        _CACHE[key] = (now + ttl, dict(result))
        if len(_CACHE) > 512:
            for k in sorted(_CACHE, key=lambda x: _CACHE[x][0])[:256]:
                _CACHE.pop(k, None)
        _HEALTH[0], _HEALTH[1] = now + _num(_etc(cfg, "health_seconds", 10), 10), result["service"]
    return dict(result)


def health():
    """2단계 서비스 생사만 가볍게 확인 (화면 LED용). 캐시된 값이 있으면 그것을 쓴다."""
    cfg = load_config()
    url = endpoint(cfg)
    if not url:
        return {"service": "unconfigured", "url": ""}
    now = time.time()
    with _LOCK:
        if _HEALTH[0] > now and _HEALTH[1]:
            return {"service": _HEALTH[1], "url": url, "cached": True}
    verify = _sec(cfg, "verify") or cfg
    timeout = _num(_etc(cfg, "health_seconds", 10), 10)
    service, err = "down", None
    # 생사만 보면 되므로 TCP 연결만 확인한다. 빈 토큰으로 verify_sso를 두드리면
    # 상대 서버 로그에 실패 기록이 쌓이고 의미도 없다.
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        socket.create_connection((parts.hostname, port),
                                 min(timeout, _num(_etc(verify, "timeout", 3), 3))).close()
        service = "up"
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
        _log("생사 확인 실패 %s:%s %s" % (parts.hostname, port, err))
    with _LOCK:
        _HEALTH[0], _HEALTH[1] = now + timeout, service
    out = {"service": service, "url": url, "poll_seconds": poll_seconds(cfg)}
    if err:
        out["error"] = err
    return out
