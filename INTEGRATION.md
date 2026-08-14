# 접목 가이드 — 이 repo를 다른 LLM 백엔드에 연결하기

이 서비스의 LLM 접점은 `llm.py` **하나**다. 기본값은 OpenAI 호환 endpoint
(`base_url + /{model}/v1/chat/completions`, 게이트웨이는 `api_base_url`, 또는 `url`로 직접 지정)이며,
설정은 화면의 **0번 설정 탭** 또는 `config/llm.json`(실제 경로는 헤더 ⚙ 참고 — PERSIST 영역)에서 관리한다.
같은 내용을 화면 헤더의 ℹ 버튼으로도 볼 수 있다.

## 구동 방법

의존성이 없다(Python 표준 라이브러리만 사용). 설치 단계 없이 바로 띄운다.

```bash
python run_server.py
```

기본은 `0.0.0.0:8821`이라 다른 PC의 브라우저에서도 접속된다. 프론트엔드는 별도 빌드가 없다 —
서버가 `web/`을 그대로 서빙하므로 파일을 고치고 새로고침하면 끝이다.

값은 하드코딩하지 않는다. **명령행 인자 > 환경변수 > `config/server.json` > 기본값** 순으로 찾는다.

| 방법 | 명령 | 비고 |
|---|---|---|
| 그냥 실행 | `python run_server.py` | `config/server.json`이 있으면 그 값으로 |
| 포트만 바꿔서 | `python run_server.py --port 9000` | 인자가 가장 우선 |
| 내 PC에서만 | `python run_server.py --host 127.0.0.1` | 또는 `server.json`의 `host` |
| 컨테이너 | `docker compose up -d --build` | PERSIST 볼륨 마운트 — `DEPLOY.md` |

`config/server.json`에 `persist`·`runtime`·`config`·`sso_config`·`access_config`를 적으면
`run_server.py`가 환경변수로 넣어 준 뒤 서버를 띄운다. 예시는 `config/server.json.example`에 있다.
`python server.py --host ... --port ...`로 직접 띄우는 방식도 그대로 동작한다.

첫 기동 후 **0번 설정 탭**에서 `base_url`을 LLM 서버 위치로 맞추면 바로 변환·대화가 동작한다.
상단 상태 표시줄의 LLM 상태가 "연결됨"으로 바뀌는지로 확인한다.

## 대표 파일

| 구분 | 파일 | 역할 |
|---|---|---|
| 실행 | `run_server.py` | `python run_server.py` 진입점. host·port·저장 경로를 설정에서 찾아 넣고 서버를 띄운다 |
| 백엔드 | `server.py` | HTTP 서버·전체 API·잡 큐·데이터셋/마스터/대화 저장. 저장 경로 상수(`DATA_DIR`·`JOBS_DIR`)가 상단에 있다 |
| 백엔드 | `access.py` | **접근 제어 전부** — {id, dept}를 받아 들여보낼지만 판단한다. 다른 서비스에 그대로 떼어 쓸 수 있다 |
| 프론트 | `web/access.js` | 접근 판단·임시 접속 표시·허가 목록 편집. 이 파일만 빼면 제어가 사라진다 |
| 프론트 | `web/sso.js` | 브라우저 SSO 클라이언트 (로컬 에이전트 웹소켓 → verify). 로그인 페이지가 쓴다 |
| 프론트 | `web/denied.html` | 로그인 페이지. SSO를 먼저 시도하고, 막히면 임시 접속 폼을 보여준다 |
| 백엔드 | `sso.py` | **로그인 id 조회 전부** — 실패해도 guest로만 떨어지고 다른 기능에 영향이 없다 |
| 백엔드 | `rates.py` | **모델별 요청·토큰 rate 집계 전부** — 다른 모듈을 import하지 않아 그대로 떼어 쓸 수 있다 |
| 백엔드 | `llm.py` | **LLM 접점 전부** — endpoint 조립(`chat_url`)·헤더(`_headers`)·요청/파싱(`chat_messages`)·설정 로드·저장. 접목 시 여기만 고친다 |
| 프론트 | `web/index.html` | 탭·패널 구조와 요소 id |
| 프론트 | `web/app.js` | 모든 화면 로직 (변환·데이터셋·마스터·대화·라우팅). 빌드 없는 순수 JS |
| 프론트 | `web/styles.css` | 테마 변수(light/dark)와 전체 스타일 |
| 프론트 | `web/sheet.html` | Luckysheet 격리 iframe (표 편집) |
| 설정 | `config/llm.json.example` | 설정 키 예시 — 복사해 `llm.json`으로 쓴다 (실제 파일은 커밋 금지) |
| 설정 | `config/sso.json.example` | 로그인 id 조회 설정 예시 — 복사해 `sso.json`으로 쓴다 (선택) |
| 설정 | `config/access.json.example` | 접근 제어 설정 예시 — 복사해 `access.json`으로 쓴다 (선택) |
| 설정 | `config/server.json.example` | 실행 설정 예시 (host port 저장 경로, `rate` 블록) — 복사해 `server.json`으로 쓴다 (선택) |
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
| `LLM_DATA_SSO_CONFIG` | SSO 설정 파일 경로를 개별 지정할 때 | `/etc/llm-data/sso.json` |
| `LLM_DATA_ACCESS_CONFIG` | 접근 제어 설정 파일 경로를 개별 지정할 때 | `/etc/llm-data/access.json` |

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

