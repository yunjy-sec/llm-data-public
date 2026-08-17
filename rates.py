# -*- coding: utf-8 -*-
"""서버 전체의 모델별 요청 rate와 토큰 rate (sliding window).

누가 보고 있든 이 서버가 받은 모든 요청을 센다 — 개인 사용량이 아니라 서버 부하 지표다.
둘 다 분당 rate로 보여 주지만 창 길이는 모델마다 다르다. 빠른 모델과 오래 걸리는 모델을
같은 창으로 재면 한쪽은 늘 0에 가깝고 다른 쪽은 계속 붐벼 보이기 때문이다.
sliding window라 창 밖으로 나간 기록은 셀 때 버려진다.

설정이 어디 사는지는 이 모듈이 알지 않는다. 호출자가 set_config_source()로
"모델 이름 -> rate 설정(dict)" 함수를 꽂아 준다. 이 서비스에서는 llm.json의
모델 프로필 안 rate 블록이고, 다른 서비스에 떼어 갈 때는 다른 것을 꽂으면 된다.
아래 DEFAULTS는 설정이 없을 때의 출발점이다.

    "gpt-oss-120b": {
      "url": ..., "header": {...}, "body": {...},
      "rate": {
        "request_window_s": 300,
        "token_window_s": 600,
        "poll_seconds": 5,
        "keep": 20000,
        "request_scale": {"min": 0.05, "max": 30},
        "token_scale": {"min": 50, "max": 20000}
      },
      "etc": {...}
    }
"""

import threading
import time

DEFAULTS = {
    "request_window_s": 300,      # 요청 rate 창 (초)
    "token_window_s": 600,        # 토큰 rate 창 (초)
    "poll_seconds": 5,            # 화면이 다시 물어보는 주기 (초)
    "keep": 20000,                # 모델당 보관 상한 — 폭주해도 메모리가 늘지 않게
    "request_scale": {"min": 0.05, "max": 30},   # 색 스케일: 분당 요청 수
    "token_scale": {"min": 50, "max": 20000},    # 색 스케일: 분당 토큰
}

_LIMITS = {  # 설정값이 터무니없을 때의 한계 (창이 0이면 나눗셈이 깨진다)
    "request_window_s": (5, 86400),
    "token_window_s": (5, 86400),
    "poll_seconds": (1, 3600),
    "keep": (100, 1000000),
}

_LOCK = threading.Lock()
_REQ = {}     # model -> [ts, ...]
_TOK = {}     # model -> [(ts, tokens), ...]

_SOURCE = None


def set_config_source(fn):
    """모델 이름을 받아 그 모델의 rate 설정(dict)을 돌려주는 함수를 꽂는다."""
    global _SOURCE
    _SOURCE = fn


def _raw(model):
    if _SOURCE is None:
        return {}
    try:
        got = _SOURCE(model)
    except Exception:
        return {}      # 설정을 못 읽어도 지표 때문에 서버가 멈추면 안 된다
    return got if isinstance(got, dict) else {}


def _clamp(key, val):
    lo, hi = _LIMITS[key]
    try:
        return max(lo, min(int(val), hi))
    except (TypeError, ValueError):
        return DEFAULTS[key]


def _scale(got, default):
    """색 스케일 {min, max}. log로 매핑하므로 min은 0보다 커야 한다."""
    out = dict(default)
    if isinstance(got, dict):
        for k in ("min", "max"):
            if k in got:
                try:
                    out[k] = float(got[k])
                except (TypeError, ValueError):
                    pass
    if not (out["min"] > 0):
        out["min"] = default["min"]
    if out["max"] <= out["min"]:
        out["max"] = default["max"]
    return out


def config(model):
    """그 모델의 rate 설정. 적히지 않은 값은 기본값으로 메운다."""
    raw = _raw(model)
    out = {k: _clamp(k, raw.get(k, DEFAULTS[k])) for k in _LIMITS}
    out["request_scale"] = _scale(raw.get("request_scale"), DEFAULTS["request_scale"])
    out["token_scale"] = _scale(raw.get("token_scale"), DEFAULTS["token_scale"])
    return out


def _push(store, model, item, keep):
    q = store.setdefault(str(model or "?"), [])
    q.append(item)
    if len(q) > keep:
        del q[:-keep]


def record_request(model):
    """LLM 요청 1건. 화면 표시용이라 실패해도 조용히 넘어간다."""
    try:
        keep = config(model)["keep"]
        with _LOCK:
            _push(_REQ, model, time.time(), keep)
    except Exception:
        pass


def record_tokens(model, tokens):
    """응답으로 오간 토큰 수. 0 이하면 기록하지 않는다."""
    try:
        n = int(tokens or 0)
        if n <= 0:
            return
        keep = config(model)["keep"]
        with _LOCK:
            _push(_TOK, model, (time.time(), n), keep)
    except Exception:
        pass


def record_usage(model, usage):
    """LLM usage 딕셔너리에서 총 토큰을 뽑아 기록한다."""
    u = usage if isinstance(usage, dict) else {}
    total = u.get("total_tokens")
    if not total:
        total = (u.get("prompt_tokens") or 0) + (u.get("completion_tokens") or 0)
    record_tokens(model, total)


def snapshot():
    """모델별 최근 rate. 창과 색 범위가 모델마다 다르므로 각 행에 함께 실어 보낸다."""
    now = time.time()
    models = set()
    with _LOCK:
        models.update(_REQ.keys())
        models.update(_TOK.keys())

    out = []
    polls = []
    for model in sorted(models):
        c = config(model)
        polls.append(c["poll_seconds"])
        rcut, tcut = now - c["request_window_s"], now - c["token_window_s"]
        with _LOCK:
            req = [t for t in _REQ.get(model, []) if t >= rcut]
            tok = [(t, n) for (t, n) in _TOK.get(model, []) if t >= tcut]
            if model in _REQ:
                _REQ[model] = req          # 창 밖은 버린다
            if model in _TOK:
                _TOK[model] = tok
        if not req and not tok:
            continue
        total = sum(n for (_, n) in tok)
        out.append({
            "model": model,
            "requests": len(req),
            "rpm": round(len(req) * 60.0 / c["request_window_s"], 2),
            "tokens": total,
            "tpm": round(total * 60.0 / c["token_window_s"], 2),
            "window": {"request_s": c["request_window_s"], "token_s": c["token_window_s"]},
            "scale": {"request": c["request_scale"], "token": c["token_scale"]},
        })
    out.sort(key=lambda r: (-r["rpm"], -r["tpm"], r["model"]))
    # 주기도 모델마다 적을 수 있다 — 화면은 하나뿐이므로 가장 짧은 주기를 따른다
    return {"rates": out, "poll_seconds": min(polls) if polls else DEFAULTS["poll_seconds"]}
