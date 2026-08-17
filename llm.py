"""OpenAI 호환 LLM API 게이트웨이 (stdlib only).

설정: config/llm.json (env LLM_DATA_CONFIG로 경로 재지정 가능)

권장 구성은 4개 키다. url·header·body가 요청을 그대로 결정하고, etc는 전송되지 않는다.
- url:    전체 endpoint
- header: 실제 요청 헤더. 적은 이름과 값 그대로 전송된다(대소문자 보존, 값은 문자열).
          {uuid} {uuid_hex} {ts}는 요청마다 치환된다.
- body:   요청 본문 항목. 스칼라는 고정값, {"min","max","step"}는 범위 선택,
          ["a","b"]는 목록 선택(화면 드롭다운). 고르지 않은 선택 항목은 보내지 않는다.
          model도 여기에 둔다.
- header/body 안의 disabled: 적어만 두고 전송하지 않는 블록. JSON은 주석이 없고
          화면에서 저장하면 파일이 다시 기록되므로, 꺼둔 항목을 데이터로 남긴다.
          켜려면 그 줄을 disabled 밖으로 옮긴다.
- etc:    요청에 실리지 않는 자유 영역(설명). timeout·probe_timeout·response_schema·
          models·api_key_env는 여기 넣어도 읽는다(최상위 키가 우선).

아래는 그 외/과거 키. 모델별 URL 경로를 쓰는 서버(llm-api) 호환을 위해 유지한다.
- base_url: LLM API 루트 (기본 http://127.0.0.1:8820 = llm-api)
- model:    서비스 id (fable|opus|sonnet|haiku|gpt-5.6|...)
- url:      지정 시 base_url/model 조합 대신 이 주소를 그대로 사용
- headers:  요청에 그대로 합쳐지는 헤더. 토큰은 코드가 아니라 여기에 둔다.
            여기에 쓴 이름과 값은 대소문자까지 그대로 전송된다(x-dep-ticket, User-Type 등).
            예: {"Authorization": "Bearer <token>"} 또는 {"X-Api-Key": "..."}
- header_map: 전달용 키를 헤더 이름에 매핑. 값은 그 키의 값을 쓴다.
            예: {"credential_key": "x-dep-ticket", "user_id": "User-Id"}
- models:   이 환경에서 사용할 모델 목록. 미지정 시 기본 목록을 쓴다.
- api_base_url: 게이트웨이 루트. /v1로 끝나면 /chat/completions만 덧붙인다
            (모델을 URL 경로가 아니라 요청 body의 model 필드로 받는 환경)
- api_key_env: 지정 시 해당 환경변수 값을 Authorization: Bearer로 주입
- timeout:  초 (기본 300 — llm-api 서비스 timeout과 동일)
- response_schema: true면 response_format(json_schema)로 구조화 출력 강제.
  기본 false — response_format을 지원하지 않는 LLM이 많아 시스템 프롬프트와
  lenient 파서만으로 동작하는 것이 기본이다. 지원이 확인된 LLM에서만 켠다.
"""

import log as _log_mod
import http.client
import json
import os
import threading
import time
import uuid
from urllib.parse import urlsplit

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
    # 모델 프로필 구성이면 기본값을 최상위에 만들지 않는다. 그 값은 각 프로필이 정한다.
    if profiles(cfg):
        return cfg
    # 기본값은 etc/body에 그 값이 없을 때만 채운다. setdefault로 최상위에 키를 만들어 버리면
    # opt()의 우선순위(최상위 > etc) 때문에 etc.timeout 같은 설정이 영원히 가려진다.
    etc = cfg.get("etc") if isinstance(cfg.get("etc"), dict) else {}
    body = cfg.get("body") if isinstance(cfg.get("body"), dict) else {}
    if not cfg.get("url") and not cfg.get("api_base_url"):
        cfg.setdefault("base_url", "http://127.0.0.1:8820")
    if not (isinstance(body.get("model"), str) and body["model"].strip()):
        cfg.setdefault("model", "sonnet")
    if "timeout" not in etc:
        cfg.setdefault("timeout", 300)
    if "response_schema" not in etc:
        cfg.setdefault("response_schema", False)
    return cfg


# 프론트에서 편집을 허용하는 키 (그 외 키는 저장 시 버려진다)
# timeout 상한. 설정값을 그대로 쓰되 오타(예: 밀리초 입력)로 영원히 매달리는 것만 막는다.
TIMEOUT_MAX = 86400

# 전달용 키 -> 헤더 이름 기본 매핑. header_map을 쓰지 않아도 값만 채우면 전송된다.
# 게이트웨이가 다른 이름을 요구하면 config의 header_map으로 덮어쓴다(같은 키를 지정하면 교체).
DEFAULT_HEADER_MAP = {
    "credential_key": "x-dep-ticket",
    "send_system_name": "Send-System-Name",
    "user_id": "User-Id",
}


