"""서버 실행 진입점 (stdlib only).

    python run_server.py

옵션을 매번 손으로 적지 않아도 되게 만든 실행기다. 값은 하드코딩하지 않고 아래 순서로 찾는다.

    명령행 인자  >  환경변수  >  config/server.json  >  기본값

config/server.json (없으면 만들지 않아도 된다)

    {
      "host": "0.0.0.0",
      "port": 8821,
      "persist": "/srv/llm-data/data",
      "runtime": "/var/tmp/llm-data",
      "config": "/etc/llm-data/llm.json",
      "sso_config": "/etc/llm-data/sso.json",
      "access_config": "/etc/llm-data/access.json",
      "etc": { "설명": "여기 적은 값은 환경변수로 설정된 뒤 서버가 뜬다" }
    }

persist·runtime·config 경로는 환경변수로 넘겨야 server.py가 읽으므로, 여기서 적힌 값을
os.environ에 넣고 서버를 띄운다. 이미 환경변수가 있으면 그 값을 그대로 둔다.
"""

import argparse
import json
import os
import sys

import log as _log_mod

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("LLM_DATA_SERVER_CONFIG") or os.path.join(ROOT, "config", "server.json")

# 기본은 0.0.0.0 — 다른 PC의 브라우저에서 접속해야 하는 서비스다.
# 내 PC에서만 열려면 config/server.json의 host를 127.0.0.1로 적는다.
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8821

# config/server.json의 키 -> server.py가 읽는 환경변수
ENV_KEYS = {
    "persist": "LLM_DATA_PERSIST",
    "runtime": "LLM_DATA_RUNTIME",
    "config": "LLM_DATA_CONFIG",
    "sso_config": "LLM_DATA_SSO_CONFIG",
    "access_config": "LLM_DATA_ACCESS_CONFIG",
}


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except OSError:
        return {}
    except ValueError as e:
        _log_mod.log("run", "%s 를 읽지 못했습니다 (JSON 오류): %s" % (CONFIG_PATH, e))
        return {}


def pick(cli, env_name, cfg, key, default):
    """명령행 > 환경변수 > 설정파일 > 기본값."""
    if cli is not None:
        return cli
    if env_name and os.environ.get(env_name):
        return os.environ[env_name]
    if key in cfg and str(cfg[key]).strip():
        return cfg[key]
    return default


def main():
    ap = argparse.ArgumentParser(description="llm-data 서버 실행")
    ap.add_argument("--host", default=None, help="바인드 주소 (기본 %s)" % DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=None, help="포트 (기본 %d)" % DEFAULT_PORT)
    args = ap.parse_args()

    cfg = load_config()

    # 저장 경로 등은 환경변수로 넘겨야 server.py가 읽는다. 이미 있으면 건드리지 않는다.
    for key, env_name in ENV_KEYS.items():
        val = str(cfg.get(key) or "").strip()
        if val and not os.environ.get(env_name):
            os.environ[env_name] = val

    host = str(pick(args.host, "LLM_DATA_HOST", cfg, "host", DEFAULT_HOST))
    try:
        port = int(pick(args.port, "LLM_DATA_PORT", cfg, "port", DEFAULT_PORT))
    except (TypeError, ValueError):
        _log_mod.log("run", "port 값이 숫자가 아닙니다. 기본값 %d로 띄웁니다." % DEFAULT_PORT)
        port = DEFAULT_PORT

    if not os.environ.get("LLM_DATA_PERSIST") or not os.environ.get("LLM_DATA_RUNTIME"):
        # 운영에서 이게 비면 데이터가 코드 디렉터리 아래에 쌓인다 — DEPLOY.md 참고
        _log_mod.log("run", "LLM_DATA_PERSIST / LLM_DATA_RUNTIME 미설정 — 데이터를 <repo>/data 아래에 "
                     "둡니다 (로컬 개발 전용). config/server.json의 persist·runtime으로 지정할 수 있습니다.")

    # 리다이렉트해도 바로 보이도록 여기서 한 줄 남긴다 (server.py의 print는 버퍼링된다)
    _log_mod.log("run", "http://%s:%d 로 띄웁니다 (설정 %s)"
                 % (host, port, CONFIG_PATH if os.path.exists(CONFIG_PATH) else "없음 — 기본값"))
    sys.argv = [sys.argv[0], "--host", host, "--port", str(port)]
    import server  # 환경변수를 다 채운 뒤에 import해야 저장 경로 상수가 그 값으로 잡힌다
    server.main()


if __name__ == "__main__":
    main()
