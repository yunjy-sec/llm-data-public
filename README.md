# llm-data — 표 데이터 스키마 정규화

Excel·JSON·HTML 등 어디서 복사했는지 모르는 임의 형식의 표 텍스트를, 지정한 목표 JSON Schema에 맞는
레코드 배열로 정규화하는 서비스입니다. 열 이름이 한글·영어·공백·숫자·특수기호가 섞여 있어 규칙 기반
매핑이 불가능한 데이터를 LLM의 의미 기반 매핑으로 변환합니다.

- 주소: `http://127.0.0.1:8821` (프록시 뒤에 둘 때는 stripPrefix 방식)
- 실행: `python server.py --host 127.0.0.1 --port 8821` (stdlib only, 의존성 없음)
- LLM: OpenAI 호환 endpoint를 `config/llm.json`의 `base_url`(기본 `http://127.0.0.1:8820`)로 지정.
  다른 게이트웨이에 붙이는 방법은 [INTEGRATION.md](INTEGRATION.md), 배포·저장 경로는 [DEPLOY.md](DEPLOY.md) 참고

## 구조

| 경로 | 역할 |
|---|---|
| `server.py` | stdlib HTTP 서버 · 잡 큐(데몬 스레드) · `data/jobs/JOB-*.json` 상태 저장 |
| `llm.py` | LLM 게이트웨이: 설정/토큰 주입, blocking 호출, lenient JSON 파싱, 오류 분류 |
| `prompts/table_to_schema.md` | 변환 시스템 프롬프트 (`{{TARGET_SCHEMA}}` 치환) |
| `examples/` | 기본 목표 스키마(ESD 한계평가·인사명부)와 예시 입력 3종 |
| `web/` | 프론트엔드 (상대경로 fetch + 폴링 실시간 동기화) |
| `web/vendor/luckysheet/` | 자체 호스팅 Luckysheet 2.1.13 (records 표 하단 Excel 뷰, CDN 미사용) |
| `config/llm.json` | LLM 연결 설정. 토큰은 `headers` 또는 `api_key_env`로 주입 |

## 백엔드 LLM 통신

`llm.py`는 `config/llm.json`의 `base_url`/`model`로 `POST <base>/<model>/v1/chat/completions`를
호출합니다(모델별 경로여야 `response_format`(json_schema) 구조화 출력이 전달됨). 토큰이 필요한 
API라면 설정의 `headers`에 `Authorization: Bearer …`를 넣거나 `api_key_env`에 환경변수 이름을
지정합니다 — 토큰은 코드·로그에 남지 않습니다(로그는 마스킹). 호출은 blocking이며 잡 워커 스레드에서
실행되고, 실패는 `E-2001`(전송)·`E-2002`(응답 형식)·`E-2007`(인증)·`E-3001`(파싱) 코드로 분류되어
UI에 그대로 표시됩니다.

## 프론트 실시간 동기화

SSE 없이 순수 폴링입니다. `POST api/jobs`가 즉시 202(`job_id`)를 반환하고, 클라이언트는
`GET api/job?id=`를 1초 간격으로 폴링합니다(연속 실패 시 지수 백오프, 8회 초과 시 "다시 확인" 버튼).
세대 토큰(`_poll`)으로 재시도 시 이전 폴러를 무효화하고, 1초 `setInterval`이 `[data-timer]`의 경과
시간을 갱신하며 5초마다 업스트림 llm-api 상태(실행 중 모델·대기 수·인증 상태)를 헤더에 표시합니다.
서버 재기동 시 `queued/running` 잡은 `E-2008`로 정리되어(reap) 영구 "실행 중" 상태가 남지 않습니다.

잡 실행은 로컬 단일 소비 큐(1 워커)로 직렬화됩니다 — 업스트림 llm-api가 전역 직렬이므로, 대기 잡의
소켓 타임아웃이 큐 대기시간에 소모되지 않게 하기 위함입니다.