## 설정 구조 — 모델마다 `url` · `header` · `body` · `etc` 한 벌

특별한 환경(게이트웨이)용 설정은 **모델마다 온전한 구조를 하나씩** 갖는다.
최상위 키 이름이 곧 모델 이름이고, 그 안에 그 모델의 `url`·`header`·`body`·`etc`가 들어간다.
모델 목록은 이 최상위 키들에서 잡히므로 `models` 같은 별도 키를 적지 않는다.

요청을 결정하는 것은 **`url`·`header`·`body` 3개**다. 여기 적은 것이 그대로 나간다.
`etc`는 예외로 두는 자유 영역이며 **요청에 실리지 않는다**.

| 키 | 내용 |
|---|---|
| `url` | 이 모델의 전체 endpoint |
| `header` | 실제 요청 헤더. 이름·값 모두 적은 그대로 전송(대소문자 보존), 값은 문자열 |
| `body` | 요청 본문 항목. `model`도 여기 둔다 |
| `etc` | 설명 등 자유 기재. 전송되지 않는다. `timeout`·`probe_timeout`·`response_schema`를 넣으면 그 모델에 그 값으로 동작한다 |

**header** — `Content-Type`, `Accept`, `x-dep-ticket`, `Send-System-Name`, `User-Type`, `User-Id`가
기본이다. 값에 쓰는 자리표시자는 요청마다 치환된다 — `{uuid}`, `{uuid_hex}`, `{ts}`.
자격 정보(`ticket`·`key`·`token`·`auth` 등이 이름에 든 헤더)는 요청 전문 화면에서 `****`로 마스킹된다.

**disabled** — `header`와 `body` 맨 아래의 `disabled` 블록은 **적어만 두고 전송하지 않는다.**
켜려면 그 줄을 `disabled` 밖으로 옮기고, 끄려면 도로 넣는다.

JSON에는 주석이 없고, 화면의 설정 탭에서 저장하면 파일이 통째로 다시 기록된다
(`llm.py`의 `save_config`). 그래서 꺼둔 항목을 주석이 아니라 **데이터로** 남긴다 —
YAML로 바꿔도 저장 한 번에 주석은 사라지므로 형식을 바꾼다고 풀리는 문제가 아니다.

- `header.disabled` — 선택 헤더. 예: `Chat-Id`, `Prompt-Msg-Id`, `Completion-Msg-Id`
- `body.disabled` — 설정이 관여하지 않는 본문 항목. 예: `messages`, `messages.role`, `messages.content`
  (대화 내용은 서비스가 만들어 넣는다)

**body** — 값의 형태가 곧 동작이다.

| 값 형태 | 동작 | 예 |
|---|---|---|
| 스칼라 | 매 요청 그대로 전송 | `"model": "gpt-oss-120b"`, `"max_tokens": 4096`, `"stream": false` |
| `{"min","max","step"}` | 그 범위의 수를 화면에서 고른다 | `"temperature": {"min":0,"max":1,"step":0.1}` |
| `["a","b"]` | 그 목록 중 하나를 고른다 | `"reasoning_effort": ["low","medium","high"]` |

선택 항목은 **고르지 않으면 보내지 않는다**(게이트웨이 기본값 사용). 범위 밖 값이나 목록에 없는
값은 서버가 거부한다. 화면의 드롭다운·숫자 입력은 이 스펙에서 자동 생성되므로 UI 수정이 필요 없다.
모델을 바꾸면 그 모델의 프로필 전체(endpoint·헤더·body·timeout)가 함께 바뀐다.