# header/body 안에서 "적어두되 전송하지 않는" 블록. 켜려면 이 블록 밖으로 옮긴다.
DISABLED_KEY = "disabled"

# 모델 프로필이 아닌 최상위 키 — 이 이름들은 프로필로 오인하지 않는다
RESERVED_KEYS = {"url", "header", "headers", "body", "etc", "base_url", "api_base_url", "model",
                 "models", "model_options", "header_map", "body_by_model", "extra_payload",
                 "timeout", "probe_timeout", "response_schema", "api_key_env",
                 "OPENAI_API_KEY", "credential_key", "send_system_name", "env_model",
                 "user_id", "user_pw", "context_limit_tokens"}


def profiles(cfg):
    """모델 프로필 {모델이름: {url, header, body, etc}}.
    특별한 환경용 설정은 모델마다 온전한 구조를 하나씩 갖는다. 최상위 키 이름이 곧 모델 이름이다.
    프로필이 하나도 없으면 {} (url/header/body를 최상위에 둔 단일 구성)."""
    out = {}
    if not isinstance(cfg, dict):
        return out
    for k, v in cfg.items():
        if str(k) in RESERVED_KEYS or str(k).startswith("_"):
            continue
        if isinstance(v, dict) and any(x in v for x in ("url", "header", "body")):
            out[str(k)] = v
    return out


def resolve(cfg=None, model=None):
    """모델 하나에 대한 평평한 설정. 프로필 구성이면 그 모델의 url/header/body/etc를 꺼내
    최상위 공통 키 위에 얹는다. 프로필이 없으면 설정을 그대로 쓴다."""
    cfg = cfg if cfg is not None else load_config()
    profs = profiles(cfg)
    if not profs:
        return cfg
    name = str(model or cfg.get("model") or "").strip()
    if name not in profs:
        name = next(iter(profs))
    prof = profs[name]
    petc = prof.get("etc") if isinstance(prof.get("etc"), dict) else {}
    # 프로필의 etc가 최상위 과거 키(timeout 등)보다 우선하도록 같은 이름은 걷어낸다
    merged = {k: v for k, v in cfg.items() if k not in profs and k not in petc}
    merged.update(prof)
    merged["model"] = name
    return merged


def opt(cfg, key, default=None):
    """부가 설정 조회. 최상위 키가 우선이고 없으면 etc 안을 본다.
    url/header/body 3키만 쓰는 설정에서 timeout 같은 값을 etc에 모아둘 수 있다."""
    if key in cfg:
        return cfg[key]
    etc = cfg.get("etc")
    if isinstance(etc, dict) and key in etc:
        return etc[key]
    return default


def rate_config(cfg=None, model=None):
    """모델별 rate 설정 — llm.json 프로필의 rate 블록.

    창 길이는 모델마다 다르다. 빠른 모델과 오래 걸리는 모델을 같은 창으로 재면
    한쪽은 늘 0에 가깝고 다른 쪽은 계속 붐벼 보인다. 그래서 url·header·body와 나란히
    모델 프로필 안에 둔다. 없으면 {} — 그 모델은 기본값으로 잰다.
    """
    got = opt(resolve(cfg if cfg is not None else load_config(), model), "rate")
    return got if isinstance(got, dict) else {}


def req_timeout(cfg):
    """LLM 호출 타임아웃(초). config의 timeout을 그대로 쓴다(기본 300)."""
    cfg = resolve(cfg)
    try:
        return max(1, min(int(opt(cfg, "timeout", 300)), TIMEOUT_MAX))
    except (TypeError, ValueError):
        return 300


# 화면에서 소요 시간·토큰 크기를 색으로 보일 때 쓰는 범위. 설정에서 덮어쓸 수 있다.
DEFAULT_SCALES = {
    "latency": {"min_s": 0.5, "warm_s": 60, "max_s": 300, "alarm_s": 300},
    "token": {"min": 100, "max": 100000},
}


def scales(cfg=None):
    """색상 스케일 범위. llm.json의 etc.latency_scale / etc.token_scale로 덮어쓴다.
    값은 log로 매핑되므로 min은 0보다 커야 한다."""
    cfg = resolve(cfg if cfg is not None else load_config())
    out = {k: dict(v) for k, v in DEFAULT_SCALES.items()}
    for key, name in (("latency", "latency_scale"), ("token", "token_scale")):
        got = opt(cfg, name)
        if isinstance(got, dict):
            for k, v in got.items():
                try:
                    out[key][str(k)] = float(v)
                except (TypeError, ValueError):
                    continue
    return out