**흐름 투명화**: 각 잡은 4단계(입력 접수 → 프롬프트 구성 → LLM 수행 → 파싱·검증)의 상태·소요시간을
`steps`에 기록하고, 이력 카드의 단계 스트립과 결과 패널의 "진행 흐름" 표에 실시간 표시됩니다. 결과
패널에는 실제 전송된 **시스템 프롬프트 전문(스키마 치환 완료본)**, **입력 전문**, **LLM request
정보**(URL·모델·payload 크기·response_format·timeout), **LLM 원문 응답**이 그대로 열립니다.

**취소**: `POST api/cancel {id}` — 대상 잡에 취소 플래그를 남기고, 그 잡이 실행 중이면 업스트림
`/cancel`을 함께 호출합니다. UI는 "취소 중…" → `cancelled` 종결 상태로 전환됩니다(실측 ~1초).
업스트림이 취소를 지원하지 않으면 로컬 잡만 종결 처리되며, 이 경우 업스트림 응답은 버려집니다.

**설정 편집**: 화면의 "설정" 패널에서 LLM 연결 정보(`config/llm.json` — base_url/model/url/토큰
headers/api_key_env/timeout 등)와 시스템 프롬프트를 조회·편집·저장할 수 있습니다
(`GET/POST api/config`, `GET/POST api/prompt`). 저장 즉시 다음 변환부터 적용됩니다.