### 예시 — 게이트웨이 환경

```json
{
  "gpt-oss-120b": {
    "url": "https://apigw.example.com/llm/v1/chat/completions",
    "header": {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-dep-ticket": "credential:TICKET-...",
      "Send-System-Name": "playground",
      "User-Type": "AD_ID",
      "User-Id": "your.loginid",
      "disabled": {
        "Chat-Id": "{uuid}",
        "Prompt-Msg-Id": "{uuid}",
        "Completion-Msg-Id": "{uuid}"
      }
    },
    "body": {
      "model": "gpt-oss-120b",
      "max_tokens": 4096,
      "stream": false,
      "temperature": { "min": 0, "max": 1, "step": 0.1 },
      "reasoning_effort": ["low", "medium", "high"],
      "disabled": {
        "messages": "대화 내용은 서비스가 만들어 넣는다",
        "messages.role": "user | assistant | system",
        "messages.content": "메시지 본문"
      }
    },
    "etc": {
      "설명": "최상위 키 이름이 모델 이름이다. etc는 요청에 실리지 않는다.",
      "timeout": 900
    }
  }
}
```

모델을 늘릴 때는 같은 모양의 블록을 하나 더 붙인다. 화면의 모델 드롭다운에 그 순서대로 나온다.

## 그 외 키 — 과거 구성·모델별 URL 경로 호환

| 키 | 의미 |
|---|---|
| `base_url` | OpenAI 호환 서버 루트. 모델별 경로가 자동으로 붙는다 |
| `url` | 전체 endpoint를 직접 지정할 때 (`base_url` 무시) |
| `model` | 요청 payload의 `model` 값 |
| `headers` | 요청에 그대로 합쳐지는 헤더 — token은 여기 `Authorization`에 둔다 |
| `api_key_env` | token을 환경변수 이름으로 줄 때 |
| `response_schema` | 구조화 출력(response_format json_schema) 강제 여부 — **미지원 모델이면 false 유지** |
| `timeout` | LLM 호출 대기(초, 기본 300). 설정값이 그대로 적용된다 |
| `probe_timeout` | 상태 조회·취소 등 보조 호출 대기(초, 기본 5) |
| `extra_payload` | payload 추가 필드 |

## 전달(passthrough) 키 — 게이트웨이 접목 지점

API 게이트웨이를 거쳐야 하는 시스템(자격 티켓·시스템 식별자·계정 정보를 요구하는 형태)은
**설정만으로 접목된다.** 아래 키를 `config/llm.json`에 채우면 코드 수정이 필요 없다.

| 키 | 접목 방법 |
|---|---|
| `api_base_url` | **게이트웨이 루트. 코드 수정 없이 그대로 동작한다.** `/v1`로 끝나면 `/chat/completions`만 덧붙이고, 모델은 URL 경로가 아니라 요청 body의 `model` 필드로 보낸다 |
| `credential_key` | 자격 티켓. **값만 채우면 `x-dep-ticket` 헤더로 전송된다** |
| `send_system_name` | 호출 시스템 식별자. **값만 채우면 `Send-System-Name` 헤더로 전송된다** |
| `user_id` | 사용자 식별자. **값만 채우면 `User-Id` 헤더로 전송된다** |
| `header_map` | **선택.** 게이트웨이가 위와 다른 헤더 이름을 요구할 때만 쓴다. 예: `{"credential_key": "X-Custom-Ticket"}` |
| `env_model` | 게이트웨이가 요구하는 모델 이름. `model`/`models`에 그 값을 그대로 쓰면 된다 |
| `OPENAI_API_KEY` | 표준 Bearer token — 기본 구현이 그대로 사용 |

### 게이트웨이형 환경 설정 예시 (코드 수정 불필요)

```json
{
  "api_base_url": "https://apigw.example.com/llm/v1",
  "model": "gpt-oss-120b",
  "models": ["gpt-oss-120b"],
  "timeout": 900,
  "headers": { "User-Type": "AD_ID" },
  "credential_key": "credential:TICKET-...",
  "send_system_name": "playground",
  "user_id": "your.loginid"
}
```

- **모델 목록**은 `models`로 정한다. 소스의 하드코딩 목록을 고칠 필요가 없다.
- **`credential_key`, `send_system_name`, `user_id`는 값만 채우면** 각각 `x-dep-ticket`,
  `Send-System-Name`, `User-Id` 헤더로 전송된다. 같은 키를 두 번 쓸 필요가 없다.
  게이트웨이가 다른 이름을 요구할 때만 `header_map`으로 그 키를 덮어쓴다.