def poll_seconds(cfg=None):
    """화면이 상태를 다시 물어보는 주기(초). config의 poll_seconds, 기본 30.
    프로필 구성이면 etc에 넣어도 읽는다."""
    cfg = resolve(cfg if cfg is not None else load_config())
    try:
        return max(5, min(int(opt(cfg, "poll_seconds", 30)), 3600))
    except (TypeError, ValueError):
        return 30


def probe_timeout(cfg):
    """상태 조회·취소 등 보조 호출 타임아웃(초). config의 probe_timeout, 기본 5."""
    cfg = resolve(cfg)
    try:
        return max(1, min(int(opt(cfg, "probe_timeout", 5)), TIMEOUT_MAX))
    except (TypeError, ValueError):
        return 5


EDITABLE_KEYS = ("base_url", "url", "model", "headers", "api_key_env", "timeout", "response_schema",
                 "extra_payload", "model_options", "models", "header_map", "probe_timeout",
                 "header", "body", "body_by_model", "rate", "etc", "poll_seconds",
                 "latency_scale", "token_scale")

# 모델별 추가 설정(요청 payload에 실리는 옵션). 해당 모델이 지원하지 않으면 목록이 비고,
# 프론트는 그 드롭다운을 비활성 상태로 둔다. config의 "model_options"로 덮어쓸 수 있다.
#   temperature      → payload["temperature"]
#   reasoning_effort → payload["reasoning_effort"]
# 이 환경의 기본 모델 목록. config의 "models"로 덮어쓸 수 있다(다른 게이트웨이 이식용).
DEFAULT_MODELS = ("fable", "opus", "sonnet", "haiku", "gpt-5.6", "gpt-5.5", "gpt-5.3", "o3")


def current_model(cfg=None):
    """이 설정이 쓰는 모델. body.model(스칼라)을 쓰면 최상위 model이 없어도 된다."""
    cfg = cfg or load_config()
    m = str(cfg.get("model") or "").strip()
    profs = profiles(cfg)
    if profs:
        return m if m in profs else next(iter(profs))
    if m:
        return m
    b = cfg.get("body")
    if isinstance(b, dict) and isinstance(b.get("model"), str) and b["model"].strip():
        return b["model"].strip()
    return "sonnet"


def allowed_models(cfg=None):
    """사용 가능한 모델 목록. config의 models가 있으면 그것을, 없으면 기본 목록을 쓴다.
    현재 model 값이 목록에 없으면 함께 포함해 설정만으로 새 모델을 쓸 수 있게 한다."""
    cfg = cfg or load_config()
    profs = profiles(cfg)
    if profs:
        return tuple(profs)  # 프로필 구성: 최상위 키 이름이 모델 목록이다
    ms = opt(cfg, "models")
    if isinstance(ms, list) and ms:
        out = [str(m) for m in ms]
    else:
        b = cfg.get("body")
        # body.model만 있는 3키 구성이면 그 모델 하나가 전부다
        if isinstance(b, dict) and isinstance(b.get("model"), str) and b["model"].strip():
            out = [b["model"].strip()]
        else:
            out = list(DEFAULT_MODELS)
    cur = current_model(cfg)
    if cur and cur not in out:
        out.insert(0, cur)
    return tuple(out)


DEFAULT_MODEL_OPTIONS = {
    "fable": {"temperature": ["0", "0.3", "0.7", "1"], "reasoning_effort": []},
    "opus": {"temperature": ["0", "0.3", "0.7", "1"], "reasoning_effort": []},
    "sonnet": {"temperature": ["0", "0.3", "0.7", "1"], "reasoning_effort": []},
    "haiku": {"temperature": ["0", "0.3", "0.7", "1"], "reasoning_effort": []},
    "gpt-5.6": {"temperature": [], "reasoning_effort": ["low", "medium", "high"]},
    "gpt-5.5": {"temperature": [], "reasoning_effort": ["low", "medium", "high"]},
    "gpt-5.3": {"temperature": [], "reasoning_effort": ["low", "medium", "high"]},
    "o3": {"temperature": [], "reasoning_effort": ["low", "medium", "high"]},
}


def body_spec(cfg=None, model=None):
    """요청 body에 실릴 항목. config의 body(공통) + body_by_model[model](모델별)을 합친다.
    값이 스칼라면 항상 그 값으로 전송하고, 배열이면 사용자가 고르는 선택지다(UI 드롭다운).
    구 키 extra_payload도 계속 읽는다(스칼라 취급)."""
    cfg = resolve(cfg if cfg is not None else load_config(), model)
    spec = {}
    legacy = cfg.get("extra_payload")
    if isinstance(legacy, dict):
        spec.update(legacy)
    common = cfg.get("body")
    if isinstance(common, dict):
        spec.update(common)
    per = cfg.get("body_by_model")
    if isinstance(per, dict) and model:
        m = per.get(str(model))
        if isinstance(m, dict):
            spec.update(m)
    spec.pop(DISABLED_KEY, None)  # 꺼둔 항목 — 적어만 두고 보내지 않는다
    return spec


