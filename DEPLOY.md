# 배포 안내 — 저장 영역 구분

재기동·재배포 시 **유실되어도 되는 것**과 **영구 저장소에 반드시 남아야 하는 것**을
코드 수준에서 분리해 두었다. 컨테이너뿐 아니라 프로세스로 직접 띄우는 배포에도 동일하게 적용된다.
헤더의 ⚙ 버튼(저장 영역 안내) 또는 `GET /api/storage`로 현재 인스턴스의 실제 경로 매핑을 확인할 수 있다.

## 영역 구분

| 영역 | 위치 | env | 내용 | 재기동 시 |
|---|---|---|---|---|
| LOGIC | 코드 디렉터리 | — | server.py · llm.py · web/ · prompts/(기본본) · examples/ · config/*.json.example | 유실 무관 (배포물에 포함) |
| PERSIST | `/data` | `LLM_DATA_PERSIST` | dataset.json · exports/(Save As 스냅샷) · dataset-log.jsonl · chats/ · projects.json · masters/ · prompts/table_to_schema.md(사용자 저장본) · config/llm.json(사용자 설정·token) · config/sso.json(SSO 자격) · config/access.json(허용 목록·임시 pw·서명 키) | **반드시 유지 — 영구 저장소 필수** |
| RUNTIME | `/runtime` | `LLM_DATA_RUNTIME` | jobs/ (변환 작업 이력·중간 산출물) | 유실 허용 |

> **운영·CI/CD 환경에서는 `LLM_DATA_PERSIST`와 `LLM_DATA_RUNTIME` 지정이 필수다.**
> 지정하지 않으면 데이터가 코드 디렉터리 아래(`<repo>/data`)에 쌓인다. 릴리스 디렉터리를 통째로
> 교체하는 배포 방식이나 앱 디렉터리를 read-only로 두는 환경에서는 그대로 **유실 또는 저장 실패**로
> 이어진다. env 미설정은 로컬 개발 전용으로만 쓴다.

- env 미설정 시 경로: PERSIST 대상은 모두 `<repo>/data` 아래(dataset·exports·chats·projects·masters·
  prompts·dataset-log), 설정 파일은 `<repo>/config/{llm,sso,access}.json`이다. 이 실제 설정 파일들은
  git 추적에서 제외되어 있고, 예시 파일(`*.example`)만 커밋한다.
- `LLM_DATA_PERSIST`를 주면 실제 설정 파일은 `<persist>/config/{llm,sso,access}.json`을 쓴다.
  이 상태에서는 코드 디렉터리의 로컬 설정으로 fallback하지 않는다.
- 사용자 편집 대상인 `config/llm.json`(LLM 연결·token)과 변환 프롬프트는 기본본(LOGIC)과
  사용자 저장본(PERSIST)을 나눠 둔다. 저장은 항상 PERSIST에 기록되어 코드 영역의 추적 파일을
  덮어쓰지 않으며, token이 배포물에 들어가지 않는다.
- 현재 인스턴스에 실제로 적용된 경로와 env 적용 여부는 화면 헤더 **⚙** 또는 `GET /api/storage`로 확인한다.
  env가 빠져 있으면 같은 응답의 `warning`과 화면 경고로 표시된다.

## 프로세스로 직접 배포 (컨테이너 없이)

```bash
LLM_DATA_PERSIST=/srv/llm-data/data LLM_DATA_RUNTIME=/var/tmp/llm-data python run_server.py
```

- `LLM_DATA_PERSIST`는 릴리스 교체와 무관한 경로(앱 디렉터리 **바깥**)로 지정한다.
- 기본 bind는 `127.0.0.1`이다. 같은 호스트의 `_global` 뒤에 둘 때 이 값을 유지한다.
  별도 프록시/호스트에서 직접 붙어야 하는 경우에만 `--host 0.0.0.0` 또는 `LLM_DATA_HOST`를 쓴다.
- 앱 디렉터리를 read-only로 두어도 동작한다 — 쓰기는 전부 PERSIST·RUNTIME 아래에서만 일어난다.
- 서비스 계정에 두 경로의 쓰기 권한을 준다. 기동 시 하위 디렉터리는 자동 생성된다.

## docker compose

```bash
docker compose up -d --build
```

- PERSIST는 named volume `llm_data_persist`로 마운트된다. `/runtime`은 의도적으로 마운트하지 않는다.
- 첫 기동 후 설정 탭(0번)에서 `base_url`을 llm-api 위치로 지정한다
  (호스트에서 llm-api:8820이 돌면 `http://host.docker.internal:8820`).

## kubernetes 힌트

- `/data` → PersistentVolumeClaim 마운트 (ReadWriteOnce면 replica 1 — 서버가 파일 기반 단일 인스턴스 설계).
- `/runtime` → `emptyDir` 로 충분.
- liveness/readiness: `GET /api/health` (200 + `"app": "llm-data"`).
- 프록시 뒤에 둘 때: 호스트 프록시(`publicHost: llm-data.tradechord.com`)면 경로를 건드리지
  않으므로 그대로 동작하고, 경로 프록시(`/apps/llm-data/`)면 `stripPrefix: true`여야 한다
  (프론트가 상대경로로 fetch하기 때문). 서버는 두 경우 모두 받아들인다 —
  `/apps/llm-data` 접두어가 붙어 들어와도 벗겨서 처리한다.

## 점검 endpoint

- `GET /api/health` — 서버·LLM 설정 상태
- `GET /api/storage` — 이 인스턴스의 LOGIC/PERSIST/RUNTIME 실제 경로와 env 적용 여부
