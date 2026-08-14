# -*- coding: utf-8 -*-
"""서버 전체의 모델별 요청 rate와 토큰 처리량 (sliding window).

누가 보고 있든 이 서버가 받은 모든 요청을 센다 — 개인 사용량이 아니라 서버 부하 지표다.
둘 다 분당 rate로 보여 준다. 다만 창 길이가 다르다 — 요청은 짧은 창으로 지금 붐비는지를,
토큰은 긴 창으로 처리량의 추세를 본다. 둘 다 sliding window라 창 밖의 기록은 버려진다.

설정은 config/server.json의 rate 블록에서 읽는다. 아래 DEFAULTS는 설정 파일이 없을 때만
쓰는 출발점이고, server.json에 적은 값이 언제나 이긴다.

    "rate": {
      "request_window_s": 300,
      "token_window_s": 600,
      "poll_seconds": 5,
      "keep": 20000,
      "request_scale": {"min": 0.05, "max": 30},
      "token_scale": {"min": 50, "max": 20000}
    }

이 모듈은 다른 모듈을 import하지 않는다. 통째로 떼어 다른 서비스에 붙일 수 있다.
"""

import json
import os
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("LLM_DATA_SERVER_CONFIG") or os.path.join(ROOT, "config", "server.json")
CONFIG_KEY = "rate"

# 설정 파일이 없을 때의 출발점. 값의 정의는 server.json.example에 적어 둔다.
DEFAULTS = {
    "request_window_s": 300,      # 요청 rate 창 (초)
    "token_window_s": 600,        # 토큰 처리량 창 (초)
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

_CFG = {"data": None, "mtime": None}


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


def config(force=False):
    """server.json의 rate 블록. 파일이 바뀌면 다시 읽는다(재기동 없이 반영)."""
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        mtime = None
    if not force and _CFG["data"] is not None and _CFG["mtime"] == mtime:
        return _CFG["data"]

    raw = {}
    if mtime is not None:
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                doc = json.load(f)
            if isinstance(doc, dict) and isinstance(doc.get(CONFIG_KEY), dict):
                raw = doc[CONFIG_KEY]
        except (OSError, ValueError):
            raw = {}   # 설정이 깨져도 지표 때문에 서버가 멈추면 안 된다

    out = {k: _clamp(k, raw.get(k, DEFAULTS[k])) for k in _LIMITS}
    out["request_scale"] = _scale(raw.get("request_scale"), DEFAULTS["request_scale"])
    out["token_scale"] = _scale(raw.get("token_scale"), DEFAULTS["token_scale"])
    _CFG["data"], _CFG["mtime"] = out, mtime
    return out


def _push(store, model, item, keep):
    q = store.setdefault(str(model or "?"), [])
    q.append(item)
    if len(q) > keep:
        del q[:-keep]


def record_request(model):
    """LLM 요청 1건. 화면 표시용이라 실패해도 조용히 넘어간다."""
    try:
        cfg = config()
        with _LOCK:
            _push(_REQ, model, time.time(), cfg["keep"])
    except Exception:
        pass


def record_tokens(model, tokens):
    """응답으로 오간 토큰 수. usage가 없으면 기록하지 않는다."""
    try:
        n = int(tokens or 0)
        if n <= 0:
            return
        cfg = config()
        with _LOCK:
            _push(_TOK, model, (time.time(), n), cfg["keep"])
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
    """모델별 최근 rate. 요청이 많은 순으로 돌려준다."""
    cfg = config()
    now = time.time()
    rcut = now - cfg["request_window_s"]
    tcut = now - cfg["token_window_s"]
    rows = {}
    with _LOCK:
        for model, q in list(_REQ.items()):
            fresh = [t for t in q if t >= rcut]
            _REQ[model] = fresh                     # 창 밖은 버린다
            if fresh:
                rows.setdefault(model, {})["requests"] = len(fresh)
        for model, q in list(_TOK.items()):
            fresh = [(t, n) for (t, n) in q if t >= tcut]
            _TOK[model] = fresh
            if fresh:
                rows.setdefault(model, {})["tokens"] = sum(n for (_, n) in fresh)

    out = []
    for model, r in rows.items():
        req, tok = r.get("requests", 0), r.get("tokens", 0)
        out.append({
            "model": model,
            "requests": req,
            "rpm": round(req * 60.0 / cfg["request_window_s"], 2),
            "tokens": tok,
            "tpm": round(tok * 60.0 / cfg["token_window_s"], 2),
        })
    out.sort(key=lambda r: (-r["rpm"], -r["tpm"], r["model"]))
    return {
        "rates": out,
        "window": {"request_s": cfg["request_window_s"], "token_s": cfg["token_window_s"]},
        "poll_seconds": cfg["poll_seconds"],
        "scale": {"request": cfg["request_scale"], "token": cfg["token_scale"]},
    }
