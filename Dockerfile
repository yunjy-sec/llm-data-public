# llm-data — 표 텍스트 → JSON Schema 정규화 서비스 (stdlib 전용, 의존성 없음)
FROM python:3.12-slim

WORKDIR /app

# LOGIC 영역 — 코드·기본본만 이미지에 포함한다.
# config/llm.json(token 가능)은 이미지에 넣지 않는다 → persistent volume(/data/config/llm.json)에서 관리.
COPY server.py llm.py ./
COPY web/ web/
COPY prompts/ prompts/
COPY examples/ examples/

# PERSIST(/data)는 persistent volume 필수, RUNTIME(/runtime)은 재기동 시 유실 허용
ENV LLM_DATA_PERSIST=/data \
    LLM_DATA_RUNTIME=/runtime
VOLUME ["/data"]

EXPOSE 8821
HEALTHCHECK --interval=30s --timeout=5s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8821/api/health',timeout=4)"

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8821"]