def _range_of(v):
    """{"min":0,"max":1,"step":0.1} 형태면 범위 스펙으로 해석. 아니면 None."""
    if not isinstance(v, dict):
        return None
    if "min" not in v or "max" not in v:
        return None
    try:
        lo, hi = float(v["min"]), float(v["max"])
    except (TypeError, ValueError):
        return None
    try:
        step = float(v.get("step", 0.1))
    except (TypeError, ValueError):
        step = 0.1
    return {"kind": "range", "min": lo, "max": hi, "step": step if step > 0 else 0.1}


def choice_default(spec):
    """고르지 않았을 때 쓸 값. 범위는 가장 큰 값, 목록은 맨 뒤의 값이다
    (temperature 1, reasoning_effort high)."""
    if not isinstance(spec, dict):
        return None
    if spec.get("kind") == "enum":
        vals = spec.get("values") or []
        return vals[-1] if vals else None
    if spec.get("kind") == "range":
        return spec.get("max")
    return None


def body_choices(cfg=None, model=None):
    """사용자가 고르는 body 항목. {key: {"kind":"enum","values":[...],"default":...}
    | {"kind":"range","min","max","step","default":...}}
    스칼라 항목(항상 그 값으로 전송)은 여기 포함되지 않는다."""
    out = {}
    for k, v in body_spec(cfg, model).items():
        if isinstance(v, list) and v:
            out[k] = {"kind": "enum", "values": [str(x) for x in v]}
        else:
            rng = _range_of(v)
            if rng:
                out[k] = rng
    for spec in out.values():
        spec["default"] = choice_default(spec)
    return out


def choice_value(spec, chosen):
    """선택값을 실제 전송할 값으로 변환. 고르지 않았으면 기본값(가장 큰 값/맨 뒤 값),
    스펙에 맞지 않으면 None(미전송)."""
    if chosen in (None, ""):
        return choice_default(spec)
    if spec.get("kind") == "enum":
        for v in spec.get("values") or []:
            if str(v) == str(chosen):
                return v
        return None
    if spec.get("kind") == "range":
        try:
            x = float(chosen)
        except (TypeError, ValueError):
            return None
        if x < spec["min"] or x > spec["max"]:
            return None
        return x
    return None


def model_options(cfg=None):
    """모델별 선택 옵션 {model: {key: [값...]}}. body/body_by_model의 배열 항목에서 도출한다.
    config에 body가 없으면 기본 목록(DEFAULT_MODEL_OPTIONS)과 구 model_options를 쓴다."""
    cfg = cfg or load_config()
    models = allowed_models(cfg)
    profs = profiles(cfg)
    out = {}
    for m in models:
        rc = resolve(cfg, m)
        if profs or isinstance(rc.get("body"), dict) or isinstance(rc.get("body_by_model"), dict):
            out[str(m)] = body_choices(rc, m)
        else:
            base = DEFAULT_MODEL_OPTIONS.get(str(m)) or {}
            out[str(m)] = {k: {"kind": "enum", "values": [str(x) for x in v]}
                           for k, v in base.items() if v}
    # 구 model_options는 하위 호환으로 계속 덮어쓴다 (배열 = enum)
    override = cfg.get("model_options")
    if isinstance(override, dict):
        for m, opts in override.items():
            if not isinstance(opts, dict):
                continue
            cur = out.setdefault(str(m), {})
            for key, vals in opts.items():
                if isinstance(vals, list) and vals:
                    cur[str(key)] = {"kind": "enum", "values": [str(x) for x in vals]}
    # 어느 경로로 만들어졌든 기본값(가장 큰 값/맨 뒤 값)을 붙여 화면과 서버가 같은 값을 쓴다
    for opts in out.values():
        for spec in opts.values():
            spec["default"] = choice_default(spec)
    return out


def option_spec(model, key, cfg=None):
    return (model_options(cfg).get(str(model)) or {}).get(key)

# 이 환경에서는 사용하지 않지만 다른 환경 연동 시 쓰는 설정 — 값을 그대로 보존한다
# (빈 문자열도 유지; user_id/user_pw처럼 자리만 잡아두는 키가 있음)
PASSTHROUGH_KEYS = ("OPENAI_API_KEY", "credential_key", "send_system_name", "env_model",
                    "api_base_url", "user_id", "user_pw", "_비고",
                    "context_limit_tokens")  # 대화 탭 사용률 계산용 한계 토큰