- **`timeout`은 설정값이 그대로 적용된다**(기본 300초, 상한 없음에 가까움). 응답이 느린
  게이트웨이는 넉넉히 잡는다. 상태 조회·취소 같은 보조 호출은 `probe_timeout`(기본 5초)이다.
- **헤더 이름과 값은 적은 그대로 전송된다.** `x-dep-ticket`이 `X-dep-ticket`으로 바뀌지 않는다
  (urllib이 헤더 이름을 `capitalize()`로 바꾸는 문제 때문에 전송 계층에서 `http.client`를 쓴다).
- 요청 전문 화면에서 `x-dep-ticket` 같은 자격 정보는 `****`로 마스킹된다.

## endpoint 결정 순서

1. `url` — 전체 endpoint를 그대로 사용 (최우선)
2. `api_base_url` — 게이트웨이 루트. `/chat/completions`로 끝나면 그대로, `/v1`로 끝나면
   `/chat/completions`만 덧붙이고, 그 외에는 `/v1/chat/completions`를 붙인다. **모델 세그먼트를 넣지 않는다**
3. `base_url` — `{base_url}/{model}/v1/chat/completions` (llm-api처럼 모델별 경로를 쓰는 서버)

취소(`/cancel`)와 상태 조회(`/api/health`)에 쓰는 API 루트도 같은 기준으로 계산되므로,
`api_base_url`만 지정해도 취소·상태 표시가 올바른 곳을 향한다.

## SSO 로그인 확인 (선택)

로그인 사용자를 표시하는 기능은 `sso.py`와 `web/app.js`의 SSO 구간에 모여 있고
**기존 기능과 완전히 분리**되어 있다. 어떤 이유로 실패하든 id만 `guest`로 표시되고
변환·대화는 그대로 동작한다. 설정 파일이 없으면 아예 시도하지 않는다.

두 단계로 동작한다. 주고받는 key와 value를 `config/sso.json`에 모두 적는다.

| 단계 | 누가 | 하는 일 |
|---|---|---|
| 1 `local` | **브라우저** | 사용자 PC의 로컬 에이전트에 웹소켓으로 붙어 토큰을 받는다 |
| 2 `verify` | **서버** | 그 토큰을 얹어 `verify_sso`로 POST하고 로그인 정보를 꺼낸다 |

1단계를 브라우저가 하는 이유는 `localhost`가 **서버가 아니라 사용자 PC**이기 때문이다.
서버에서 `ws://localhost`로 붙으면 서버 자신에게 붙는 것이라 의미가 없다.
`local.url`을 비우면 1단계를 건너뛰고 쿠키만 넘겨 확인한다.

```json
{
  "local": {
    "url": "ws://localhost:29282",
    "request": { "rqtype": "getknoxsso", "token": "", "data": "KCC10TRAY0153" },
    "response": { "userInfo": "data.userInfo", "key": "data.key" },
    "etc": { "timeout": 3 }
  },
  "verify": {
    "url": "http://sso.example.com:8000/api/verify_sso",
    "header": { "Content-Type": "application/json", "Accept": "application/json" },
    "body": { "token": { "json": { "userInfo": "{userInfo}", "key": "{key}" } } },
    "response": {
      "id": ["data.response.EP_LOGINID", "EP_LOGINID"],
      "name": ["data.response.EP_USERNAME", "EP_USERNAME"],
      "dept": ["data.response.EP_DEPTNAME", "EP_DEPTNAME"]
    },
    "etc": { "method": "POST", "timeout": 3, "forward_headers": ["Cookie", "Authorization"] }
  },
  "etc": { "cache_seconds": 60, "health_seconds": 10 }
}
```

실제 흐름은 이렇게 돈다.

1. 브라우저가 `ws://localhost:29282`에 붙어 `local.request`를 그대로 보낸다.
2. 응답의 `data`(JSON 문자열)를 파싱해 `userInfo`와 `key`를 꺼낸다.
   **경로 중간 값이 JSON 문자열이면 자동으로 객체로 바꾸고 계속 내려간다** —
   KnoxTray 응답은 `{"data": "{\"result\":\"success\",\"userInfo\":…,\"key\":…}"}` 모양이라
   경로를 `data.userInfo`로 적으면 된다.
