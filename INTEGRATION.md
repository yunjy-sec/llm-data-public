# 접목 가이드 — 이 repo를 다른 LLM 백엔드에 연결하기

이 서비스의 LLM 접점은 `llm.py` **하나**다. 기본값은 OpenAI 호환 endpoint
(`base_url + /{model}/v1/chat/completions`, 또는 `url`로 전체 endpoint 직접 지정)이며,
설정은 화면의 **0번 설정 탭** 또는 `config/llm.json`(실제 경로는 헤더 ⚙ 참고 — PERSIST 영역)에서 관리한다.
같은 내용을 화면 헤더의 ℹ 버튼으로도 볼 수 있다.

## 구동 방법

의존성이 없다(Python 표준 라이브러리만 사용). 설치 단계 없이 바로 띄운다.

```bash
python server.py --host 127.0.0.1 --port 8821
```

브라우저에서 `http://127.0.0.1:8821` 을 연다. 프론트엔드는 별도 빌드가 없다 —
서버가 `web/`을 그대로 서빙하므로 파일을 고치고 새로고침하면 끝이다.

| 방법 | 명령 | 비고 |
|---|---|---|
| 로컬 | `python server.py --host 127.0.0.1 --port 8821` | 데이터는 `<repo>/data` |
| 외부 접근 | `python server.py --host 0.0.0.0 --port 8821` | 프록시 뒤에 둘 때는 stripPrefix 방식 |
| 컨테이너 | `docker compose up -d --build` | PERSIST 볼륨 마운트 — `DEPLOY.md` |

첫 기동 후 **0번 설정 탭**에서 `base_url`을 LLM 서버 위치로 맞추면 바로 변환·대화가 동작한다.
상단 상태 표시줄의 LLM 상태가 "연결됨"으로 바뀌는지로 확인한다.

## 대표 파일

| 구분 | 파일 | 역할 |
|---|---|---|
| 백엔드 | `server.py` | HTTP 서버·전체 API·잡 큐·데이터셋/마스터/대화 저장. 저장 경로 상수(`DATA_DIR`·`JOBS_DIR`)가 상단에 있다 |
| 백엔드 | `llm.py` | **LLM 접점 전부** — endpoint 조립(`chat_url`)·헤더(`_headers`)·요청/파싱(`chat_messages`)·설정 로드·저장. 접목 시 여기만 고친다 |
| 프론트 | `web/index.html` | 탭·패널 구조와 요소 id |
| 프론트 | `web/app.js` | 모든 화면 로직 (변환·데이터셋·마스터·대화·라우팅). 빌드 없는 순수 JS |
| 프론트 | `web/styles.css` | 테마 변수(light/dark)와 전체 스타일 |
| 프론트 | `web/sheet.html` | Luckysheet 격리 iframe (표 편집) |
| 설정 | `config/llm.json.example` | 설정 키 예시 — 복사해 `llm.json`으로 쓴다 (실제 파일은 커밋 금지) |
| 프롬프트 | `prompts/table_to_schema.md` | 변환 시스템 프롬프트. `{{TARGET_SCHEMA}}` 자리에 목표 스키마가 치환된다 |

## 경로 설정 방법

### 1) LLM endpoint 경로 — 0번 설정 탭

설정 탭의 JSON을 고치고 **저장**하면 다음 요청부터 적용된다(재기동 불필요).

- 모델별 경로 규칙을 쓰는 서버: `base_url`만 지정 → `{base_url}/{model}/v1/chat/completions` 로 조립된다.
- 경로 규칙이 다른 게이트웨이: `url`에 **전체 endpoint**를 직접 넣는다. 이 값이 있으면 `base_url`·모델 경로 조립은 무시된다.
- 지금 실제로 어떤 URL로 나가는지는 상단 상태 표시줄과 `GET /api/health`, 그리고 변환 이력·대화 탭의 **요청 전문**(마스킹된 headers 포함)에서 확인한다.

### 2) 저장 경로 — 환경변수

코드 수정 없이 env로 옮긴다. 미설정 시 모두 `<repo>/data` 를 쓴다(로컬 개발 기본값).

| 환경변수 | 지정 대상 | 예 |
|---|---|---|
| `LLM_DATA_PERSIST` | 데이터셋·저장본(exports)·대화·프로젝트·마스터·편집 로그·사용자 설정/프롬프트 (**유지 필요**) | `/srv/llm-data/data` |
| `LLM_DATA_RUNTIME` | 변환 작업 이력 (**유실 허용**) | `/var/tmp/llm-data` |
| `LLM_DATA_CONFIG` | 설정 파일 경로를 개별 지정할 때 (PERSIST보다 우선) | `/etc/llm-data/llm.json` |