def _header_dict(v):
    """저장용 header 정규화. 값은 문자열로 강제하되 disabled 블록은 중첩 객체 그대로 둔다."""
    out = {}
    for a, b in v.items():
        if not str(a).strip():
            continue
        if str(a) == DISABLED_KEY and isinstance(b, dict):
            out[str(a)] = {str(x): str(y) for x, y in b.items() if str(x).strip()}
        else:
            out[str(a)] = str(b)
    return out


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
        elif k in ("timeout", "probe_timeout"):
            try:
                out[k] = max(1, min(int(v), TIMEOUT_MAX))
            except (TypeError, ValueError):
                raise LLMError("E-2004", "%s는 정수(초)여야 함" % k, http=400)
        elif k == "response_schema":
            out[k] = bool(v)
        elif k == "models":
            if not isinstance(v, list):
                raise LLMError("E-2004", "models는 배열이어야 함", http=400)
            ms = [str(x).strip() for x in v if str(x).strip()]
            if ms:
                out[k] = ms
        elif k == "header":
            if not isinstance(v, dict):
                raise LLMError("E-2004", "header는 객체여야 함", http=400)
            hd = _header_dict(v)
            if hd:
                out[k] = hd
        elif k in ("body", "body_by_model"):
            if not isinstance(v, dict):
                raise LLMError("E-2004", "%s는 객체여야 함" % k, http=400)
            if v:
                out[k] = v
        elif k == "header_map":
            if not isinstance(v, dict):
                raise LLMError("E-2004", "header_map은 객체여야 함", http=400)
            hm = {str(a): str(b) for a, b in v.items() if str(b).strip()}
            if hm:
                out[k] = hm
        elif k == "model_options":
            if not isinstance(v, dict):
                raise LLMError("E-2004", "model_options는 객체여야 함", http=400)
            opts = {}
            for m, o in v.items():
                if not isinstance(o, dict):
                    continue
                opts[str(m)] = {key: [str(x) for x in o[key]]
                                for key in ("temperature", "reasoning_effort")
                                if isinstance(o.get(key), list)}
            if opts:
                out[k] = opts
        elif k == "rate":
            # 프로필이 없는 단일 구성에서 쓰는 최상위 rate. 프로필 구성이면 프로필 안의 것이 이긴다.
            if not isinstance(v, dict):
                raise LLMError("E-2004", "rate는 객체여야 함", http=400)
            if v:
                out[k] = v
        elif k == "etc":
            if not isinstance(v, dict):
                raise LLMError("E-2004", "etc는 객체여야 함", http=400)
            if v:
                out[k] = v
        elif k in ("headers", "extra_payload"):
            if not isinstance(v, dict):
                raise LLMError("E-2004", "%s는 객체여야 함" % k, http=400)
            if v:
                out[k] = {str(hk): (hv if k == "extra_payload" else str(hv)) for hk, hv in v.items()}
    for k in PASSTHROUGH_KEYS:
        if k in new_cfg and new_cfg[k] is not None:
            out[k] = str(new_cfg[k])
    # 모델 프로필(모델마다 온전한 url/header/body/rate/etc)은 통째로 보존한다.
    # 키 이름이 곧 모델 이름이다.
    for name, prof in profiles(new_cfg).items():
        p = {}
        if prof.get("url"):
            p["url"] = str(prof["url"]).strip()
        if isinstance(prof.get("header"), dict):
            p["header"] = _header_dict(prof["header"])
        if isinstance(prof.get("body"), dict):
            p["body"] = prof["body"]
        if isinstance(prof.get("rate"), dict):
            p["rate"] = prof["rate"]
        if isinstance(prof.get("etc"), dict):
            p["etc"] = prof["etc"]
        if not p.get("url"):
            raise LLMError("E-2004", "%s 프로필에 url이 필요함" % name, http=400)
        out[name] = p
    if not (profiles(out) or out.get("base_url") or out.get("url")):
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
    cfg = resolve(cfg if cfg is not None else load_config())
    if cfg.get("url"):
        return cfg["url"]
    # api_base_url은 게이트웨이 루트. 모델을 URL 경로가 아니라 요청 body의 model 필드로
    # 받는 환경이므로 모델 세그먼트를 끼워 넣지 않는다.
    gw = str(cfg.get("api_base_url") or "").strip().rstrip("/")
    if gw:
        if gw.endswith("/chat/completions"):
            return gw
        if gw.endswith("/v1"):
            return gw + "/chat/completions"
        return gw + "/v1/chat/completions"
    base = str(cfg.get("base_url", "")).rstrip("/")
    if not base:
        raise LLMError("E-2004", "llm.json에 base_url, api_base_url 또는 url 미설정")
    # llm-api는 모델별 독립 endpoint. 최상위 /v1/...는 response_format을 넘기지 않으므로
    # 구조화 출력을 위해 반드시 모델 경로를 쓴다.
    return "%s/%s/v1/chat/completions" % (base, current_model(cfg))