3. 그 둘을 `verify.body`의 `token`에 **JSON 문자열**로 담아 `verify.url`로 POST한다.
4. 서버가 RSA 개인키로 `key`를 풀고 AES/CBC(IV=0x00×16)로 `userInfo`를 풀어 사용자 정보를 돌려준다.
5. `verify.response` 경로로 id·이름·부서를 꺼내 화면에 표시한다.

- `local.request` — 에이전트로 보낼 메시지. 적은 key와 value가 그대로 JSON으로 나간다.
- `local.response` — 받은 메시지에서 값을 꺼낼 경로를 이름마다 적는다. 실제 응답 모양은
  브라우저 콘솔의 `[sso] local agent` 줄에 `message`로 찍히므로 그걸 보고 맞춘다.
- `verify.body` — 실을 key와 value를 그대로 적는다. 값의 `{이름}`이 1단계 값으로 치환되고,
  `{"json": {...}}`로 감싸면 그 안을 채운 뒤 **JSON 문자열**로 만든다.
- `verify.response` — 응답에서 id·이름·부서를 꺼낼 경로. 중간 값이 JSON 문자열이면 자동으로
  객체로 바꾸고 계속 내려가며, **본문 전체가 JSON 문자열인 응답**(`"{\"EP_LOGINID\":…}"`)도
  그대로 처리한다. 배열로 후보를 여러 개 줄 수 있고, **여기 적은 경로에서 못 찾으면 기본 후보로
  이어서 찾는다** (`data.response.EP_*` → `data.EP_*` → `response.EP_*` → `userInfo.EP_*` → `EP_*`).
  그래서 응답 구조를 정확히 몰라도 대개 붙는다.
- **`ws://localhost`는 그대로 둔다.** 사용자 PC의 에이전트라서 브라우저가 붙어야 한다.
  8000 포트만 실제 호스트 주소로 바꾼다.
- `verify.url` — 적은 호스트로 그대로 나간다. 경로를 빼고 호스트만 적으면 `/api/verify_sso`를 붙인다.
- 프록시가 헤더로 직접 넣어 주는 환경이면 `X-SSO-User`가 우선한다 (SSO 조회 없이 그 값을 쓴다).

화면 표시 (id 왼쪽 LED)

| 상태 | LED | 표시 |
|---|---|---|
| id를 가져옴 | 초록 | id 이름 부서 |
| 통신은 됐지만 응답에서 값을 못 찾음 | 주황 | `guest` (콘솔에 응답 일부 출력) |
| 서비스 응답 없음 (DNS·거부·타임아웃) | 빨강 | `guest` |
| 설정 없음 | 없음 | `guest` |

로그는 두 곳에 남는다. 서버 터미널의 `[SSO]` 줄과 브라우저 콘솔의 `[sso]` 줄이며,
1단계 연결·전송·수신과 2단계 요청·응답·판정이 모두 찍힌다.
자격 정보(Cookie·Authorization·token)는 값 대신 길이만 표시된다.

```
[SSO] 확인 시작 http://…/api/verify_sso | token 있음(12자) | 헤더 Accept=…, Cookie=****(15자) | body {"token": "****(12자)"}
[SSO] POST http://…/api/verify_sso -> 200 (1ms, 139B)
[SSO] 로그인 확인 id=your.loginid name=… dept=…
```

확인 결과는 세션 단위로 `cache_seconds`(기본 60초) 캐시한다. 화면은 15초마다 갱신하되
이미 로그인된 상태면 **TCP 연결 확인만** 한다 — 빈 토큰으로 `verify_sso`를 다시 두드리면
상대 서버 로그에 실패가 쌓이기 때문이다.

관련 API: `GET /api/sso/config`(1단계 설정), `POST /api/sso/verify`(토큰으로 2단계),
`GET /api/whoami`(토큰 없이 확인), `GET /api/sso/health`(생사).

자격 정보가 담기는 `config/sso.json`은 `llm.json`과 함께 커밋 대상이 아니다 (PERSIST 볼륨에 둔다).

## 접근 제어 (선택, 독립 모듈)

허용한 사람만 들여보내는 기능이다. `access.py` + `web/access.js` 두 파일이 전부이고
**sso도 llm도 import하지 않는다** — `{id, dept}`를 받아 들여보낼지만 판단하므로 다른
서비스에 그대로 떼어 쓸 수 있다. `index.html`의 `<script src="access.js">` 한 줄을 지우면
제어가 사라지고 앱은 그대로 동작한다.

설정은 `config/access.json`이며, **파일이 없거나 allow가 비어 있으면 아무도 막지 않는다.**