## API

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/health` | `{"app":"llm-data","ok":true,...}` — _global 헬스체크 marker |
| `GET /api/llm/health` | 업스트림 llm-api 상태 요약 |
| `GET /api/rates` | 모델별 요청·토큰 rate(서버 전체, 분당). 창 길이·주기·색 범위는 `config/server.json`의 `rate` |
| `GET /api/schema` · `/api/examples` · `/api/models` · `/api/prompt` | 기본 스키마·예시·모델·프롬프트 |
| `POST /api/jobs` | `{input_text, schema?, model?}` → 202 `{job_id, queue_position}` |
| `GET /api/jobs?limit=N` · `GET /api/job?id=` | 이력 요약(steps 포함) · 잡 문서(steps·request·response·결과 포함) |
| `POST /api/cancel` | `{id}` — 해당 잡 취소 (실행 중이면 llm-api `/cancel` 전달, 종결 상태 `cancelled`) |
| `GET/POST /api/config` | LLM 연결 설정 조회·저장 (`config/llm.json`) |
| `GET/POST /api/prompt` | 시스템 프롬프트 조회·저장 (`{{TARGET_SCHEMA}}` 자리표시자 필수) |

## 출력 계약

LLM은 아래 envelope만 반환하도록 시스템 프롬프트로 강제되고, lenient 파서가 코드펜스·잡문·잘린
출력을 방어합니다. `response_format`(json_schema)을 지원하는 LLM이라면 `config/llm.json`의
`response_schema: true`로 추가 강제할 수 있습니다 — **기본값은 `false`**입니다
(response_format 미지원 LLM이 많으므로 프롬프트+파서만으로 동작하는 것이 기본).

```json
{
  "records":  [ { "…목표 스키마 필드…": "값" } ],
  "mapping":  [ { "source": "원본 열", "target": "필드", "rule": "변환 요약" } ],
  "unmapped": [ { "source": "원본 열", "reason": "사유", "values_sample": [] } ],
  "warnings": [ "추정·제외·계산 관련 경고" ]
}
```

결과 패널의 records 표 하단에는 같은 데이터를 **Luckysheet Excel 뷰**로도 표시합니다(열 폭 자동).
셀 배경색 규칙: HTML 표는 빈 값=노랑(빈 값 하이라이트 탭)·PASS=녹색·FAIL=붉은색·방금 추가된
행=녹색(데이터셋 탭)이고, **시트는 PASS/FAIL 스타일만** 적용합니다. Luckysheet는 destroy()가 document
핸들러를 정리하지 못하는 싱글턴이라 본문에 직접 올리면 잡 전환마다 리스너가 누적돼 브라우저가
멈춘다 — 그래서 **`web/sheet.html` iframe 안에서만 실행**하고, 잡이 바뀌면 iframe째 교체해 누수를
원천 차단한다(부모↔iframe은 same-origin postMessage 핸드셰이크). iframe 안에서 시트가 더 스크롤될
수 없으면 휠 이벤트를 luckysheet에 주지 않아 페이지 스크롤로 자연스럽게 넘어간다(휠 체이닝).
라이브러리는 `web/vendor/luckysheet/`에 자체 호스팅되어 `/vendor/*` 경로(확장자 화이트리스트 +
경로 탈출 방지, `max-age=86400` 캐시)로 서빙됩니다.

작업 이력에는 **새로고침** 버튼과 종결(done/error/cancelled) 잡의 **삭제(✕)** 버튼이 있습니다
(`DELETE /api/job?id=` — 진행 중인 잡은 409로 거부).

**데이터셋 축적 탭**: 변환 결과를 영속 데이터셋(`data/dataset.json`)에 새 행으로 insert합니다.
완료된 잡 결과의 "데이터셋에 N행 추가" 버튼 → append (잡 단위 중복 방지, 스키마 필드 일치 검증,
빈 데이터셋 첫 insert 시 스키마 채택). 각 행에는 스키마 열 우측에 시스템 열 `user_id`(행 생성
사용자)·`created_at`·`updated_at` timestamp가 붙습니다(내부 순번 id는 표시하지 않음). 방금 추가된
행은 HTML 표에서 녹색 하이라이트되고 추가 직후 데이터셋 패널로 자동 스크롤됩니다. 시트 툴바의
파일명은 **드롭다운** — `dataset.json` + `data/exports/` 스냅샷에서 선택해 로드합니다. **저장**은
현재 파일에 덮어쓰기, **다른 이름으로 저장**은 `dataset_yyyymmdd_hhmmss_{id}.json` 새 이름 발급 후
현재 파일 전환. API: `GET /api/dataset` · `/api/dataset/files`, `POST /api/dataset/insert {job_id}` ·
`/api/dataset/load {file}` · `/api/dataset/save` · `/api/dataset/saveas` · `/api/dataset/clear`.

**데이터셋 편집 탭**: 파일을 골라 HTML 표로 보고 행 단위 CRUD를 수행합니다 — 행 클릭 → 편집
modal(스키마 타입별 입력: enum→select, boolean, array, number), "+ 새 행" → 추가 modal, modal 안
삭제 버튼. `user_id`·`created_at`·`updated_at`은 자동 관리로 **편집 불가**(updated_at은 저장 시
서버가 스탬프). API: `POST /api/dataset/row/create|update|delete`.

**로그 탭**: 행 CRUD와 데이터셋·마스터 작업(insert/load/save/saveas/clear/sheet_apply/master_*)이
`data/dataset-log.jsonl`에 append-only로 기록되고(누가·언제·어떤 파일·무엇을 — update는 필드별
from/to 포함), 로그 탭에서 최신순으로 조회합니다 (`GET /api/dataset/log`).

**대화 탭**: ChatGPT/Claude식 다중 턴 대화 — 이력을 서버(`data/chats/CHAT-*.json`)에 저장하고
매 턴 전체 메시지 배열을 LLM에 보내 컨텍스트를 유지합니다. 대화 선택 드롭다운·새 대화, 모델은
상단 선택을 따름. 전송은 blocking(응답까지 대기 표시)이고, **정지하면 질문만 남고 답변 자리가
비며, 실패하면 그 자리에 실패 사유가 남습니다** — 어느 쪽이든 질문은 사라지지 않습니다.
대화 영역 우측 위에는 서버 전체의 모델별 요청·토큰 rate가 겹쳐 표시됩니다(`GET /api/rates`).
API: `GET /api/chats` · `/api/chat?id=`, `POST /api/chat/send {id?, message, model?}`.

**스키마 형식**: 변환 목표·데이터셋·마스터가 모두 같은 형식을 씁니다.

```json
{
  "schema_name": "EsdEvalResult", "description": "…", "version": "4",
  "columns": [ { "group": "req info", "fields": [
    { "id": "sample_id", "label": "시료 번호", "type": "string",
      "description": "…", "description_detail": "…",
      "mapping_logic_ip_eval_esd": "…", "mapping_logic_chatbot": "",
      "enum": ["코드1", "코드2"] } ] } ]
}
```

`columns`(표의 묶음) → `fields`(열) 2단 구조로, **field의 `id`가 JSON 연산의 key**이고 `group`은
표 헤더에서 열을 묶는 이름입니다(레코드는 group 중첩 없는 평면 객체). 채울 수 없는 항목은 `""`로
비워 둡니다. `enum`은 선택 항목이며 있으면 코드 검증이 걸립니다. 표 헤더는 **group(병합) →
description → id → type → label** 순서의 행들로 그려집니다(HTML 표·Luckysheet 동일).
구형 `properties` 스키마 파일은 읽을 때 자동으로 이 형식으로 변환됩니다.

**마스터 관리 탭**: 변환·CRUD가 참조하는 스키마와 코드 테이블(enum)을 데이터처럼 CRUD로 관리합니다
(`data/masters/*.json`, 현재 esd만). schema_name·version·description을 상단에서 편집하고, group별
필드 표에서 행 클릭 → 필드 편집 modal(group·id·label·type·description·description_detail·
mapping_logic 2종·코드), group 제목의 ✎로 묶음 이름 변경, "+ 새 필드" 추가, modal 내 삭제 —
스키마 JSON은 읽기 전용 결과물로만 표시됩니다. 변환 탭의 스키마 편집기에는 "마스터 불러오기"
드롭다운이 연동됩니다.
API: `GET /api/masters` · `/api/master?name=`, `POST /api/master/save|create|delete|apply`.

**필드 삭제 보호**: 데이터가 연결된 필드는 삭제할 수 없습니다 — 삭제 시도 시 연결된 데이터셋
파일·행 id를 나열하며 차단하고, "그래도 삭제?" 재확인 후에도 데이터가 존재하면 최종 거부합니다.
데이터가 없는 필드도 삭제 전 재확인을 받습니다.

**데이터셋에 적용**: 저장된 마스터를 현재 데이터셋에 반영합니다(`POST /api/master/apply`,
dry_run 검토 → 적용). 추가 필드 = 전 행 null 채움, 데이터 있는 열 제거 = 차단(행 id 나열) 또는
추가된 필드로 **이관(rename)** 지정, 빈 열 = 제거. 적용 후 코드 테이블과 불일치하는 기존 값을
리포트하며, 전 과정이 `schema_apply` 로그로 기록됩니다.

**편집 정합성(필수 2종만)**: ① 시트 헤더(스키마)는 데이터 편집에서 변경 불가 — 클라이언트가 헤더를
대조해 경고·차단하고 서버도 스키마에 없는 열을 거부합니다. ② enum 필드는 코드 테이블에 설정된
값만 허용(행 CRUD·시트 반영 모두, null은 허용). 그 외(required·날짜 형식 등)는 빈 값 흐름과
유연성을 위해 의도적으로 검증하지 않으며, LLM insert 경로도 관대하게 유지합니다.

**데이터 타입 규약**: 저장되는 모든 데이터 값은 **string**입니다 (number 미사용, 빈 값은 null). 전압 등
숫자는 숫자 문자열("1000"), 인가 스트레스 리스트는 `→` 구분 문자열("500→1000→1500"), 행 id도
문자열, 극성은 `pos`/`neg` 코드를 사용합니다.

화면 최상단에 **로그인 id**(👤)를 표시합니다. 현재는 항상 `guest`이며, `GET /api/whoami`가
`X-SSO-User` 헤더를 읽도록 되어 있어 추후 SSO 연동 시 그 값이 표시·저장 파일명에 사용됩니다.

기본 예시는 ESD(HBM/CDM) 한계평가 결과표입니다: 원자 단위 (die, pkg_type, test_type, polarity)당
1 레코드, 인가 스트레스 리스트(kV·V 혼용 → V 환산), 스펙 PASS면 만족 최소 전압 / FAIL이면 불만족 최대
전압, 한계평가 생존 최대·파괴 최소 전압(미파괴 → null)을 LLM이 파생 계산합니다.