def _expand(value):
    """헤더 값의 자리표시자 치환. 요청마다 달라야 하는 상관관계 ID에 쓴다.
    {uuid} -> 새 UUID4, {uuid_hex} -> 하이픈 없는 UUID4, {ts} -> epoch 밀리초."""
    v = str(value)
    if "{" not in v:
        return v
    if "{uuid}" in v:
        v = v.replace("{uuid}", str(uuid.uuid4()))
    if "{uuid_hex}" in v:
        v = v.replace("{uuid_hex}", uuid.uuid4().hex)
    if "{ts}" in v:
        v = v.replace("{ts}", str(int(time.time() * 1000)))
    return v


def _headers(cfg):
    cfg = resolve(cfg)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    # 전달용 키(credential_key 등)를 헤더로: 값만 채우면 DEFAULT_HEADER_MAP 이름으로 전송되고,
    # 게이트웨이가 다른 이름을 쓰면 config의 header_map으로 그 키만 덮어쓴다.
    hmap = dict(DEFAULT_HEADER_MAP)
    if isinstance(cfg.get("header_map"), dict):
        hmap.update({str(k): str(v) for k, v in cfg["header_map"].items()})
    for src, name in hmap.items():
        val = cfg.get(str(src))
        if val not in (None, "") and str(name).strip():
            headers[str(name)] = str(val)
    # headers(구 이름) -> header(정규) 순으로 덮어쓴다. 이름과 값은 적은 그대로(대소문자 보존)
    for key in ("headers", "header"):
        extra = cfg.get(key)
        if isinstance(extra, dict):
            for k, v in extra.items():
                if str(k) == DISABLED_KEY:
                    continue  # 꺼둔 헤더 — 적어만 두고 보내지 않는다
                headers[str(k)] = _expand(v)
    key_env = opt(cfg, "api_key_env")
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
        if lk in ("authorization", "cookie") or any(
                t in lk for t in ("token", "key", "secret", "auth", "ticket", "credential", "passwd", "password", "pw")):
            out[k] = _mask(v)
        else:
            out[k] = v
    return out


def status():
    cfg = resolve(load_config())
    try:
        url = chat_url(cfg)
    except LLMError as e:
        url = "(미설정: %s)" % e.message
    return {
        "config_path": CONFIG_PATH,
        "url": url,
        "model": current_model(cfg),
        "timeout": req_timeout(cfg),
        "poll_seconds": poll_seconds(cfg),
        "response_schema": bool(opt(cfg, "response_schema")),
        "headers": masked_headers(cfg),
        "credentials": "environment" if cfg.get("api_key_env") else (
            "config-headers" if (cfg.get("headers") or cfg.get("header")) else "none"),
    }


class HttpResult(object):
    """_http() 결과. urllib.error.HTTPError를 대체한다."""

    def __init__(self, status, body, headers):
        self.status = status
        self.body = body
        self.headers = headers


# 진행 중인 요청의 소켓. 정지 버튼이 이걸 닫아 대기 중인 스레드를 즉시 깨운다.
# 플래그만 세우면 응답이 다 올 때까지 기다리게 되어 "실시간 정지"가 되지 않는다.
_INFLIGHT = {}
_INFLIGHT_LOCK = threading.Lock()


def abort(key):
    """진행 중인 요청을 소켓 단에서 끊는다. 끊었으면 True."""
    if not key:
        return False
    with _INFLIGHT_LOCK:
        conn = _INFLIGHT.get(str(key))
    if conn is None:
        return False
    try:
        conn.close()  # 대기 중인 getresponse()가 즉시 예외로 풀린다
        return True
    except Exception:
        return False


def _http(method, url, cfg, data=None, timeout=30, max_bytes=None, key=None):
    """요청 1회. urllib 대신 http.client를 쓰는 이유:
    urllib의 add_header가 헤더 이름을 capitalize()로 바꿔 x-dep-ticket -> X-dep-ticket,
    Send-System-Name -> Send-system-name 처럼 대소문자가 망가진다. 대소문자를 구분하는
    게이트웨이가 있어 설정에 적은 이름을 그대로 전송해야 한다."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise LLMError("E-2004", "지원하지 않는 URL scheme: %s" % (parts.scheme or "(없음)"))
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=timeout)
    if key:  # 정지 버튼이 찾아 닫을 수 있게 등록
        with _INFLIGHT_LOCK:
            _INFLIGHT[str(key)] = conn
    try:
        conn.request(method, path, body=data, headers=_headers(cfg))
        r = conn.getresponse()
        limit = (max_bytes + 1) if max_bytes else None
        raw = r.read(limit) if limit else r.read()
        return HttpResult(r.status, raw, dict(r.getheaders()))
    finally:
        if key:
            with _INFLIGHT_LOCK:
                if _INFLIGHT.get(str(key)) is conn:
                    _INFLIGHT.pop(str(key), None)
        conn.close()


def chat(system, user, schema=None, cfg=None, tag="CHAT", meta_out=None):
    """1회 blocking 호출 (system+user 2메시지). (content, usage, latency_ms) 반환."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return chat_messages(messages, schema=schema, cfg=cfg, tag=tag, meta_out=meta_out)