```json
{
  "allow": { "id": ["your.loginid"], "dept": [] },
  "admin": { "id": ["your.loginid"] },
  "temp":  [ { "id": "temp", "pw": "바꿔서 쓰세요", "note": "임시 접속" } ],
  "etc":   { "session_hours": 12 }
}
```

- `allow.id` — 허용할 로그인 id (SSO의 `EP_LOGINID`)
- `allow.dept` — 허용할 부서. **부분 일치**라 이름 표기가 조금 달라도 걸린다
- `admin.id` — 허가 목록을 편집할 수 있는 사람. 이 사람에게만 헤더에 🔑 버튼이 보인다
- `temp` — SSO가 막혔을 때 쓰는 임시 자격. **통행증일 뿐이라 화면의 사용자 표시는 SSO 결과 그대로다**

허용되지 않으면 "허가되지 않은 사용자입니다" 화면이 전체를 덮고, 거기서 임시 id/pw로
들어올 수 있다. 임시 토큰은 HMAC 서명만으로 검증하므로 서버를 재기동해도 유효하고
별도 저장이 필요 없다(서명 키는 첫 사용 때 `etc.secret`에 자동 생성된다).

관련 API: `GET /api/access/check`, `POST /api/access/temp`, `GET·POST /api/access/rules`(admin만).

**로그인 먼저, 화면은 그 다음.** 신원이 확인되지 않으면 앱 대신 로그인 페이지(`denied.html`)를
같은 주소에서 403으로 내려준다. 그 페이지는 로드되자마자 SSO를 조용히 시도하고, 통과하면
곧바로 앱으로 넘어간다 — SSO로 들어오는 사람은 이 화면을 보지 않는다. 막힌 경우에만
"허가되지 않은 사용자입니다"와 임시 접속 폼이 나타난다.

1단계(웹소켓)는 브라우저만 할 수 있으므로, 확인에 성공하면 서버가 **서명한 신원을 쿠키
(`llm_sso`)로** 심는다. 그 뒤부터는 페이지 이동에도 신원이 실려 서버가 같은 사람으로 알아본다.
이 쿠키가 없으면 서버는 매번 `guest`로 판단해 SSO 사용자도 막힌다.

**서버에서도 막는다.** 화면 스크립트가 없거나 캐시돼도 통과되지 않는다.
차단된 사용자의 요청은 페이지면 `denied.html`로 302, `/api/*`면 403(E-1009)이다.
차단 페이지 자체와 그 페이지가 쓰는 것(`denied.html`, `access.js`, `styles.css`,
`/api/access/check`, `/api/access/temp`, `/api/whoami`, `/api/health`, `vendor/`)만 열려 있다.

## 상태 확인 주기

화면이 상태를 다시 물어보는 주기는 설정에서 온다(하드코딩 아님). 기본 30초, 최소 5초.

| 대상 | 설정 위치 |
|---|---|
| LLM | `llm.json`의 `poll_seconds` (프로필 구성이면 `etc.poll_seconds`) |
| SSO | `sso.json`의 `etc.poll_seconds` |

로그는 **실패했을 때만** 남는다. 서버 터미널의 `[SSO]`·`[ACCESS]` 줄과 브라우저 콘솔의
`[sso]`·`[access]` 줄이며, 정상 흐름은 조용히 지나간다.

## 코드 수정이 필요한 경우

설정으로 풀리지 않는 것은 **토큰 발급형 게이트웨이** 정도다. `user_id`/`user_pw`로 먼저 토큰을
발급받아야 한다면 `llm.py`의 `_headers()`에 발급 호출을 넣는다.

```python
if cfg.get("user_id") and cfg.get("user_pw"):
    headers["Authorization"] = "Bearer " + issue_token(
        cfg["api_base_url"], cfg["user_id"], cfg["user_pw"])
```

## 접목 시 유의

- token이 들어가는 `config/llm.json`은 repo에 커밋하지 않는다(.gitignore 처리됨). 배포 시 PERSIST 볼륨에 둔다 — `DEPLOY.md` 참고.
- 요청·응답 **전문**(마스킹된 headers 포함)이 변환 작업 이력과 대화 탭에 항상 표시되므로 접목 디버깅에 그대로 쓸 수 있다.
- 구조화 출력을 지원하지 않는 모델을 쓰는 환경이면 `response_schema=false`(기본값)를 유지해야 한다 — 파서는 코드 fence·설명문이 섞인 응답도 관대하게 처리한다.