```bash
LLM_DATA_PERSIST=/srv/llm-data/data LLM_DATA_RUNTIME=/var/tmp/llm-data python server.py --host 0.0.0.0 --port 8821
```

> **운영·CI/CD 환경에서는 `LLM_DATA_PERSIST`·`LLM_DATA_RUNTIME` 지정이 필수다.** 미지정 시 데이터가
> 코드 디렉터리 아래(`<repo>/data`)에 쌓여, 릴리스 디렉터리를 교체하는 배포나 앱 디렉터리를 read-only로
> 두는 환경에서 유실·저장 실패로 이어진다. env 미설정은 로컬 개발 전용이다.

env 미설정 시 실제 경로는 PERSIST 대상 전부가 `<repo>/data` 아래이고, **LLM 설정만 `<repo>/config/llm.json`**
이다(git 추적 제외). 사용자 프롬프트 저장본은 항상 PERSIST 아래에 기록되므로 코드의 기본 프롬프트 파일을
덮어쓰지 않는다.

현재 인스턴스에 실제로 적용된 경로는 헤더 **⚙ 버튼**(저장 영역) 또는 `GET /api/storage`로 확인한다 —
각 영역의 root와 env 적용 여부가 표시되고, env가 빠져 있으면 경고가 함께 표시된다.
영역 구분의 배경은 `DEPLOY.md`에 있다.

## 동작 키 — 기본 구현이 직접 사용

| 키 | 의미 |
|---|---|
| `base_url` | OpenAI 호환 서버 루트. 모델별 경로가 자동으로 붙는다 |
| `url` | 전체 endpoint를 직접 지정할 때 (`base_url` 무시) |
| `model` | 요청 payload의 `model` 값 |
| `headers` | 요청에 그대로 합쳐지는 헤더 — token은 여기 `Authorization`에 둔다 |
| `api_key_env` | token을 환경변수 이름으로 줄 때 |
| `response_schema` | 구조화 출력(response_format json_schema) 강제 여부 — **미지원 모델이면 false 유지** |
| `timeout`, `extra_payload` | 요청 타임아웃 · payload 추가 필드 |

## 전달(passthrough) 키 — 게이트웨이 접목 지점

아래 키는 설정에 **저장·표시만** 되고, 기본 구현은 `OPENAI_API_KEY`만 `Authorization: Bearer`로 쓴다.
API 게이트웨이를 거쳐야 하는 시스템(자격 티켓·시스템 식별자·계정 발급 토큰을 요구하는 형태)에 접목할 때
`llm.py`의 `chat_url()`과 `_headers()`에서 매핑한다.

| 키 | 접목 방법 |
|---|---|
| `api_base_url` | 게이트웨이 루트 → `chat_url()`이 이 값을 쓰게 하거나, `url`에 전체 endpoint를 기입 |
| `env_model` | 게이트웨이가 요구하는 모델 이름 → payload의 `model`로 매핑 |
| `credential_key` | 자격 티켓 (예: `credential:TICKET-…`) → 게이트웨이가 요구하는 헤더로 전달 |
| `send_system_name` | 호출 시스템 식별자 → 게이트웨이가 요구하는 헤더/필드로 전달 |
| `user_id` / `user_pw` | 토큰 발급형 게이트웨이용 → 발급 API 호출 후 `Authorization` 설정 |
| `OPENAI_API_KEY` | 표준 Bearer token — 기본 구현이 그대로 사용 |

## `_headers()` 확장 예시

```python
def _headers(cfg):
    headers = {"Content-Type": "application/json"}
    if cfg.get("credential_key"):
        headers["X-Credential"] = cfg["credential_key"]
    if cfg.get("send_system_name"):
        headers["X-System-Name"] = cfg["send_system_name"]
    if cfg.get("user_id") and cfg.get("user_pw"):
        headers["Authorization"] = "Bearer " + issue_token(
            cfg["api_base_url"], cfg["user_id"], cfg["user_pw"])
    return headers
```

`chat_url()`을 바꿀 때는 게이트웨이의 실제 chat completions 경로를 반환하게 하면 된다.
모델별 경로가 없는 게이트웨이라면 `url` 키에 전체 endpoint를 넣는 쪽이 코드 수정 없이 가장 빠르다.

## 접목 시 유의

- token이 들어가는 `config/llm.json`은 repo에 커밋하지 않는다(.gitignore 처리됨). 배포 시 PERSIST 볼륨에 둔다 — `DEPLOY.md` 참고.
- 요청·응답 **전문**(마스킹된 headers 포함)이 변환 작업 이력과 대화 탭에 항상 표시되므로 접목 디버깅에 그대로 쓸 수 있다.
- 구조화 출력을 지원하지 않는 모델을 쓰는 환경이면 `response_schema=false`(기본값)를 유지해야 한다 — 파서는 코드 fence·설명문이 섞인 응답도 관대하게 처리한다.