def chat_messages(messages, schema=None, cfg=None, tag="CHAT", meta_out=None, key=None):
    """임의 메시지 배열(다중 턴 대화 이력 포함)로 1회 blocking 호출.

    meta_out에 dict를 주면 실제 요청 정보(url, model, payload_bytes, response_format)를 채운다.
    """
    cfg = cfg or load_config()
    url = chat_url(cfg)
    payload = {
        "model": current_model(cfg),
        "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
    }
    if schema is not None and opt(cfg, "response_schema"):
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "llm_data", "schema": schema},
        }
    # body 스펙 적용: 스칼라는 항상 그 값으로, 배열은 사용자가 고른 값일 때만 싣는다.
    # 선택값은 호출부가 cfg에 넣어 준다(요청 -> chat_cfg_with_options -> cfg).
    choices = body_choices(cfg, payload["model"])
    for key, spec in body_spec(cfg, payload["model"]).items():
        if key == "model":
            continue  # 모델은 current_model()이 이미 정했다. 여기서 덮으면 화면의 모델 선택이 무시된다
        if key in choices:
            val = choice_value(choices[key], cfg.get(key))
            if val is not None:
                payload[key] = val
        else:
            payload[key] = spec

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if isinstance(meta_out, dict):
        meta_out.update({
            "method": "POST",
            "url": url,
            "model": payload["model"],
            "payload_bytes": len(body),
            "response_format": "response_format" in payload,
            "timeout_s": req_timeout(cfg),
            "headers": masked_headers(cfg),  # 토큰류는 마스킹된 상태
            "payload": payload,              # 실제 전송 body 전문
        })
    timeout = req_timeout(cfg)
    _log_mod.log("LLM", "-> %s POST %s | body %d bytes | response_format=%s | timeout=%ds"
                  % (tag, url, len(body), "YES" if "response_format" in payload else "no", timeout))
    started = time.time()
    try:
        res = _http("POST", url, cfg, data=body, timeout=timeout,
                    max_bytes=MAX_RESPONSE_BYTES, key=key)
    except LLMError:
        raise
    except Exception as e:
        elapsed = time.time() - started
        _log_mod.log("LLM", "[X] %s 실패 | %.1fs | %s | %s: %s" % (tag, elapsed, url, type(e).__name__, e))
        raise LLMError("E-2001", "LLM 전송 실패(%.0fs 경과, %s): %s" % (elapsed, type(e).__name__, e))
    if res.status >= 400:
        detail = ""
        err_type = ""
        try:
            eb = json.loads(res.body.decode("utf-8", "replace"))
            detail = str(eb.get("error", {}).get("message", ""))[:220]
            err_type = str(eb.get("error", {}).get("type", ""))
        except Exception:
            detail = res.body.decode("utf-8", "replace")[:220]
        elapsed = time.time() - started
        _log_mod.log("LLM", "[X] %s 실패 | %.1fs | HTTP %s %s | %s" % (tag, elapsed, res.status, err_type, detail))
        if res.status == 401 or err_type == "auth_expired":
            raise LLMError("E-2007", "LLM 인증 만료/실패: %s" % (detail or res.status))
        http = res.status if 400 <= res.status <= 599 else 502
        raise LLMError("E-2001", "LLM HTTP %s (%s): %s" % (res.status, err_type or "?", detail), http=http)
    raw = res.body

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
    _log_mod.log("LLM", "<- %s HTTP 200 | %.2fs | %d bytes" % (tag, latency_ms / 1000.0, len(raw)))
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
    cfg = resolve(cfg if cfg is not None else load_config())
    explicit = cfg.get("url") or cfg.get("api_base_url")
    if not explicit:
        return str(cfg.get("base_url", "")).rstrip("/")
    u = str(explicit).rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if u.endswith(suffix):
            return u[:-len(suffix)]
    parts = urlsplit(u)
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def cancel(cfg=None):
    """실행 중 호출 취소 (llm-api POST /cancel). 실패해도 무시하는 best-effort."""
    cfg = cfg or load_config()
    try:
        res = _http("POST", _api_root(cfg) + "/cancel", cfg, data=b"{}", timeout=probe_timeout(cfg))
        if res.status >= 400:
            return {"cancelled": False}
        return json.loads(res.body.decode("utf-8"))
    except Exception:
        return {"cancelled": False}


def configured_services(cfg=None):
    """설정(llm.json)만으로 만드는 모델 목록. 상태 조회가 실패해도 이 목록은 항상 나온다.
    게이트웨이 환경은 모델 목록 API가 없으므로 설정이 유일한 출처다."""
    cfg = cfg or load_config()
    opts = model_options(cfg)
    out = []
    for m in allowed_models(cfg):
        rc = resolve(cfg, m)
        try:
            endpoint = chat_url(rc)
        except LLMError as e:
            endpoint = "(미설정: %s)" % e.message
        out.append({
            "id": str(m), "label": str(m), "model": current_model(rc),
            "backend": None, "tier": None, "note": None, "enabled": True,
            "timeout": req_timeout(rc), "max_inflight": None,
            "endpoint": endpoint, "source": "config",
            "health": None, "ok": None, "err": None,
            "ewma_latency_ms": None, "last_error": None,
            "options": opts.get(str(m)) or {},
        })
    return out


def upstream_services(cfg=None):
    """모델 카드용 상세 목록. 기본은 설정의 모델이고, 상태 조회(llm-api)가 되면 그 정보를 덧붙인다.
    각 항목만으로 해당 LLM과 대화 가능한 정보(endpoint·timeout 등)를 담는다."""
    cfg = cfg or load_config()
    base = configured_services(cfg)
    try:
        root = _api_root(cfg)
        res = _http("GET", root + "/api/health", cfg, timeout=probe_timeout(cfg))
        if res.status >= 400:
            raise LLMError("E-2001", "HTTP %s" % res.status)
        h = json.loads(res.body.decode("utf-8"))
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
        # 설정 목록을 기준으로 상태를 덮어쓴다. 설정에 없고 상태에만 있는 모델도 함께 보인다.
        by_id = {str(x["id"]): x for x in base}
        for live in out:
            cur = by_id.get(str(live.get("id")))
            if cur is None:
                live["source"] = "upstream"
                base.append(live)
                by_id[str(live.get("id"))] = live
            else:
                cur.update({k: v for k, v in live.items() if v is not None})
                cur["source"] = "config+upstream"
        return {"reachable": True, "auth": (h.get("auth") or {}).get("state"),
                "headers": masked_headers(cfg), "models": base}
    except Exception as e:
        # 상태 조회 실패는 설정 목록까지 감추지 않는다 (게이트웨이는 목록 API가 없는 것이 정상)
        return {"reachable": False, "error": "%s: %s" % (type(e).__name__, e),
                "headers": masked_headers(cfg), "models": base}


def _safe_chat_url(cfg):
    try:
        return chat_url(cfg)
    except LLMError as e:
        return "(미설정: %s)" % e.message


def upstream_health(cfg=None):
    """업스트림 상태 요약 (프론트 상태 표시용).
    llm-api는 /api/health로 상세를 주지만 게이트웨이에는 그런 API가 없다.
    HTTP 응답이 오기만 하면 연결 자체는 살아 있는 것이므로 probe만 unsupported로 표시한다.
    연결이 실제로 안 되는 경우(DNS·타임아웃·거부)만 reachable:false다."""
    cfg = resolve(cfg or load_config())
    try:
        url = _api_root(cfg) + "/api/health"
        res = _http("GET", url, cfg, timeout=probe_timeout(cfg))
        if res.status >= 400:
            # 상태 API가 없는 환경 — 연결 실패로 표시하지 않는다
            return {"reachable": True, "probe": "unsupported", "probe_status": res.status,
                    "model": current_model(cfg), "url": _safe_chat_url(cfg)}
        try:
            h = json.loads(res.body.decode("utf-8"))
        except ValueError:
            return {"reachable": True, "probe": "unsupported",
                    "model": current_model(cfg), "url": _safe_chat_url(cfg)}
        if not isinstance(h, dict) or "executor" not in h:
            return {"reachable": True, "probe": "unsupported",
                    "model": current_model(cfg), "url": _safe_chat_url(cfg)}
        return {
            "reachable": True,
            "probe": "ok",
            "auth": (h.get("auth") or {}).get("state"),
            "executor": {
                "running": (h.get("executor") or {}).get("running"),
                "model": (h.get("executor") or {}).get("model"),
                "queued": (h.get("executor") or {}).get("queued"),
            },
        }
    except Exception as e:
        return {"reachable": False, "probe": "failed", "model": current_model(cfg),
                "url": _safe_chat_url(cfg), "error": "%s: %s" % (type(e).__name__, e)}
