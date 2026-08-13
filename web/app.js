/* llm-data 프론트엔드 — 상대경로 fetch + 순수 폴링 (SSE 없음) */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const TAB_DESC = {
    fill: "데이터가 스키마를 전부 채우는 기본 시나리오",
    missing: "데이터에 빈 셀이 있어 스키마를 못 채우는 시나리오 — 빈 값 필드를 노란색 배경으로 표시",
    dataset: "변환 결과를 기존 데이터셋 표에 새 행으로 추가(insert) — 방금 추가된 행은 녹색 표시",
    edit: "데이터셋 파일을 골라 HTML 표로 보고, 행 클릭 편집·새 행 추가·삭제(CRUD)를 modal로 수행",
    log: "행 CRUD와 데이터셋·마스터 작업의 감사 로그",
    master: "변환·CRUD가 참조하는 스키마와 코드 테이블(enum)을 관리",
    chat: "대화 이력을 기억하며 긴 컨텍스트를 이어가는 다중 턴 대화",
  };
  const state = {
    tab: "fill",         // fill | missing
    jobs: [],            // {id, mode, state, model, created_ms, started_at_ms, latency_ms, preview, error, _poll}
    selected: null,      // 결과 패널에 표시할 job id (현재 탭 기준)
    fullJobs: new Map(), // id -> 서버 job 문서
    examples: [],
    tabState: {
      fill: { input: "", schema: "", selected: null },
      missing: { input: "", schema: "", selected: null },
      dataset: { input: "", schema: "", selected: null },
      edit: { input: "", schema: "", selected: null },
      log: { input: "", schema: "", selected: null },
      master: { input: "", schema: "", selected: null },
      chat: { input: "", schema: "", selected: null },
    },
    tick: 0,
    renderedKey: null,    // 결과 패널에 마지막으로 그린 내용의 키 (불필요한 재렌더·시트 재생성 방지)
    sheetPayload: null,   // 결과 패널 sheet.html iframe에 넘길 records 데이터
    dataset: null,          // 서버 data/dataset.json 문서
    dsSheetPayload: null,   // 데이터셋 패널 iframe 데이터
    editSheetPayload: null, // 편집 탭 전체 편집 시트 데이터
    modalSheetPayload: null,// modal 단일 행 시트 데이터
    sheetApplyPending: false,
    modalPullPending: false,
    user: "guest",          // 로그인 id — 추후 SSO에서 공급, 지금은 guest
  };

  // ---- fetch 헬퍼 (프록시 /apps/llm-data/ 뒤에서도 동작하도록 항상 상대경로) ----
  function parseResponse(r) {
    // _global 세션 만료 시 200 로그인 HTML로 리다이렉트되므로 JSON 파싱 전에 감지
    if (r.redirected && /\/login\b/.test(new URL(r.url).pathname)) {
      setDot(false);
      throw new Error("세션 만료 — 페이지를 새로고침해 다시 로그인하세요");
    }
    let parseFailed = false;
    return r.json().catch(() => { parseFailed = true; return {}; }).then((j) => {
      if (!r.ok || parseFailed) {
        throw Object.assign(
          new Error(j.error || ("응답 오류 (HTTP " + r.status + (parseFailed ? ", JSON 아님" : "") + ")")),
          { code: j.code });
      }
      setDot(true);
      return j;
    });
  }
  async function api(path) {
    const r = await fetch(path, { headers: { "Accept": "application/json" } });
    return parseResponse(r);
  }
  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
    });
    return parseResponse(r);
  }
  async function apiDelete(path) {
    const r = await fetch(path, { method: "DELETE", headers: { "Accept": "application/json" } });
    return parseResponse(r);
  }
  function setDot(ok) {
    const d = $("#svc-dot");
    d.classList.toggle("ok", ok);
    d.classList.toggle("err", !ok);
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- 스키마 v4: {schema_name, description, version, columns:[{group, fields:[...]}]} ----
  // field = {id(key), label, type, description, description_detail,
  //          mapping_logic_ip_eval_esd, mapping_logic_chatbot} (+ 선택 enum)
  // group은 표 헤더의 묶음(병합)일 뿐이고 레코드는 id를 key로 하는 평면 객체다.
  const FIELD_KEYS = ["id", "label", "type", "description", "description_detail",
    "mapping_logic_ip_eval_esd", "mapping_logic_chatbot"];
  const META_COLS = ["user_id", "created_at", "updated_at"];

  function schemaFields(schema) {
    const out = [];
    (((schema || {}).columns) || []).forEach((col) => {
      ((col || {}).fields || []).forEach((f) => {
        if (f && f.id) out.push(Object.assign({}, f, { group: col.group || "" }));
      });
    });
    return out;
  }
  function schemaFieldMap(schema) {
    const m = {};
    schemaFields(schema).forEach((f) => { if (!(f.id in m)) m[f.id] = f; });
    return m;
  }
  function schemaFieldIds(schema) { return schemaFields(schema).map((f) => f.id); }
  function schemaName(s) { return (s || {}).schema_name || (s || {}).title || ""; }

  // 열 id 목록 → 헤더 메타 (스키마에 없는 시스템/잔여 열은 group을 "meta"/""로)
  function colsMeta(cols, schema) {
    const m = schemaFieldMap(schema);
    return cols.map((c) => {
      const f = m[c];
      if (f) return { id: c, group: f.group || "", label: f.label || "", type: f.type || "", description: f.description || "" };
      const sys = c === "id" || META_COLS.indexOf(c) >= 0;
      return { id: c, group: sys ? "meta" : "", label: "", type: sys ? "string" : "", description: sys ? "시스템 관리 열 (편집 대상 아님)" : "" };
    });
  }

  // 표 헤더 4행 + group 병합행: group(병합) → description → id → type → label
  function tableHeadHtml(cols, schema) {
    const meta = colsMeta(cols, schema);
    let groupRow = "";
    for (let i = 0; i < meta.length;) {
      let j = i;
      while (j < meta.length && meta[j].group === meta[i].group) j += 1;
      const g = meta[i].group;
      groupRow += '<th class="hgroup' + (g ? "" : " nogroup") + '" colspan="' + (j - i) + '">' +
        esc(g || "") + "</th>";
      i = j;
    }
    const rowOf = (cls, pick) => "<tr>" + meta.map((f) =>
      '<th class="' + cls + '" title="' + esc(pick(f)) + '">' + esc(pick(f)) + "</th>").join("") + "</tr>";
    return "<thead>" +
      "<tr>" + groupRow + "</tr>" +
      rowOf("hdesc", (f) => f.description) +
      rowOf("hid", (f) => f.id) +
      rowOf("htype", (f) => f.type) +
      rowOf("hlabel", (f) => f.label) +
      "</thead>";
  }

  // ---- 초기 로드 ----
  async function init() {
    try {
      const [models, examples, jobs] = await Promise.all([
        api("api/models"), api("api/examples"), api("api/jobs?limit=30"),
      ]);
      const sel = $("#model");
      models.models.forEach((m) => {
        const o = document.createElement("option");
        o.value = m; o.textContent = m;
        if (m === models.default) o.selected = true;
        sel.appendChild(o);
      });
      state.examples = examples.examples || [];
      renderExampleButtons();
      if (!$("#schema").value) {
        const schema = await api("api/schema");
        $("#schema").value = JSON.stringify(schema, null, 2);
      }
      loadSettings();
      api("api/whoami").then((w) => {
        state.user = w.id || "guest";
        $("#login-id").textContent = state.user;
      }).catch(() => {});
      (jobs.jobs || []).slice().reverse().forEach((j) => upsertJob({
        id: j.id, mode: j.mode || "fill", state: j.state, model: j.model, preview: j.input_preview,
        created_ms: Date.parse(j.created_at || "") || Date.now(),
        started_at_ms: j.started_at_ms, latency_ms: j.latency_ms, error: j.error,
        record_count: j.record_count, steps: j.steps || [],
        cancel_requested: j.cancel_requested,
      }));
      // 서버 재기동 전 잡 중 미종료 상태가 남아 있으면 폴링 재개
      state.jobs.filter((j) => j.state === "queued" || j.state === "running").forEach(pollJob);
      updateCancelButton();
      renderHistory();
    } catch (e) {
      setDot(false);
      toast("초기화 실패: " + e.message);
    }
    refreshLlmStatus();
    // 라우팅 초기화: hash가 있으면 그 위치로 복원, 없으면 현재 탭을 entry 추가 없이 기록
    window.addEventListener("hashchange", applyRoute);
    if (/^#tab=/.test(location.hash)) applyRoute();
    else history.replaceState(null, "", location.pathname + location.search + "#tab=" + state.tab);
  }

  // ---- 잡 제출 ----
  function updateCancelButton() {
    $("#cancel").disabled = !state.jobs.some((j) => j.state === "queued" || j.state === "running");
  }

  function activeCancelTarget() {
    const sel = state.selected && findJob(state.selected);
    if (sel && (sel.state === "queued" || sel.state === "running")) return sel.id;
    const isActive = (j) => j.state === "queued" || j.state === "running";
    const inTab = state.jobs.find((j) => isActive(j) && (j.mode || "fill") === state.tab);
    const any = state.jobs.find(isActive);
    return (inTab && inTab.id) || (any && any.id);
  }

  // ---- 탭 ----
  function renderExampleButtons() {
    const bar = $("#example-btns");
    bar.innerHTML = "";
    state.examples.filter((ex) => (ex.mode || "fill") === state.tab).forEach((ex) => {
      const b = document.createElement("button");
      b.textContent = "예시: " + ex.label;
      b.addEventListener("click", () => {
        $("#input").value = ex.text;
        $("#schema").value = JSON.stringify(ex.schema, null, 2);
        toast("예시와 목표 스키마를 불러왔습니다");
      });
      bar.appendChild(b);
    });
  }

  function switchTab(tab) {
    if (tab === state.tab) return;
    const cur = state.tabState[state.tab];
    cur.input = $("#input").value;
    cur.schema = $("#schema").value;
    cur.selected = state.selected;
    state.tab = tab;
    const next = state.tabState[tab] || (state.tabState[tab] = { input: "", schema: "", selected: null });
    $("#input").value = next.input;
    if (next.schema) $("#schema").value = next.schema;
    state.selected = next.selected;
    document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    $("#tab-desc").textContent = TAB_DESC[tab] || "";
    // 편집·로그·마스터·대화 탭은 LLM 변환 UI 없이 각자의 뷰만 표시
    const noLlm = tab === "edit" || tab === "log" || tab === "master" || tab === "chat";
    ["#settings-panel", "#input-panel", "#schema-panel", "#actions-bar", "#history-panel"]
      .forEach((s) => { const el = $(s); if (el) el.hidden = noLlm; });
    renderExampleButtons();
    renderHistory();
    renderResult();
    if (noLlm) $("#result-panel").hidden = true;
    $("#dataset-panel").hidden = tab !== "dataset";
    $("#edit-panel").hidden = tab !== "edit";
    $("#log-panel").hidden = tab !== "log";
    $("#master-panel").hidden = tab !== "master";
    $("#chat-panel").hidden = tab !== "chat";
    if (tab === "dataset" || tab === "edit") refreshDataset();
    if (tab === "log") renderLogPanel();
    if (tab === "master") refreshMasters();
    if (tab === "chat") { refreshChats(); fetchLlmModels(); }
    pushRoute();
  }

  // ---- 라우팅: 탭·대화 목록·개별 대화를 hash로 표현 — 브라우저 뒤로/앞으로 가기 지원 ----
  const ROUTE_TABS = ["fill", "missing", "dataset", "edit", "log", "master", "chat"];
  let applyingRoute = false; // hashchange 적용 중 pushRoute 재진입 방지

  function pushRoute() {
    if (applyingRoute) return;
    let h = "#tab=" + state.tab;
    if (state.tab === "chat" && state.chatId) h += "&chat=" + state.chatId;
    if (location.hash !== h) location.hash = h; // 할당 = history entry 생성 → 뒤로가기 동작
  }

  async function applyRoute() {
    const m = /^#tab=([a-z]+)(?:&chat=([A-Za-z0-9-]+))?/.exec(location.hash || "");
    if (!m || !ROUTE_TABS.includes(m[1])) return;
    const tab = m[1], chat = m[2] || null;
    applyingRoute = true;
    try {
      if (tab !== state.tab) switchTab(tab);
      if (tab === "chat") {
        if (chat && chat !== state.chatId) await loadChatDoc(chat);
        else if (!chat && state.chatId) {
          // 대화 미지정 route = 목록(새 대화 대기) 상태
          state.chatId = null;
          state.chatDoc = null;
          $("#chat-system").value = DEFAULT_CHAT_SYSTEM;
          renderChatList();
          renderChatMessages();
        }
      }
    } finally { applyingRoute = false; }
  }

  async function submit() {
    const btn = $("#run");
    if (btn.disabled) return; // Ctrl+Enter·재시도 경로의 중복 제출 방지
    const text = $("#input").value;
    if (!text.trim()) { toast("원본 데이터를 붙여넣으세요"); return; }
    btn.disabled = true;
    $("#run-msg").textContent = "작업 생성 중…";
    $("#run-msg").classList.remove("err");
    try {
      const resp = await apiPost("api/jobs", {
        input_text: text,
        schema: $("#schema").value,
        model: $("#model").value,
        mode: state.tab,
      });
      upsertJob({
        id: resp.job_id, mode: state.tab, state: "queued", model: $("#model").value,
        preview: text.trim().replace(/\s+/g, " ").slice(0, 80),
        created_ms: Date.now(),
      });
      state.selected = resp.job_id;
      renderHistory();
      renderResult();
      $("#run-msg").textContent = "";
      updateCancelButton();
      pollJob(findJob(resp.job_id));
    } catch (e) {
      $("#run-msg").textContent = (e.code ? "(" + e.code + ") " : "") + e.message;
      $("#run-msg").classList.add("err");
    } finally {
      btn.disabled = false;
    }
  }

  function findJob(id) { return state.jobs.find((j) => j.id === id); }

  function upsertJob(j) {
    const cur = findJob(j.id);
    if (cur) Object.assign(cur, j);
    else state.jobs.unshift(j);
  }

  // ---- 폴링 (세대 토큰으로 중복 폴러 무효화, 연속 실패 백오프) ----
  async function pollJob(job) {
    if (!job) return;
    const myPoll = (job._poll = (job._poll || 0) + 1);
    let failures = 0;
    for (let i = 0; i < 900; i += 1) { // 1초 간격 최대 15분
      if (i > 0) await sleep(Math.min(1000 * Math.pow(2, failures), 5000));
      if (job._poll !== myPoll) return; // 재시도 등으로 새 폴러가 생기면 종료
      let doc;
      try {
        doc = await api("api/job?id=" + encodeURIComponent(job.id));
        failures = 0;
      } catch (e) {
        failures += 1;
        setDot(false);
        if (failures >= 8) {
          job.pollingStopped = true;
          renderHistory();
          return;
        }
        continue;
      }
      applyJobDoc(job, doc);
      renderHistory();
      if (state.selected === job.id) renderResult();
      if (doc.state === "done" || doc.state === "error" || doc.state === "cancelled") {
        updateCancelButton();
        return;
      }
    }
  }

  function applyJobDoc(job, doc) {
    job.state = doc.state;
    job.started_at_ms = doc.started_at_ms || job.started_at_ms;
    job.latency_ms = doc.latency_ms;
    job.error = doc.error;
    job.record_count = ((doc.result || {}).records || []).length;
    job.steps = doc.steps || job.steps || [];
    job.cancel_requested = doc.cancel_requested;
    state.fullJobs.set(job.id, doc); // 실행 중에도 흐름 패널이 전문(全文)을 실시간 표시
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---- 렌더링 ----
  function chipHtml(job) {
    if (job.state === "cancelled") return '<span class="chip wait">취소됨</span>';
    if ((job.state === "queued" || job.state === "running") && job.cancel_requested) {
      return '<span class="chip err"><span class="spin"></span> 취소 중…</span>';
    }
    if (job.state === "queued") return '<span class="chip wait">대기</span>';
    if (job.state === "running") {
      return '<span class="chip run"><span class="spin"></span> 변환 중 ' +
        timerHtml(job.started_at_ms || job.created_ms) + "</span>";
    }
    if (job.state === "done") {
      const sec = job.latency_ms != null ? (job.latency_ms / 1000).toFixed(1) + "초" : "";
      return '<span class="chip ok">완료 ' + sec + " · " + (job.record_count || 0) + "건</span>";
    }
    return '<span class="chip err">실패</span>';
  }

  function fmtDur(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "초";
  }

  function elapsedText(startMs) {
    return Math.max(0, Math.round((Date.now() - startMs) / 1000)) + "초";
  }

  // 재렌더링 시 "0초"로 초기화되면 1초 tick이 고칠 때까지 0초↔N초로 깜빡인다.
  // 처음부터 현재 경과값으로 그려서 리셋을 우회한다.
  function timerHtml(startMs) {
    const start = startMs || Date.now();
    return '<b data-timer data-start="' + start + '">' + elapsedText(start) + "</b>";
  }

  function stageStripHtml(steps) {
    if (!steps || !steps.length) return "";
    return '<span class="stages">' + steps.map((s) => {
      if (s.status === "done") return '<span class="stg ok">' + esc(s.label) + " ✓" + (s.duration_ms ? ' <i>' + fmtDur(s.duration_ms) + "</i>" : "") + "</span>";
      if (s.status === "running") return '<span class="stg run">' + esc(s.label) + " ⏳ " + timerHtml(s.started_at_ms) + "</span>";
      if (s.status === "error") return '<span class="stg err">' + esc(s.label) + " ✗</span>";
      return '<span class="stg wait">' + esc(s.label) + "</span>";
    }).join('<span class="sarw">›</span>') + "</span>";
  }

  function renderHistory() {
    const box = $("#history");
    const tabJobs = state.jobs.filter((j) => (j.mode || "fill") === state.tab);
    if (!tabJobs.length) {
      box.innerHTML = '<div class="empty">아직 작업이 없습니다. 예시를 불러와 변환을 실행해 보세요.</div>';
      return;
    }
    box.innerHTML = tabJobs.map((j) => {
      const err = j.error
        ? '<div class="jerr">(' + esc(j.error.code || "?") + ") " + esc(j.error.message || "") +
          ' <button class="retry" data-retry="' + esc(j.id) + '">재시도</button></div>'
        : "";
      const stopped = j.pollingStopped
        ? '<div class="jerr">상태 조회 중단됨 <button class="retry" data-resume="' + esc(j.id) + '">다시 확인</button></div>'
        : "";
      const del = (j.state === "done" || j.state === "error" || j.state === "cancelled")
        ? '<button class="delbtn" data-del="' + esc(j.id) + '" title="이력 삭제">✕</button>' : "";
      return '<div class="job' + (state.selected === j.id ? " sel" : "") + '" data-job="' + esc(j.id) + '">' +
        chipHtml(j) +
        '<span class="meta">' + esc(j.model || "") + "</span>" +
        '<span class="prev">' + esc(j.preview || "") + "</span>" +
        '<span class="meta">' + esc(j.id) + "</span>" + del +
        stageStripHtml(j.steps) + err + stopped + "</div>";
    }).join("");
  }

  function fmtCell(v, highlightMissing) {
    if (v === null || v === undefined || v === "") {
      return highlightMissing ? '<td class="miss"></td>' : '<td class="null">—</td>';
    }
    if (v === "PASS") return '<td class="pass">PASS</td>';
    if (v === "FAIL") return '<td class="fail">FAIL</td>';
    if (typeof v === "boolean") return '<td class="bool-' + v + '">' + (v ? "✓ true" : "✗ false") + "</td>";
    if (typeof v === "number") return '<td class="num">' + v + "</td>";
    if (Array.isArray(v)) return "<td>" + esc(v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(" → ")) + "</td>";
    if (typeof v === "object") return "<td>" + esc(JSON.stringify(v)) + "</td>";
    return "<td>" + esc(v) + "</td>";
  }

  function artifactHtml(id, title, text, note) {
    const body = text
      ? '<pre class="raw">' + esc(text) + "</pre>"
      : '<div class="empty">' + esc(note || "아직 없음") + "</div>";
    const chars = text ? " (" + text.length.toLocaleString() + "자)" : "";
    return '<details class="artifact" data-art="' + id + '"><summary>' + esc(title) + chars +
      "</summary>" + body + "</details>";
  }

  function flowHtml(doc) {
    const rows = (doc.steps || []).map((s) => {
      let stat = '<span class="chip wait">대기</span>';
      let dur = "";
      if (s.status === "running") {
        stat = '<span class="chip run"><span class="spin"></span> 수행 중</span>';
        dur = timerHtml(s.started_at_ms);
      } else if (s.status === "done") {
        stat = '<span class="chip ok">완료</span>';
        dur = fmtDur(s.duration_ms);
      } else if (s.status === "error") {
        stat = '<span class="chip err">오류</span>';
        dur = fmtDur(s.duration_ms);
      }
      return "<tr><td>" + esc(s.label) + "</td><td>" + stat + "</td><td>" + dur + "</td></tr>";
    }).join("");
    const req = doc.request || {};
    const resp = doc.response || {};
    const reqLine = req.url
      ? '<div class="reqline"><code>' + esc(req.method || "POST") + " " + esc(req.url) + "</code> · model <b>" +
        esc(req.model || "") + "</b> · payload " + (req.payload_bytes || 0).toLocaleString() + " bytes · response_format " +
        (req.response_format ? "YES" : "no") + " · timeout " + (req.timeout_s || "?") + "s</div>"
      : '<div class="empty">LLM 요청 정보는 프롬프트 구성 후 표시됩니다.</div>';
    const reqHeaders = req.url
      ? (req.headers
        ? '<h4>headers (토큰 마스킹)</h4><pre class="raw">' + esc(JSON.stringify(req.headers, null, 2)) + "</pre>"
        : '<div class="hint">headers 기록 추가 전에 실행된 작업이라 headers 전문이 없습니다 — 새 변환부터 표시됩니다.</div>')
      : "";
    return '<div class="rsec"><h3>진행 흐름</h3>' +
      '<div class="tblwrap"><table><thead><tr><th>단계</th><th>상태</th><th>걸린 시간</th></tr></thead><tbody>' +
      rows + "</tbody></table></div></div>" +
      '<div class="rsec"><h3>LLM request</h3>' + reqLine + reqHeaders + "</div>" +
      artifactHtml("input", "입력 전문", doc.input_text, "") +
      artifactHtml("system", "시스템 프롬프트 전문 (스키마 치환 완료본)", req.system_prompt, "프롬프트 구성 단계에서 생성됩니다…") +
      (req.payload ? artifactHtml("reqbody", "LLM 전송 body 전문", JSON.stringify(req.payload, null, 2), "") : "") +
      artifactHtml("response", "LLM 원문 응답", resp.raw_content, "LLM 수행이 끝나면 표시됩니다…");
  }

  function renderResult() {
    const panel = $("#result-panel");
    const doc = state.selected && state.fullJobs.get(state.selected);
    const job = state.selected && findJob(state.selected);
    if (!job) { panel.hidden = true; state.renderedKey = null; state.sheetPayload = null; return; }
    // 종결된 잡을 같은 탭에서 다시 그리는 경우는 no-op — 카드 재클릭마다
    // innerHTML 재구축 + luckysheet 재생성이 반복되며 브라우저가 멈추는 것을 방지
    const terminal = doc && (doc.state === "done" || doc.state === "error" || doc.state === "cancelled");
    const key = job.id + "|" + (doc ? doc.state : "none") + "|" + state.tab;
    if (terminal && state.renderedKey === key) { panel.hidden = false; return; }
    state.renderedKey = key;
    state.sheetPayload = null;
    panel.hidden = false;
    $("#result-jobid").textContent = job.id;
    const box = $("#result");
    if (!doc) {
      box.innerHTML = '<div class="empty">' +
        (job.state === "running" || job.state === "queued" ? "상태를 불러오는 중…" : "결과 없음") + "</div>";
      return;
    }
    // 재렌더링 전에 열려 있던 아티팩트를 기억해 열림 상태를 유지한다
    const openArts = new Set([...box.querySelectorAll("details.artifact[open]")].map((d) => d.getAttribute("data-art")));
    let html = flowHtml(doc);
    if (doc.state === "error") {
      html += '<div class="jerr">(' + esc((doc.error || {}).code || "?") + ") " +
        esc((doc.error || {}).message || "") + "</div>";
      box.innerHTML = html;
      openArts.forEach((id) => { const d = box.querySelector('details[data-art="' + id + '"]'); if (d) d.open = true; });
      return;
    }
    if (doc.state !== "done") {
      box.innerHTML = html;
      openArts.forEach((id) => { const d = box.querySelector('details[data-art="' + id + '"]'); if (d) d.open = true; });
      return;
    }
    const res = doc.result || {};
    const cols = schemaFieldIds(doc.schema);
    (res.records || []).forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));

    const missMode = (doc.mode || "fill") === "missing";
    const schemaCols = schemaFieldIds(doc.schema);
    let missCount = 0;
    if (missMode) {
      (res.records || []).forEach((r) => schemaCols.forEach((c) => {
        const v = r[c];
        if (v === null || v === undefined || v === "") missCount += 1;
      }));
    }
    html += '<div class="rsec"><h3>records (' + (res.records || []).length + "건)" +
      (missMode ? '<span class="misscount">빈 값 ' + missCount + "셀</span>" : "") +
      '</h3><div class="tblwrap"><table class="schematbl">' + tableHeadHtml(cols, doc.schema) + "<tbody>" +
      (res.records || []).map((r) => "<tr>" + cols.map((c) => fmtCell(r[c], missMode)).join("") + "</tr>").join("") +
      "</tbody></table></div></div>";
    if ((doc.mode || "fill") === "dataset") {
      const inserted = state.dataset && (state.dataset.inserted_jobs || []).includes(doc.id);
      html += '<div class="rsec"><button class="insertbtn" data-ds-insert="' + esc(doc.id) + '"' +
        (inserted ? " disabled" : "") + ">" +
        (inserted ? "데이터셋에 추가됨" : "데이터셋에 " + (res.records || []).length + "행 추가") +
        "</button></div>";
    }
    html += '<div class="rsec"><h3>Excel 뷰 (Luckysheet)</h3><iframe id="sheet-frame" class="sheetframe" src="sheet.html" title="records excel view"></iframe></div>';

    if ((res.mapping || []).length) {
      html += '<div class="rsec"><h3>mapping (열 매핑 근거)</h3><div class="tblwrap"><table><thead><tr><th>원본 열</th><th>스키마 필드</th><th>변환 규칙</th></tr></thead><tbody>' +
        res.mapping.map((m) => "<tr><td>" + esc(m.source) + "</td><td>" +
          esc(Array.isArray(m.target) ? m.target.join(", ") : m.target) + "</td><td>" + esc(m.rule || "") + "</td></tr>").join("") +
        "</tbody></table></div></div>";
    }
    if ((res.unmapped || []).length) {
      html += '<div class="rsec"><h3>unmapped (스키마 밖 원본 열)</h3><div class="tblwrap"><table><thead><tr><th>원본 열</th><th>사유</th><th>값 예시</th></tr></thead><tbody>' +
        res.unmapped.map((u) => "<tr><td>" + esc(u.source) + "</td><td>" + esc(u.reason || "") + "</td><td>" +
          esc((u.values_sample || []).join(", ")) + "</td></tr>").join("") +
        "</tbody></table></div></div>";
    }
    if ((res.warnings || []).length) {
      html += '<div class="rsec"><h3>warnings</h3><ul class="warnings">' +
        res.warnings.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul></div>";
    }
    const u = doc.usage || {};
    if (u.total_tokens) {
      html += '<div class="usage">tokens: ' + esc(u.prompt_tokens) + " in / " + esc(u.completion_tokens) + " out · model " + esc(doc.model || "") + "</div>";
    }
    html += '<div class="rsec"><h3>결과 JSON</h3><pre class="raw">' + esc(JSON.stringify(res, null, 2)) + "</pre></div>";
    box.innerHTML = html;
    openArts.forEach((id) => { const d = box.querySelector('details[data-art="' + id + '"]'); if (d) d.open = true; });
    // luckysheet는 sheet.html iframe 안에서만 실행된다 (destroy가 문서 핸들러를
    // 못 정리하는 싱글턴이라 본문에 직접 올리면 잡 전환마다 누적돼 멈춤).
    // iframe이 로드를 마치고 sheet-ready를 보내면 아래 payload를 넘긴다.
    state.sheetPayload = { records: res.records || [], cols: cols, missMode: missMode,
      fields: colsMeta(cols, doc.schema) };
  }

  // sheet.html iframe 핸드셰이크: iframe이 새로 만들어질 때마다 ready 신호를 보낸다.
  // 결과 패널(#sheet-frame)과 데이터셋 패널(#ds-sheet-frame) 둘 다 source로 구분해 라우팅.
  window.addEventListener("message", (ev) => {
    if (ev.origin !== location.origin) return;
    const d = ev.data || {};
    if (d.type === "dataset-saved") {
      $("#ds-file").textContent = d.file;
      if (state.dataset) state.dataset.file = d.file;
      toast(d.count + "행을 " + d.file + " 에 저장했습니다" + (d.saved_as_new ? " (새 파일)" : " (덮어쓰기)"));
      if (d.saved_as_new) refreshDataset(); // 드롭다운 파일 목록에 새 파일 반영
      return;
    }
    if (d.type === "dataset-save-failed") {
      toast("저장 실패: " + d.message);
      return;
    }
    if (d.type === "dataset-loaded") {
      toast(d.file + " 로드 완료 (" + d.count + "행)");
      refreshDataset();
      return;
    }
    if (d.type === "sheet-rows") {
      const ef = document.getElementById("edit-sheet-frame");
      const mf = document.getElementById("modal-sheet-frame");
      if (ef && ev.source === ef.contentWindow && state.sheetApplyPending) {
        state.sheetApplyPending = false;
        validateSheetAndShowModal(d.rows || [], d.header || []);
      } else if (mf && ev.source === mf.contentWindow && state.modalPullPending) {
        state.modalPullPending = false;
        const row = (d.rows || [])[0] || {};
        Object.keys(row).forEach((k) => applySheetValueToForm(k, row[k]));
        toast("시트 값을 폼으로 가져왔습니다");
      }
      return;
    }
    if (d.type === "edit-blocked") {
      toast(d.what + "은(는) 편집할 수 없습니다" +
        (String(d.what).indexOf("헤더") !== -1 ? " — 스키마 변경은 마스터 관리 탭에서 하세요" : " (자동 관리 열)"));
      return;
    }
    if (d.type === "cell-edited") {
      const mf = document.getElementById("modal-sheet-frame");
      if (mf && ev.source === mf.contentWindow && d.colName) applySheetValueToForm(d.colName, d.value);
      return;
    }
    if (d.type !== "sheet-ready") return;
    // iframe 4종(잡 결과 / 데이터셋 / 전체 편집 / modal 단일 행)을 source로 구분해 payload 전달
    [["sheet-frame", state.sheetPayload],
     ["ds-sheet-frame", state.dsSheetPayload],
     ["edit-sheet-frame", state.editSheetPayload],
     ["modal-sheet-frame", state.modalSheetPayload]].forEach(([id, payload]) => {
      const el = document.getElementById(id);
      if (el && ev.source === el.contentWindow && payload) {
        el.contentWindow.postMessage({ type: "render-records", payload: payload }, location.origin);
      }
    });
  });

  // ---- 데이터셋 (LLM 변환 결과를 기존 표에 새 행으로 insert) ----
  function datasetCols(ds) {
    const cols = schemaFieldIds(ds.schema);
    // 시스템 열은 스키마 열 바로 우측에 항상 표시. 내부 식별자 id와 _job은 표시 제외
    META_COLS.forEach((m) => { if (!cols.includes(m)) cols.push(m); });
    (ds.rows || []).forEach((r) => Object.keys(r).forEach((k) => {
      if (k !== "_job" && k !== "id" && !cols.includes(k)) cols.push(k);
    }));
    return cols;
  }

  async function refreshDataset() {
    try {
      const [ds, files] = await Promise.all([api("api/dataset"), api("api/dataset/files")]);
      state.dataset = ds;
      state.datasetFiles = files.files || [];
    } catch (e) {
      state.dataset = null;
      state.datasetFiles = [];
    }
    renderDataset();
    renderEditPanel();
  }

  function renderDataset() {
    const panel = $("#dataset-panel");
    panel.hidden = state.tab !== "dataset";
    if (panel.hidden) return;
    const ds = state.dataset;
    const box = $("#dataset-table");
    const wrap = $("#ds-sheet-wrap");
    if (!ds || !(ds.rows || []).length) {
      $("#ds-count").textContent = "(비어 있음)";
      box.innerHTML = '<div class="empty">아직 데이터가 없습니다. 변환 완료 후 결과의 "데이터셋에 추가" 버튼으로 행을 쌓으세요.</div>';
      wrap.innerHTML = "";
      state.dsSheetPayload = null;
      return;
    }
    const cols = datasetCols(ds);
    const lastJob = (ds.last_insert || {}).job_id;
    $("#ds-file").textContent = ds.file || "dataset.json";
    $("#ds-count").textContent = "누적 " + ds.rows.length + "행" +
      (ds.last_insert ? " · 최근 추가 " + ds.last_insert.count + "행" : "");
    box.innerHTML = '<div class="tblwrap"><table class="schematbl">' + tableHeadHtml(cols, ds.schema) + "<tbody>" +
      ds.rows.map((r) => '<tr class="' + (lastJob && r._job === lastJob ? "newrow" : "") + '">' +
        cols.map((c) => fmtCell(r[c], false)).join("") + "</tr>").join("") +
      "</tbody></table></div>";
    // 데이터셋 Excel 뷰: iframe째 재생성 (luckysheet 격리 규약)
    wrap.innerHTML = '<iframe id="ds-sheet-frame" class="sheetframe" src="sheet.html" title="dataset excel view"></iframe>';
    const highlightRows = [];
    ds.rows.forEach((r, i) => { if (lastJob && r._job === lastJob) highlightRows.push(i); });
    state.dsSheetPayload = {
      records: ds.rows.map((r) => { const o = {}; cols.forEach((c) => { o[c] = r[c]; }); return o; }),
      cols: cols,
      fields: colsMeta(cols, ds.schema),
      file: ds.file || "dataset.json", // 시트 툴바 드롭다운의 현재 파일
      files: state.datasetFiles || [],
      user: state.user,
    };
  }

  // ---- 데이터셋 편집 탭: HTML 표 + 행 클릭 편집 / 새 행 추가 (modal CRUD) ----
  function renderEditPanel() {
    const panel = $("#edit-panel");
    if (panel.hidden) return;
    const ds = state.dataset;
    const sel = $("#edit-file-select");
    sel.innerHTML = "";
    (state.datasetFiles || []).forEach((n) => {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
    if (ds && ds.file) {
      if (![...sel.options].some((o) => o.value === ds.file)) {
        const o = document.createElement("option");
        o.value = ds.file; o.textContent = ds.file;
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = ds.file;
    }
    const box = $("#edit-table");
    if (!ds || !(ds.rows || []).length) {
      box.innerHTML = '<div class="empty">데이터가 없습니다. 파일을 선택하거나 "+ 새 행"으로 시작하세요.</div>';
      $("#edit-sheet-wrap").innerHTML = "";
      state.editSheetPayload = null;
      return;
    }
    const cols = datasetCols(ds);
    box.innerHTML = '<div class="tblwrap"><table class="schematbl">' + tableHeadHtml(cols, ds.schema) + "<tbody>" +
      ds.rows.map((r) => '<tr data-rowid="' + r.id + '">' +
        cols.map((c) => fmtCell(r[c], false)).join("") + "</tr>").join("") +
      "</tbody></table></div>";
    // 전체 편집용 Luckysheet — id 열을 맨 앞에 두고 데이터 기준으로 재생성
    const editCols = ["id"].concat(cols);
    state.editSheetPayload = {
      records: ds.rows.map((r) => {
        const o = { id: r.id };
        cols.forEach((c) => { o[c] = r[c]; });
        return o;
      }),
      cols: editCols,
      fields: colsMeta(editCols, ds.schema),
      idCol: "id",
      metaCols: META_COLS, // 편집 대상 아님 — 회색 표시, 반영 시 무시
    };
    $("#edit-sheet-wrap").innerHTML =
      '<iframe id="edit-sheet-frame" class="sheetframe" src="sheet.html" title="dataset bulk edit"></iframe>';
  }

  // ---- 시트 값 → 데이터셋 반영 (전체 편집) / 폼 반영 (단일 행) ----
  function coerceBySpec(spec, v) {
    if (v === null || v === undefined || v === "") return null;
    const types = [].concat((spec && spec.type) || []);
    if (typeof v === "boolean") return v;
    if (types.includes("boolean")) {
      const s = String(v).trim().toUpperCase();
      return s === "TRUE" ? true : (s === "FALSE" ? false : null);
    }
    if (types.includes("array")) {
      if (Array.isArray(v)) return v.map(String);
      return String(v).split(/→|,/).map((s) => s.trim()).filter(Boolean); // 항목도 string 유지
    }
    // 저장 데이터는 모두 string — number 타입 스키마가 와도 문자열로 보관
    return String(v);
  }

  function validateSheetAndShowModal(sheetRows, header) {
    // "시트 변경사항 적용" = 정합성 검증 → modal로 결과 표시.
    // 위반이 있으면 저장 불가, 없으면 변경 요약과 함께 저장 버튼 활성화.
    const ds = state.dataset;
    if (!ds || !ds.schema) { toast("데이터셋 스키마가 없습니다"); return; }
    const props = schemaFieldMap(ds.schema);
    const violations = [];

    // ① 헤더(스키마) 정합성
    const expected = (state.editSheetPayload && state.editSheetPayload.cols) || [];
    const missing = expected.filter((c) => !header.includes(c));
    const extra = header.filter((c) => !expected.includes(c));
    missing.forEach((c) => violations.push("헤더: '" + c + "' 열이 변경되거나 삭제됨 — 스키마 변경은 마스터 관리 탭에서"));
    extra.forEach((c) => violations.push("헤더: 스키마에 없는 열 '" + c + "' 추가됨"));

    const rows = sheetRows.map((sr) => {
      const values = {};
      Object.keys(props).forEach((k) => { values[k] = coerceBySpec(props[k], sr[k]); });
      Object.keys(sr).forEach((k) => {
        if (!(k in values) && k !== "id" && META_COLS.indexOf(k) < 0) values[k] = sr[k];
      });
      return { id: sr.id == null || sr.id === "" ? null : String(sr.id), values: values };
    });

    // ② 코드(enum) 정합성
    Object.keys(props).forEach((k) => {
      const spec = props[k];
      if (!spec || !Array.isArray(spec.enum)) return;
      rows.forEach((pr) => {
        const v = pr.values[k];
        if (v !== null && v !== undefined && v !== "" && !spec.enum.includes(v)) {
          violations.push("행 " + (pr.id || "신규") + ": '" + k + "' 값 '" + v + "' — 허용 코드: " + spec.enum.join(", "));
        }
      });
    });

    // 변경 요약 (수정/추가/삭제)
    const byId = {};
    (ds.rows || []).forEach((r) => { byId[String(r.id)] = r; });
    let updated = 0, created = 0;
    rows.forEach((pr) => {
      if (pr.id && byId[pr.id]) {
        const row = byId[pr.id];
        if (Object.keys(pr.values).some((k) => (row[k] == null ? null : row[k]) !== (pr.values[k] == null ? null : pr.values[k]))) updated += 1;
      } else {
        created += 1;
      }
    });
    const sheetIds = new Set(rows.map((r) => r.id).filter(Boolean));
    const deleted = (ds.rows || []).map((r) => String(r.id)).filter((id) => !sheetIds.has(id));

    state.pendingBulk = violations.length ? null : rows;
    modalCtx = { kind: "validate" };
    $("#modal-sheet-sec").hidden = true;
    $("#modal-delete").hidden = true;
    $("#modal-title").textContent = "시트 변경사항 정합성 검증";
    $("#modal-save").textContent = "저장";
    $("#modal-save").disabled = violations.length > 0; // 정합성 못 맞추면 저장 불가
    const delPreview = deleted.slice(0, 20).join(", ") + (deleted.length > 20 ? " 외 " + (deleted.length - 20) + "건" : "");
    $("#modal-form").innerHTML =
      (violations.length
        ? '<div class="jerr">정합성 위반 ' + violations.length + "건 — 아래 항목을 수정한 뒤 다시 \"시트 변경사항 적용\"으로 검증하세요. 저장할 수 없습니다.</div>" +
          '<ul class="vlist">' + violations.map((v) => "<li>" + esc(v) + "</li>").join("") + "</ul>"
        : '<div class="vok">✓ 모두 정합성이 맞습니다. 아래 요약을 확인하고 저장하세요.</div>') +
      '<div class="rsec"><h3>변경 요약</h3><ul class="vsum">' +
      "<li>수정: " + updated + "행</li>" +
      "<li>추가: " + created + "행</li>" +
      "<li>삭제: " + deleted.length + "행" + (deleted.length ? " (id: " + esc(delPreview) + ")" : "") + "</li>" +
      "</ul></div>";
    $("#modal-overlay").hidden = false;
  }

  function saveValidatedBulk() {
    if (!state.pendingBulk) { closeModal(); return; }
    apiPost("api/dataset/bulk", { rows: state.pendingBulk, user: state.user }).then((r) => {
      toast("저장 완료: 수정 " + r.updated + " · 추가 " + r.created + " · 삭제 " + r.deleted + " (총 " + r.total + "행)");
      state.pendingBulk = null;
      closeModal();
      refreshDataset();
    }).catch((e) => toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  }

  function applySheetValueToForm(k, val) {
    const el = document.querySelector('#modal-form [data-field="' + k + '"]');
    if (!el) return;
    if (el.tagName === "SELECT") {
      if (val === null || val === undefined || val === "") { el.value = ""; return; }
      const s = String(val);
      const up = s.toUpperCase();
      el.value = (up === "TRUE" || up === "FALSE") ? up.toLowerCase() : s;
      if (el.selectedIndex === -1) el.value = ""; // enum에 없는 값이면 null 취급
    } else {
      el.value = val == null ? "" : String(val);
    }
  }

  $("#edit-apply").addEventListener("click", () => {
    const ef = document.getElementById("edit-sheet-frame");
    if (!ef) { toast("편집할 시트가 없습니다"); return; }
    state.sheetApplyPending = true;
    ef.contentWindow.postMessage({ type: "get-rows" }, location.origin);
  });
  $("#edit-sheet-reset").addEventListener("click", () => {
    refreshDataset();
    toast("시트를 데이터셋 기준으로 되돌렸습니다");
  });
  $("#modal-sheet-pull").addEventListener("click", () => {
    const mf = document.getElementById("modal-sheet-frame");
    if (!mf) return;
    state.modalPullPending = true;
    mf.contentWindow.postMessage({ type: "get-rows" }, location.origin);
  });

  let modalCtx = null; // {mode: 'create'|'edit', id}

  function fieldHtml(k, spec, val) {
    const types = [].concat((spec && spec.type) || []);
    const desc = esc((spec && spec.description) || "");
    let input;
    if (spec && spec.enum) {
      input = '<select data-field="' + esc(k) + '"><option value="">(null)</option>' +
        spec.enum.map((e) => '<option value="' + esc(e) + '"' + (val === e ? " selected" : "") + ">" + esc(e) + "</option>").join("") +
        "</select>";
    } else if (types.includes("boolean")) {
      input = '<select data-field="' + esc(k) + '"><option value="">(null)</option>' +
        '<option value="true"' + (val === true ? " selected" : "") + ">true</option>" +
        '<option value="false"' + (val === false ? " selected" : "") + ">false</option></select>";
    } else if (types.includes("array")) {
      const s = Array.isArray(val) ? val.join(" → ") : (val == null ? "" : String(val));
      input = '<input data-field="' + esc(k) + '" data-type="array" value="' + esc(s) + '" placeholder="값1 → 값2 → 값3">';
    } else if (types.includes("integer") || types.includes("number")) {
      input = '<input data-field="' + esc(k) + '" data-type="' + (types.includes("integer") ? "integer" : "number") +
        '" value="' + (val == null ? "" : esc(val)) + '">';
    } else {
      input = '<input data-field="' + esc(k) + '" value="' + (val == null ? "" : esc(val)) + '">';
    }
    const shown = spec && spec.label ? spec.label : k;
    return '<label class="mfield"><span title="id: ' + esc(k) + (desc ? " — " + desc : "") + '">' + esc(shown) + "</span>" + input + "</label>";
  }

  function openRowModal(row) {
    const ds = state.dataset;
    if (!ds || !schemaFieldIds(ds.schema).length) { toast("먼저 데이터셋 파일을 로드하세요 (스키마 필요)"); return; }
    modalCtx = { kind: "row", mode: row ? "edit" : "create", id: row ? row.id : null };
    $("#modal-save").disabled = false;
    $("#modal-sheet-sec").hidden = false;
    $("#modal-title").textContent = row ? "행 편집" : "새 행 추가";
    $("#modal-delete").hidden = !row;
    $("#modal-save").textContent = row ? "저장" : "추가";
    const props = schemaFieldMap(ds.schema);
    $("#modal-form").innerHTML = schemaFields(ds.schema).map((f) => fieldHtml(f.id, props[f.id], row ? row[f.id] : null)).join("") +
      (row ? '<div class="meta-ro">user_id ' + esc(row.user_id || "") + " · created " + esc(row.created_at || "") +
             " · updated " + esc(row.updated_at || "") + " (자동 관리 — 편집 불가)</div>" : "");
    // 단일 행 Luckysheet: 전체 편집 시트와 동일 구성(id + 스키마 + meta 열), 헤더 + 이 행만.
    // 셀 수정은 폼으로 즉시 동기화 (id·meta 열은 폼 필드가 없어 자연히 무시됨)
    const sheetCols = datasetCols(ds);
    const sheetRow = { id: row ? row.id : null };
    sheetCols.forEach((k) => { sheetRow[k] = row ? row[k] : null; });
    const modalCols = ["id"].concat(sheetCols);
    state.modalSheetPayload = {
      records: [sheetRow],
      cols: modalCols,
      fields: colsMeta(modalCols, ds.schema),
      idCol: "id",
      metaCols: META_COLS,
      syncEdits: true,
      single: true,
    };
    $("#modal-sheet-wrap").innerHTML =
      '<iframe id="modal-sheet-frame" class="sheetframe" src="sheet.html" title="single row edit"></iframe>';
    $("#modal-overlay").hidden = false;
  }

  function closeModal() {
    $("#modal-overlay").hidden = true;
    $("#modal-sheet-wrap").innerHTML = "";
    state.modalSheetPayload = null;
    state.pendingBulk = null;
    $("#modal-save").disabled = false;
    $("#modal-save").hidden = false;
    $("#modal-cancel").textContent = "취소";
    modalCtx = null;
  }

  function collectModalValues() {
    const values = {};
    document.querySelectorAll("#modal-form [data-field]").forEach((el) => {
      const k = el.getAttribute("data-field");
      const t = el.getAttribute("data-type");
      const v = el.value;
      if (v === "") { values[k] = null; return; }
      if (el.tagName === "SELECT") {
        values[k] = v; // 저장 데이터는 모두 string — enum 코드 문자열 그대로
      } else if (t === "array") {
        values[k] = v.split(/→|,/).map((s) => s.trim()).filter(Boolean); // 항목도 string 유지
      } else {
        values[k] = v; // 저장 데이터는 모두 string
      }
    });
    return values;
  }

  $("#modal-save").addEventListener("click", () => {
    if (!modalCtx) return;
    if (modalCtx.kind === "validate") { saveValidatedBulk(); return; }
    if (modalCtx.kind === "field") { saveFieldFromModal(); return; }
    const values = collectModalValues();
    const req = modalCtx.mode === "edit"
      ? apiPost("api/dataset/row/update", { id: modalCtx.id, values: values, user: state.user })
      : apiPost("api/dataset/row/create", { values: values, user: state.user });
    req.then((r) => {
      toast(modalCtx && modalCtx.mode === "edit" ? "행을 저장했습니다 (변경 " + (r.changed != null ? r.changed : "?") + "필드)" : "새 행을 추가했습니다");
      closeModal();
      refreshDataset();
    }).catch((e) => toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  });
  $("#modal-delete").addEventListener("click", () => {
    if (!modalCtx) return;
    if (modalCtx.kind === "field") {
      deleteFieldGuarded();
      return;
    }
    if (modalCtx.mode !== "edit") return;
    if (!window.confirm("이 행을 삭제할까요?")) return;
    apiPost("api/dataset/row/delete", { id: modalCtx.id, user: state.user }).then(() => {
      toast("행을 삭제했습니다");
      closeModal();
      refreshDataset();
    }).catch((e) => toast("삭제 실패: " + e.message));
  });
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-cancel").addEventListener("click", closeModal);
  $("#modal-overlay").addEventListener("click", (e) => { if (e.target === $("#modal-overlay")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal-overlay").hidden) closeModal(); });

  $("#edit-add-row").addEventListener("click", () => openRowModal(null));
  $("#edit-refresh").addEventListener("click", refreshDataset);
  $("#edit-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-rowid]");
    if (!tr) return;
    const row = (state.dataset && state.dataset.rows || []).find((r) => String(r.id) === tr.getAttribute("data-rowid"));
    if (row) openRowModal(row);
  });
  $("#edit-file-select").addEventListener("change", () => {
    const name = $("#edit-file-select").value;
    const cur = state.dataset && state.dataset.file;
    if (name === cur) return;
    if (!window.confirm("'" + name + "' 파일을 로드합니다.\n저장하지 않은 현재 데이터셋 변경은 사라집니다. 계속할까요?")) {
      if (cur) $("#edit-file-select").value = cur;
      return;
    }
    apiPost("api/dataset/load", { file: name, user: state.user }).then((r) => {
      toast(r.file + " 로드 완료 (" + r.count + "행)");
      refreshDataset();
    }).catch((e) => {
      if (cur) $("#edit-file-select").value = cur;
      toast("로드 실패: " + e.message);
    });
  });

  // ---- 마스터 관리 탭 (스키마 + 코드 테이블) ----
  async function refreshMasters(selectName) {
    let masters = [];
    try {
      masters = (await api("api/masters")).masters || [];
    } catch (e) { /* 아래에서 빈 목록 처리 */ }
    state.masters = masters;
    const fill = (sel) => {
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = "";
      masters.forEach((m) => {
        const o = document.createElement("option");
        o.value = m.name;
        o.textContent = m.name + " (" + m.fields + "필드 · 코드 " + m.codes + ")";
        sel.appendChild(o);
      });
      if (selectName && masters.some((m) => m.name === selectName)) sel.value = selectName;
      else if (cur && masters.some((m) => m.name === cur)) sel.value = cur;
    };
    fill($("#master-select"));
    fill($("#schema-master-pick"));
    if (!$("#master-panel").hidden && masters.length) loadMaster($("#master-select").value);
    if (!$("#master-panel").hidden && !masters.length) {
      $("#master-json").value = "";
      $("#master-fields").innerHTML = '<div class="empty">마스터가 없습니다. "새 스키마"로 시작하세요.</div>';
    }
  }

  async function loadMaster(name) {
    if (!name) return;
    try {
      const m = await api("api/master?name=" + encodeURIComponent(name));
      state.masterName = m.name;
      renderMasterEditor(m.schema);
    } catch (e) { toast("마스터 로드 실패: " + e.message); }
  }

  function renderMasterEditor(schema) {
    state.masterSchema = schema;
    $("#master-json").value = JSON.stringify(schema, null, 2); // 결과물 (읽기 전용)
    renderMasterFields();
  }

  function renderMasterFields() {
    const schema = state.masterSchema || {};
    const cols = schema.columns || [];
    const total = schemaFields(schema).length;
    const head = '<div class="mschemahead">' +
      '<label class="mfield inline"><span>schema_name</span><input id="msch-name" value="' + esc(schema.schema_name || "") + '"></label>' +
      '<label class="mfield inline"><span>version</span><input id="msch-ver" value="' + esc(schema.version || "") + '"></label>' +
      '<label class="mfield inline wide"><span>description</span><input id="msch-desc" value="' + esc(schema.description || "") + '"></label>' +
      "</div>";
    if (!total) {
      $("#master-fields").innerHTML = head + '<div class="empty">필드가 없습니다. "+ 새 필드"로 추가하세요.</div>';
      return;
    }
    // group(묶음)별 소제목 + 필드 표. 행 클릭 시 편집 modal
    $("#master-fields").innerHTML = head + cols.map((col) => {
      const g = col.group || "";
      return '<div class="mgroup"><div class="mgrouphd">' + ICON_FOLDER + " " +
        esc(g || "(group 없음)") + '<span class="pcount">' + ((col.fields || []).length) + "</span>" +
        '<button class="iconbtn grename" data-group="' + esc(g) + '" type="button" title="group 이름 변경">' + ICON_EDIT + "</button></div>" +
        '<div class="tblwrap"><table><thead><tr>' +
        "<th>id (key)</th><th>label</th><th>type</th><th>description</th><th>description_detail</th>" +
        "<th>mapping_logic_ip_eval_esd</th><th>mapping_logic_chatbot</th><th>enum (코드)</th></tr></thead><tbody>" +
        (col.fields || []).map((f) => {
          const codes = Array.isArray(f.enum) ? f.enum.join(", ") : "";
          const cell = (v) => "<td>" + (v ? esc(v) : '<span class="null">—</span>') + "</td>";
          return '<tr data-mfield="' + esc(f.id) + '"><td>' + esc(f.id) + "</td>" +
            cell(f.label) + "<td>" + esc(f.type || "string") + "</td>" +
            cell(f.description) + cell(f.description_detail) +
            cell(f.mapping_logic_ip_eval_esd) + cell(f.mapping_logic_chatbot) + cell(codes) + "</tr>";
        }).join("") + "</tbody></table></div></div>";
    }).join("");
  }

  function openFieldModal(fieldName) {
    if (!state.masterSchema) { toast("마스터를 먼저 선택하세요"); return; }
    const schema = state.masterSchema;
    const spec = fieldName ? (schemaFieldMap(schema)[fieldName] || {}) : {};
    const groups = (schema.columns || []).map((c) => c.group || "");
    modalCtx = { kind: "field", name: fieldName };
    $("#modal-save").disabled = false;
    $("#modal-title").textContent = fieldName ? "필드 편집 — " + fieldName : "새 필드 추가";
    $("#modal-delete").hidden = !fieldName;
    $("#modal-save").textContent = fieldName ? "저장" : "추가";
    $("#modal-sheet-sec").hidden = true;
    const cur = fieldName ? (spec.group || "") : (groups[0] || "");
    const line = (mf, label, val, ph) =>
      '<label class="mfield"><span>' + label + '</span><input data-mf="' + mf + '" value="' +
      esc(val || "") + '" placeholder="' + esc(ph || "") + '"></label>';
    $("#modal-form").innerHTML =
      '<label class="mfield"><span>group (표 묶음)</span><select data-mf="group">' +
      groups.map((g) => '<option value="' + esc(g) + '"' + (g === cur ? " selected" : "") + ">" +
        esc(g || "(group 없음)") + "</option>").join("") +
      '<option value="__new__">+ 새 group…</option></select></label>' +
      '<label class="mfield" id="mf-newgroup-wrap" hidden><span>새 group 이름</span><input data-mf="newgroup" value=""></label>' +
      line("name", "id (key)", fieldName || "", "영문·숫자·_") +
      line("label", "label (표시명)", spec.label, "예: 시료 번호") +
      line("type", "type", spec.type || "string", "string") +
      line("desc", "description", spec.description, "필드의 의미") +
      line("desc2", "description_detail", spec.description_detail, "상세 규칙 (없으면 비움)") +
      line("mlogic1", "mapping_logic_ip_eval_esd", spec.mapping_logic_ip_eval_esd, "원본 열에서 가져오는 방법") +
      line("mlogic2", "mapping_logic_chatbot", spec.mapping_logic_chatbot, "챗봇 매핑 지침") +
      line("codes", "enum (코드 테이블)", Array.isArray(spec.enum) ? spec.enum.join(", ") : "", "콤마 구분, 비우면 자유 입력") +
      '<div class="meta-ro">필드 = id(key)·label·type·description·description_detail·mapping_logic_ip_eval_esd·mapping_logic_chatbot' +
      ' (+ 선택 enum). 채울 수 없는 항목은 비워 두면 ""로 저장됩니다. 데이터 값은 모두 string이며 변경은 상단 "저장"으로 확정됩니다.</div>';
    const gsel = document.querySelector('#modal-form [data-mf="group"]');
    gsel.addEventListener("change", () => {
      document.getElementById("mf-newgroup-wrap").hidden = gsel.value !== "__new__";
    });
    $("#modal-overlay").hidden = false;
  }

  function saveFieldFromModal() {
    const get = (id) => document.querySelector('#modal-form [data-mf="' + id + '"]');
    const name = get("name").value.trim();
    if (!/^[A-Za-z0-9_]{1,60}$/.test(name)) { toast("필드명은 영문·숫자·_ 만 (1~60자)"); return; }
    const schema = state.masterSchema;
    if (!Array.isArray(schema.columns)) schema.columns = [];
    const oldName = modalCtx.name;
    if (name !== oldName && schemaFieldMap(schema)[name]) { toast("이미 존재하는 필드 id입니다"); return; }
    let group = get("group").value;
    if (group === "__new__") {
      group = (get("newgroup").value || "").trim();
      if (!group) { toast("새 group 이름을 입력하세요"); return; }
    }
    const codes = get("codes").value.split(",").map((s) => s.trim()).filter(Boolean);
    const spec = {
      id: name,
      label: get("label").value.trim(),
      type: get("type").value.trim() || "string",
      description: get("desc").value.trim(),
      description_detail: get("desc2").value.trim(),
      mapping_logic_ip_eval_esd: get("mlogic1").value.trim(),
      mapping_logic_chatbot: get("mlogic2").value.trim(),
    };
    if (codes.length) spec.enum = codes;
    // 기존 위치에서 제거 후 대상 group에 추가 (같은 group이면 자리 유지)
    let insertAt = -1;
    schema.columns.forEach((col) => {
      const idx = (col.fields || []).findIndex((f) => f.id === oldName);
      if (idx >= 0) {
        if ((col.group || "") === group) insertAt = idx;
        col.fields.splice(idx, 1);
      }
    });
    let target = schema.columns.find((c) => (c.group || "") === group);
    if (!target) { target = { group: group, fields: [] }; schema.columns.push(target); }
    if (insertAt >= 0) target.fields.splice(insertAt, 0, spec);
    else target.fields.push(spec);
    schema.columns = schema.columns.filter((c) => (c.fields || []).length); // 빈 group 정리
    renderMasterEditor(schema);
    closeModal();
    toast("필드 반영 — 상단 '저장'으로 확정하세요");
  }

  async function deleteFieldGuarded() {
    // 필드 삭제 보호: 데이터가 연결돼 있으면 행 id를 나열하며 차단.
    // 재확인 후에도 데이터가 존재하면 최종 삭제 불가.
    const name = modalCtx && modalCtx.name;
    if (!name) return;
    let ds = null;
    try { ds = await api("api/dataset"); } catch (e) { toast("데이터셋 확인 실패: " + e.message); return; }
    const usedIds = (ds.rows || []).filter((r) => r[name] !== null && r[name] !== undefined && r[name] !== "")
      .map((r) => String(r.id));
    if (usedIds.length) {
      const preview = usedIds.slice(0, 20).join(", ") + (usedIds.length > 20 ? " 외 " + (usedIds.length - 20) + "건" : "");
      window.alert("삭제 불가 — '" + ds.file + "' 데이터셋 " + usedIds.length + "개 행에 '" + name + "' 데이터가 있습니다.\n행 id: " + preview);
      if (!window.confirm("그래도 정말 삭제하시겠습니까?")) return;
      let ds2 = null;
      try { ds2 = await api("api/dataset"); } catch (e) { toast("재확인 실패: " + e.message); return; }
      const still = (ds2.rows || []).some((r) => r[name] !== null && r[name] !== undefined && r[name] !== "");
      if (still) {
        window.alert("데이터가 존재하므로 삭제할 수 없습니다.\n먼저 편집 탭에서 해당 열의 데이터를 비우거나, 이름 변경(이관)을 사용하세요.");
        return;
      }
      deleteFieldFromModal();
      return;
    }
    if (window.confirm("연결된 데이터가 없습니다. '" + name + "' 필드를 정말 삭제할까요? (상단 '저장'으로 확정)")) {
      deleteFieldFromModal();
    }
  }

  function deleteFieldFromModal() {
    const schema = state.masterSchema;
    const name = modalCtx.name;
    if (!name || !schemaFieldMap(schema)[name]) return;
    (schema.columns || []).forEach((col) => {
      col.fields = (col.fields || []).filter((f) => f.id !== name);
    });
    schema.columns = (schema.columns || []).filter((c) => (c.fields || []).length); // 빈 group 정리
    renderMasterEditor(schema);
    closeModal();
    toast("필드 삭제 반영 — 상단 '저장'으로 확정하세요");
  }

  $("#master-apply").addEventListener("click", async () => {
    const name = $("#master-select").value;
    if (!name) return;
    if (!window.confirm("저장된 마스터 '" + name + "' 스키마를 현재 데이터셋에 적용할까요?\n(저장하지 않은 마스터 변경은 반영되지 않습니다)")) return;
    let diff;
    try {
      diff = await apiPost("api/master/apply", { name: name, user: state.user, dry_run: true });
    } catch (e) { toast("적용 검토 실패: " + e.message); return; }
    const mapping = {};
    for (const b of (diff.removed_blocked || [])) {
      const ids = b.ids.slice(0, 20).join(", ") + (b.ids.length > 20 ? " 외 " + (b.ids.length - 20) + "건" : "");
      const addedList = (diff.added || []).filter((a) => !Object.values(mapping).includes(a));
      const target = window.prompt(
        "'" + b.field + "' 열에 데이터 " + b.count + "건이 있어 제거할 수 없습니다 (행 id: " + ids + ").\n" +
        (addedList.length ? "데이터를 이관(rename)할 새 필드명을 입력하세요. 추가된 필드: " + addedList.join(", ") + "\n" : "") +
        "비워두면 적용을 중단합니다.", "");
      if (!target) { window.alert("데이터가 있는 열이 남아 있어 적용할 수 없습니다.\n먼저 편집 탭에서 해당 열을 비우거나 이관 대상을 지정하세요."); return; }
      if (!addedList.includes(target)) { window.alert("'" + target + "'는 이번에 추가된 필드가 아닙니다. 적용을 중단합니다."); return; }
      mapping[b.field] = target;
    }
    try {
      const r = await apiPost("api/master/apply", { name: name, user: state.user, mapping: mapping });
      toast("적용 완료: 추가 " + r.added.length + " · 제거 " + r.removed.length + " · 이관 " +
        Object.keys(r.renamed).length + " (총 " + r.total + "행)");
      if (r.enum_mismatch && Object.keys(r.enum_mismatch).length) {
        window.alert("코드 테이블과 불일치하는 기존 값이 있습니다:\n" +
          Object.entries(r.enum_mismatch).map(([f, vs]) => f + ": " + vs.join(", ")).join("\n") +
          "\n편집 탭의 전체 편집 시트에서 일괄 수정하세요.");
      }
      refreshDataset();
    } catch (e) {
      toast("적용 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    }
  });
  $("#master-fields").addEventListener("click", (e) => {
    const gr = e.target.closest(".grename");
    if (gr) {
      const old = gr.getAttribute("data-group");
      const next = window.prompt("group 이름을 변경합니다 (표 헤더의 묶음 이름)", old);
      if (next == null || next.trim() === old) return;
      const col = (state.masterSchema.columns || []).find((c) => (c.group || "") === old);
      if (col) {
        col.group = next.trim();
        renderMasterEditor(state.masterSchema);
        toast("group 이름 변경 — 상단 '저장'으로 확정하세요");
      }
      return;
    }
    const tr = e.target.closest("tr[data-mfield]");
    if (tr) openFieldModal(tr.getAttribute("data-mfield"));
  });
  // schema_name·version·description 인라인 편집 → 메모리 스키마에 즉시 반영 (저장은 상단 버튼)
  $("#master-fields").addEventListener("input", (e) => {
    const t = e.target;
    if (!state.masterSchema || !t.id) return;
    if (t.id === "msch-name") state.masterSchema.schema_name = t.value;
    else if (t.id === "msch-ver") state.masterSchema.version = t.value;
    else if (t.id === "msch-desc") state.masterSchema.description = t.value;
    else return;
    $("#master-json").value = JSON.stringify(state.masterSchema, null, 2);
  });
  $("#master-field-add").addEventListener("click", () => openFieldModal(null));
  $("#master-select").addEventListener("change", () => loadMaster($("#master-select").value));
  $("#master-save-btn").addEventListener("click", () => {
    if (!state.masterSchema || !state.masterName) return;
    apiPost("api/master/save", { name: state.masterName, schema: state.masterSchema, user: state.user }).then(() => {
      toast("마스터 '" + state.masterName + "' 저장 완료");
      refreshMasters(state.masterName);
    }).catch((e) => toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  });
  $("#master-new").addEventListener("click", () => {
    const name = window.prompt("새 스키마 이름 (영문·숫자·-·_ 1~40자):", "");
    if (!name) return;
    apiPost("api/master/create", { name: name.trim(), user: state.user }).then((r) => {
      toast("마스터 '" + r.name + "' 생성");
      state.masterName = r.name;
      refreshMasters(r.name);
    }).catch((e) => toast("생성 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  });
  $("#master-delete").addEventListener("click", async () => {
    // 스키마(마스터) 삭제 보호: 연결된 데이터가 있으면 삭제 불가 (3단계 확인)
    const name = $("#master-select").value;
    if (!name) return;
    let ds = null, m = null;
    try {
      [ds, m] = await Promise.all([api("api/dataset"), api("api/master?name=" + encodeURIComponent(name))]);
    } catch (e) { toast("삭제 전 확인 실패: " + e.message); return; }
    const keyset = (s) => schemaFieldIds(s).slice().sort().join("|");
    const connected = (ds.rows || []).length > 0 &&
      (keyset(ds.schema) === keyset(m.schema) ||
       (!!schemaName(ds.schema) && schemaName(ds.schema) === schemaName(m.schema)));
    if (connected) {
      const ids = ds.rows.map((r) => String(r.id));
      const preview = ids.slice(0, 20).join(", ") + (ids.length > 20 ? " 외 " + (ids.length - 20) + "건" : "");
      window.alert("삭제 불가 — 마스터 '" + name + "'에 연결된 데이터가 있습니다.\n'" +
        ds.file + "' " + ids.length + "행 (id: " + preview + ")");
      if (!window.confirm("그래도 정말 삭제하시겠습니까?")) return;
      let ds2 = null;
      try { ds2 = await api("api/dataset"); } catch (e) { toast("재확인 실패: " + e.message); return; }
      if ((ds2.rows || []).length) {
        window.alert("데이터가 존재하므로 스키마를 삭제할 수 없습니다.\n데이터셋을 비우거나 다른 스키마로 전환한 뒤 삭제하세요.");
        return;
      }
    } else {
      if (!window.confirm("마스터 '" + name + "' 를 정말 삭제할까요? (연결된 데이터 없음)")) return;
    }
    apiPost("api/master/delete", { name: name, user: state.user }).then(() => {
      toast("마스터 '" + name + "' 삭제");
      state.masterName = null;
      refreshMasters();
    }).catch((e) => toast("삭제 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  });
  $("#schema-master-load").addEventListener("click", () => {
    const name = $("#schema-master-pick").value;
    if (!name) { toast("마스터가 없습니다"); return; }
    api("api/master?name=" + encodeURIComponent(name)).then((m) => {
      $("#schema").value = JSON.stringify(m.schema, null, 2);
      toast("마스터 '" + m.name + "' 스키마를 불러왔습니다");
    }).catch((e) => toast("불러오기 실패: " + e.message));
  });

  // ---- 대화 탭 (다중 턴, 이력 유지) ----
  const DEFAULT_CHAT_SYSTEM = "당신은 정확하고 간결하게 답하는 어시스턴트입니다.";

  // 모델 카드: 이 정보만으로 해당 LLM과 대화 가능한 수준의 상세(endpoint·timeout·상태)
  async function fetchLlmModels() {
    try {
      state.llmModels = await api("api/llm/models");
    } catch (e) {
      state.llmModels = { reachable: false, models: [] };
    }
    renderModelCards();
  }

  function renderModelCards() {
    const box = document.getElementById("chat-models");
    if (!box) return;
    const data = state.llmModels;
    if (!data) { box.innerHTML = ""; return; }
    if (!data.reachable) {
      box.innerHTML = '<div class="empty">LLM 연결 안 됨 — ' + esc(data.error || "") + "</div>";
      return;
    }
    const selected = $("#model").value;
    box.innerHTML = (data.models || []).map((m) => {
      const dotCls = m.health === "ok" ? "ok" : (m.health === "auth" || (m.err && !m.ok) ? "err" : "");
      return '<div class="mcard' + (m.id === selected ? " sel" : "") + '" data-mid="' + esc(m.id) +
        '" title="' + esc(m.note || "") + '">' +
        '<span class="mname"><span class="dot ' + dotCls + '"></span>' + esc(m.id) +
        ' <span class="mbadge">' + esc((m.backend || "") + (m.tier ? " · " + m.tier : "")) + "</span>" +
        '<button class="mdetail" type="button" title="JSON 원문 보기">상세</button></span>' +
        '<div class="mendp">' + esc(m.endpoint || "") + "</div>" +
        "<div>timeout " + (m.timeout || "-") + "s · 동시 ≤" + (m.max_inflight || "-") +
        (m.ewma_latency_ms ? " · 평균 " + (m.ewma_latency_ms / 1000).toFixed(1) + "s" : "") + "</div>" +
        "<div>호출 " + (m.ok || 0) + " ok / " + (m.err || 0) + " err" +
        (m.enabled === false ? " · <b>비활성</b>" : "") + "</div>" +
        (m.last_error ? '<div class="merr">' + esc(m.last_error) + "</div>" : "") +
        "</div>";
    }).join("");
  }

  function openHtmlModal(title, html) {
    modalCtx = { kind: "info" };
    $("#modal-save").hidden = true;
    $("#modal-delete").hidden = true;
    $("#modal-sheet-sec").hidden = true;
    $("#modal-title").textContent = title;
    $("#modal-cancel").textContent = "닫기";
    $("#modal-form").innerHTML = html;
    $("#modal-overlay").hidden = false;
  }

  function openInfoModal(title, obj) {
    openHtmlModal(title, '<pre class="raw">' + esc(JSON.stringify(obj, null, 2)) + "</pre>");
  }

  // 접목 가이드 (헤더 ℹ): 이 repo를 다른 LLM 게이트웨이에 연결하는 방법
  document.getElementById("info-btn").addEventListener("click", () => {
    const row = (k, v) => "<tr><td><code>" + k + "</code></td><td>" + v + "</td></tr>";
    openHtmlModal("접목 가이드 — 이 repo를 다른 LLM 백엔드에 연결하기",
      '<div class="hint">이 서비스의 LLM 접점은 <code>llm.py</code> 하나입니다. 기본값은 OpenAI 호환 ' +
      "endpoint(<code>base_url + /{model}/v1/chat/completions</code> 또는 <code>url</code> 직접 지정)이며, " +
      "설정은 0번 설정 탭 또는 <code>config/llm.json</code>(경로는 ⚙ 참고, PERSIST 영역)에서 관리합니다. " +
      '전체 내용은 repo의 <code>INTEGRATION.md</code>에도 있습니다.</div>' +
      '<div class="rsec"><h3>구동 방법</h3>' +
      '<div class="hint">의존성이 없습니다 (Python 표준 라이브러리만 사용). 프론트엔드도 빌드가 없어 ' +
      "<code>web/</code> 파일을 고치고 새로고침하면 반영됩니다.</div>" +
      '<pre class="raw">' + esc("python server.py --host 127.0.0.1 --port 8821\n" +
        "# 외부 접근:  --host 0.0.0.0        (프록시 뒤에 둘 때는 stripPrefix 방식)\n" +
        "# 컨테이너:   docker compose up -d --build   (PERSIST 볼륨 — DEPLOY.md)") + "</pre>" +
      '<div class="hint">기동 후 <b>0번 설정 탭</b>에서 <code>base_url</code>을 LLM 서버 위치로 맞추면 됩니다 — ' +
      "상단 상태 표시줄이 연결됨으로 바뀌는지로 확인합니다.</div></div>" +
      '<div class="rsec"><h3>스키마 형식 (데이터셋 정의)</h3>' +
      '<div class="hint">변환 목표·데이터셋·마스터가 모두 같은 형식을 씁니다. ' +
      "<code>columns</code>(표의 묶음) → <code>fields</code>(열) 2단 구조이며, " +
      "<b>field의 <code>id</code>가 JSON 연산의 key</b>이고 <code>group</code>은 표 헤더에서 열을 묶는 이름입니다. " +
      "출력 레코드는 group으로 중첩하지 않는 평면 객체입니다.</div>" +
      '<pre class="raw">' + esc(JSON.stringify({
        schema_name: "EsdEvalResult", description: "스키마 설명", version: "4",
        columns: [{
          group: "req info",
          fields: [{
            id: "sample_id", label: "시료 번호", type: "string",
            description: "필드의 의미", description_detail: "상세 규칙 (없으면 \"\")",
            mapping_logic_ip_eval_esd: "원본 열에서 가져오는 방법",
            mapping_logic_chatbot: "", enum: ["코드1", "코드2"],
          }],
        }],
      }, null, 2)) + "</pre>" +
      '<div class="tblwrap"><table><tbody>' +
      row("id", "<b>JSON 연산의 key</b> — 레코드·행의 필드명. 스키마 전체에서 유일해야 합니다") +
      row("group", "표 헤더에서 열을 묶는 이름 (병합 셀). 데이터 구조에는 영향 없음") +
      row("label", "표시명 (사람이 보는 이름). key로 쓰지 않습니다") +
      row("type", "값 타입 — 저장되는 모든 값은 string입니다") +
      row("description / description_detail", "필드의 의미와 상세 규칙. LLM 변환 판단의 근거") +
      row("mapping_logic_ip_eval_esd / _chatbot", "원본의 어느 열에서 어떻게 가져올지에 대한 지침") +
      row("enum", "선택 — 허용 코드 목록. 있으면 행 편집·시트 반영 시 코드 검증이 걸립니다") +
      '</tbody></table></div><div class="hint">채울 수 없는 항목은 <code>""</code>로 비워 둡니다. ' +
      "표 헤더는 group(병합) → description → id → type → label 순서로 그려집니다. " +
      "구형 <code>properties</code> 스키마는 읽을 때 자동으로 이 형식으로 변환됩니다.</div></div>" +
      '<div class="rsec"><h3>대표 파일</h3><div class="tblwrap"><table><tbody>' +
      row("server.py", "백엔드 — HTTP 서버·전체 API·잡 큐·저장. 저장 경로 상수가 상단에 있습니다") +
      row("llm.py", "<b>LLM 접점 전부</b> — endpoint 조립·헤더·요청/파싱·설정. 접목 시 여기만 고칩니다") +
      row("web/index.html", "프론트 — 탭·패널 구조와 요소 id") +
      row("web/app.js", "프론트 — 모든 화면 로직 (변환·데이터셋·마스터·대화·라우팅)") +
      row("web/styles.css", "프론트 — 테마 변수(light/dark)와 전체 스타일") +
      row("web/sheet.html", "프론트 — Luckysheet 격리 iframe (표 편집)") +
      row("config/llm.json.example", "설정 키 예시 — 복사해 llm.json으로 사용 (실제 파일은 커밋 금지)") +
      row("prompts/table_to_schema.md", "변환 시스템 프롬프트 — <code>{{TARGET_SCHEMA}}</code> 치환") +
      "</tbody></table></div></div>" +
      '<div class="rsec"><h3>경로 설정 — ① LLM endpoint (0번 설정 탭)</h3>' +
      '<div class="hint">설정 JSON을 고치고 저장하면 다음 요청부터 적용됩니다 (재기동 불필요). ' +
      "모델별 경로 규칙을 쓰는 서버는 <code>base_url</code>만, 규칙이 다른 게이트웨이는 " +
      "<code>url</code>에 <b>전체 endpoint</b>를 넣습니다 (이 값이 있으면 base_url 조립은 무시). " +
      "실제로 나가는 URL은 대화·변환 이력의 <b>요청 전문</b>에서 확인합니다.</div></div>" +
      '<div class="rsec"><h3>경로 설정 — ② 저장 경로 (환경변수)</h3><div class="tblwrap"><table><tbody>' +
      row("LLM_DATA_PERSIST", "데이터셋·대화·마스터·프로젝트·로그·사용자 설정/프롬프트 (<b>유지 필요</b>)") +
      row("LLM_DATA_RUNTIME", "변환 작업 이력 (<b>유실 허용</b>)") +
      row("LLM_DATA_CONFIG", "설정 파일 경로 개별 지정 (PERSIST보다 우선)") +
      '</tbody></table></div><pre class="raw">' +
      esc("LLM_DATA_PERSIST=/data LLM_DATA_RUNTIME=/runtime python server.py --host 0.0.0.0 --port 8821") +
      '</pre><div class="hint">미설정 시 모두 <code>&lt;repo&gt;/data</code>를 씁니다. ' +
      "현재 적용된 실제 경로는 헤더 ⚙(저장 영역)에서 확인하세요.</div></div>" +
      '<div class="rsec"><h3>동작 키 — 기본 구현이 직접 사용</h3><div class="tblwrap"><table><tbody>' +
      row("base_url", "OpenAI 호환 서버 루트. 모델별 경로가 자동으로 붙습니다") +
      row("url", "전체 endpoint를 직접 지정할 때 (base_url 무시)") +
      row("model", "요청 payload의 model 값") +
      row("headers", "요청에 그대로 합쳐지는 헤더 — token은 여기 Authorization에") +
      row("api_key_env", "환경변수 이름으로 token을 줄 때") +
      row("response_schema", "구조화 출력 강제 여부 — <b>미지원 모델이면 false 유지</b>") +
      row("timeout / extra_payload", "요청 타임아웃 · payload 추가 필드") +
      "</tbody></table></div></div>" +
      '<div class="rsec"><h3>전달(passthrough) 키 — 게이트웨이 접목 지점</h3>' +
      '<div class="hint">아래 키는 설정에 저장·표시만 되고 기본 구현은 <code>OPENAI_API_KEY</code>만 ' +
      "Authorization Bearer로 씁니다. 게이트웨이형 시스템에 접목할 때 <code>llm.py</code>의 " +
      "<code>chat_url()</code>·<code>_headers()</code>에서 아래처럼 매핑하세요.</div>" +
      '<div class="tblwrap"><table><tbody>' +
      row("api_base_url", "게이트웨이 루트 → <code>chat_url()</code>이 이 값을 쓰도록 하거나, <code>url</code>에 전체 endpoint를 기입") +
      row("env_model", "게이트웨이가 요구하는 모델 이름 → payload의 <code>model</code>로 매핑") +
      row("credential_key", "자격 티켓 (예: credential:TICKET-…) → 게이트웨이가 요구하는 헤더로 전달") +
      row("send_system_name", "호출 시스템 식별자 → 게이트웨이가 요구하는 헤더/필드로 전달") +
      row("user_id / user_pw", "토큰 발급형 게이트웨이용 → 발급 API 호출 후 <code>Authorization</code>에 설정") +
      row("OPENAI_API_KEY", "표준 Bearer token — 기본 구현이 그대로 사용") +
      "</tbody></table></div></div>" +
      '<div class="rsec"><h3>_headers() 확장 예시</h3><pre class="raw">' +
      esc('def _headers(cfg):\n    headers = {"Content-Type": "application/json"}\n' +
        '    if cfg.get("credential_key"):\n        headers["X-Credential"] = cfg["credential_key"]\n' +
        '    if cfg.get("send_system_name"):\n        headers["X-System-Name"] = cfg["send_system_name"]\n' +
        '    if cfg.get("user_id") and cfg.get("user_pw"):\n' +
        '        headers["Authorization"] = "Bearer " + issue_token(\n' +
        '            cfg["api_base_url"], cfg["user_id"], cfg["user_pw"])\n' +
        "    return headers") + "</pre>" +
      '<div class="hint">요청·응답 전문(마스킹된 headers 포함)은 변환 작업 이력과 대화 탭에서 항상 확인할 수 있어 ' +
      "접목 디버깅에 그대로 활용됩니다.</div></div>");
  });

  // 저장 영역 안내 (헤더 ⚙): LOGIC / PERSIST / RUNTIME 구분과 설정 파일 경로
  document.getElementById("storage-btn").addEventListener("click", async () => {
    try {
      const s = await api("api/storage");
      const html = '<div class="hint">PERSIST 영역은 배포 환경의 영구 저장소(volume·마운트)에 두어야 하며, ' +
        "RUNTIME 영역은 재기동 시 유실되어도 무방합니다. 자세한 절차는 DEPLOY.md 참고.</div>" +
        (s.warning ? '<div class="rsec"><div class="warnbox">⚠ ' + esc(s.warning) + "</div></div>" : "") +
        s.areas.map((a) =>
          '<div class="rsec"><h3>' + esc(a.label) + "</h3>" +
          '<div class="reqline"><code>' + esc(a.root) + "</code>" +
          (a.env ? " · env <b>" + esc(a.env) + "</b> " +
            (a.env_active ? '<span class="chip ok">적용됨</span>' : '<span class="chip err">미설정 — 코드 디렉터리 아래 기본 경로</span>') : "") +
          "</div><div class=\"tblwrap\"><table><tbody>" +
          a.entries.map((en) => "<tr><td>" + esc(en.name) +
            '</td><td class="logdetail"><code>' + esc(en.path) + "</code>" +
            (en.note ? ' <span class="cmeta">— ' + esc(en.note) + "</span>" : "") + "</td></tr>").join("") +
          "</tbody></table></div></div>").join("");
      openHtmlModal("저장 영역 · 설정 파일", html);
    } catch (e) { toast("저장 영역 정보 로드 실패: " + e.message); }
  });

  document.getElementById("chat-models").addEventListener("click", (e) => {
    const card = e.target.closest("[data-mid]");
    if (!card) return;
    const mid = card.getAttribute("data-mid");
    if (e.target.closest(".mdetail")) {
      const m = ((state.llmModels || {}).models || []).find((x) => x.id === mid);
      if (m) openInfoModal("모델 상세 — " + mid, m);
      return;
    }
    $("#model").value = mid;
    renderModelCards();
    toast("모델 선택: " + mid);
  });
  $("#model").addEventListener("change", renderModelCards);

  async function refreshChats(selectId) {
    let chats = [];
    try {
      const resp = await api("api/chats");
      chats = resp.chats || [];
      state.projects = resp.projects || {};
    } catch (e) { /* 빈 목록 처리 */ }
    state.chats = chats;
    const cur = selectId || state.chatId;
    if (cur && chats.some((c) => c.id === cur)) {
      if (state.chatId !== cur || !state.chatDoc) await loadChatDoc(cur);
      else renderChatList();
    } else if (chats.length) {
      await loadChatDoc(chats[0].id);
    } else {
      state.chatId = null;
      state.chatDoc = null;
      $("#chat-system").value = DEFAULT_CHAT_SYSTEM;
      renderChatList();
      renderChatMessages();
    }
  }

  const ICON_PIN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>';
  const ICON_FOLDER = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>';

  function renderChatList() {
    const box = $("#chat-list");
    const chats = state.chats || [];
    if (!chats.length) {
      box.innerHTML = '<div class="empty">대화가 없습니다.</div>';
      return;
    }
    const limit = state.contextLimit || 200000;
    const projects = state.projects || {};
    const itemHtml = (c) => {
      const tok = c.cum_tokens
        ? '<span class="cmeta">누적 ' + c.cum_tokens.toLocaleString() + " · " +
          c.ctx_tokens.toLocaleString() + "/" + Math.round(limit / 1000) + "k (" +
          (c.ctx_tokens * 100 / limit).toFixed(1) + "%)</span>"
        : "";
      const btns = '<span class="citembtns">' +
        '<button class="iconbtn crename" data-cid="' + esc(c.id) + '" type="button" title="대화 이름 변경">' + ICON_EDIT + "</button>" +
        '<button class="iconbtn cpin' + (c.pinned ? " on" : "") + '" data-cid="' + esc(c.id) +
        '" type="button" title="' + (c.pinned ? "고정 해제" : "상위 고정") + '">' + ICON_PIN + "</button>" +
        '<button class="iconbtn cmove" data-cid="' + esc(c.id) + '" type="button" title="프로젝트로 이동">' + ICON_FOLDER + "</button></span>";
      // 고정된 대화는 원래 그룹(프로젝트)에서 분리돼 상단에 뜨므로 소속을 작게 병기한다
      const projTag = c.pinned && c.project && projects[c.project]
        ? '<span class="cproj" title="소속 프로젝트">' + ICON_FOLDER + " " + esc(projects[c.project].name) + "</span>"
        : "";
      return '<div class="chatitem' + (c.id === state.chatId ? " sel" : "") + '" data-chat="' + esc(c.id) + '">' +
        '<span class="ctitle">' + (c.pinned ? '<span class="pinmark">' + ICON_PIN + "</span>" : "") +
        (c.model ? '<span class="mbadge">' + esc(c.model) + "</span> " : "") +
        (c.pending ? '<span class="spin"></span> ' : "") + esc(c.title) + "</span>" + btns + projTag +
        '<span class="cmeta">' + Math.floor(c.count / 2) + "턴 · " +
        esc((c.updated_at || "").slice(0, 16).replace("T", " ")) + "</span>" + tok + "</div>";
    };
    // 그룹: 고정됨 → 프로젝트(최신 대화 활동순 실시간 정렬) → 일반 대화
    const pinned = chats.filter((c) => c.pinned);
    // 소속(count·정렬)은 고정 대화도 포함해 계산하고, 항목 렌더링만 고정 섹션으로 뺀다
    const allByProject = {}, byProject = {};
    Object.keys(projects).forEach((pid) => { allByProject[pid] = []; byProject[pid] = []; }); // 빈 프로젝트도 표시
    chats.filter((c) => c.project && projects[c.project]).forEach((c) => {
      allByProject[c.project].push(c);
      if (!c.pinned) byProject[c.project].push(c);
    });
    const rest = chats.filter((c) => !c.pinned && !(c.project && projects[c.project]));
    // 프로젝트 정렬: 소속 대화 중 가장 최근 활동 시각 내림차순 (빈 프로젝트는 생성 시각)
    const projTs = (pid) => (allByProject[pid].length
      ? allByProject[pid].reduce((mx, c) => (String(c.updated_at || "") > mx ? String(c.updated_at || "") : mx), "")
      : String(projects[pid].created_at || ""));
    const projOrder = Object.keys(projects).sort((a, b) => projTs(b).localeCompare(projTs(a)));
    let html = "";
    if (pinned.length) html += '<div class="lsec">' + ICON_PIN + " 고정됨</div>" + pinned.map(itemHtml).join("");
    projOrder.forEach((pid) => {
      const upCount = allByProject[pid].length - byProject[pid].length; // 고정 섹션으로 올라간 수
      html += '<div class="lsec proj"><span class="pname">' + ICON_FOLDER + " " + esc(projects[pid].name) +
        ' <span class="pcount">' + allByProject[pid].length +
        (upCount ? " <span class=\"pup\" title=\"고정되어 위에 표시 중\">↑" + upCount + "</span>" : "") + "</span></span>" +
        '<button class="iconbtn prename" data-pid="' + esc(pid) + '" type="button" title="프로젝트 이름 변경">' + ICON_EDIT + "</button>" +
        '<button class="iconbtn pdel" data-pid="' + esc(pid) + '" type="button" title="프로젝트 삭제 (대화는 최상위로 이동)">✕</button>' +
        '<span class="cmeta">' + esc(projTs(pid).slice(5, 16).replace("T", " ")) + "</span></div>" +
        (byProject[pid].length
          ? byProject[pid].map(itemHtml).join("")
          : '<div class="empty pempty">' +
            (upCount ? "소속 대화가 모두 상단에 고정되어 있습니다"
              : "대화를 이 프로젝트로 이동하세요 (대화 항목의 폴더 아이콘)") + "</div>");
    });
    if (rest.length) {
      if (pinned.length || projOrder.length) html += '<div class="lsec">대화</div>';
      html += rest.map(itemHtml).join("");
    }
    box.innerHTML = html;
  }

  async function loadChatDoc(id) {
    try {
      state.chatDoc = await api("api/chat?id=" + encodeURIComponent(id));
      if (state.chatId !== id) { state.editingIdx = null; state.ctxEditIdx = null; }
      state.chatId = id;
      $("#chat-system").value = state.chatDoc.system != null && state.chatDoc.system !== ""
        ? state.chatDoc.system : DEFAULT_CHAT_SYSTEM;
      renderChatList();
      renderChatMessages();
      restorePending(state.chatDoc); // 서버에 진행 중인 전송이 있으면 질문·타이머 복원 + 폴링
      pushRoute(); // 같은 대화 재로드면 hash 불변(no-op), 대화 이동이면 history entry 추가
    } catch (e) { toast("대화 로드 실패: " + e.message); }
  }

  // 새로고침·재접속해도 진행 중 전송을 복원: 서버 _CHAT_PENDING 기반 렌더링 + 완료 폴링
  function restorePending(doc) {
    clearTimeout(state.pendingPollTimer);
    if (!doc || !doc.pending || !state.chatId) return;
    const p = doc.pending;
    const box = $("#chat-messages");
    if (!document.getElementById("chat-pending")) {
      if (box.querySelector(".empty")) box.innerHTML = "";
      if (p.edit_index == null) {
        box.insertAdjacentHTML("beforeend",
          '<div class="msgwrap user" id="chat-just-sent"><div class="msg user">' + esc(p.message) + "</div></div>");
      }
      box.insertAdjacentHTML("beforeend",
        '<div class="msg pending" id="chat-pending"><span class="spin"></span> ' +
        (p.edit_index != null ? "#" + p.edit_index + " 수정 재전송 — " : "") + "응답 대기 중 " +
        timerHtml(Date.parse(p.ts) || Date.now()) + "</div>");
      scrollMsgIntoTop(document.getElementById("chat-just-sent") || document.getElementById("chat-pending"));
    }
    const cid = state.chatId;
    state.pendingPollTimer = setTimeout(() => {
      if (state.chatId === cid) loadChatDoc(cid); // pending 유지 시 재귀 폴링, 완료 시 응답 렌더
    }, 2500);
  }

  // ---- assistant 메시지 markdown 렌더링 (모든 조각을 esc() 후 변환 — XSS 안전) ----
  function mdInline(s) {
    // s는 이미 esc()된 문자열. 수식 구간은 마스킹해 *·_ 등이 markdown으로 오변환되지 않게 보호
    const masks = [];
    s = s.replace(/\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([^()]*?\\\)|\\\[[^\]]*?\\\]/g, (m) => {
      masks.push(m);
      return "" + (masks.length - 1) + "";
    });
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(\d+)/g, (_, n) => masks[Number(n)]);
    return s;
  }

  function buildNestedList(items) {
    // items: [{indent, type('ul'|'ol'), content}] — 들여쓰기 기반 중첩 목록 구성
    let i = 0;
    function build(startIndent, type) {
      let out = "<" + type + ">";
      while (i < items.length) {
        const it = items[i];
        if (it.indent < startIndent) break;
        if (it.indent === startIndent && it.type !== type) break;
        if (it.indent > startIndent) {
          const nested = build(it.indent, it.type);
          if (out.endsWith("</li>")) out = out.slice(0, -5) + nested + "</li>";
          else out += "<li>" + nested + "</li>";
          continue;
        }
        out += "<li>" + mdInline(esc(it.content)) + "</li>";
        i += 1;
      }
      return out + "</" + type + ">";
    }
    let res = "";
    while (i < items.length) res += build(items[i].indent, items[i].type);
    return res;
  }

  function mdBlocks(text) {
    const lines = String(text).split("\n");
    let html = "";
    let para = [], listItems = null, tableBuf = null, bqBuf = null;
    const flushPara = () => {
      if (para.length) { html += "<p>" + para.map((l) => mdInline(esc(l))).join("<br>") + "</p>"; para = []; }
    };
    const flushList = () => {
      if (listItems) {
        html += buildNestedList(listItems);
        listItems = null;
      }
    };
    const flushTable = () => {
      if (!tableBuf) return;
      const rows = tableBuf.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
      html += '<div class="tblwrap"><table>' + rows.map((r, i) => {
        const cells = r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")
          .map((c) => mdInline(esc(c.trim())));
        const tag = i === 0 ? "th" : "td";
        return "<tr>" + cells.map((c) => "<" + tag + ">" + c + "</" + tag + ">").join("") + "</tr>";
      }).join("") + "</table></div>";
      tableBuf = null;
    };
    const flushBq = () => {
      if (bqBuf) {
        html += "<blockquote>" + bqBuf.map((l) => mdInline(esc(l))).join("<br>") + "</blockquote>";
        bqBuf = null;
      }
    };
    const flushAll = () => { flushPara(); flushList(); flushTable(); flushBq(); };
    lines.forEach((line) => {
      const t = line.trim();
      if (!t) { flushAll(); return; }
      if (/^\|.*\|/.test(t)) { flushPara(); flushList(); flushBq(); (tableBuf = tableBuf || []).push(t); return; }
      flushTable();
      const bq = t.match(/^&gt;\s?(.*)/) || t.match(/^>\s?(.*)/);
      if (bq) { flushPara(); flushList(); (bqBuf = bqBuf || []).push(bq[1]); return; }
      flushBq();
      const h = t.match(/^(#{1,4})\s+(.*)/);
      if (h) { flushAll(); html += "<h" + Math.min(h[1].length + 3, 6) + ">" + mdInline(esc(h[2])) + "</h" + Math.min(h[1].length + 3, 6) + ">"; return; }
      if (/^-{3,}$/.test(t)) { flushAll(); html += "<hr>"; return; }
      // 목록: 원본 들여쓰기 기준으로 중첩 구성 (ul/ol 혼합·다단 지원)
      const lm = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
      if (lm && lm[3] !== "") {
        flushPara();
        (listItems = listItems || []).push({
          indent: lm[1].replace(/\t/g, "  ").length,
          type: /^[-*]$/.test(lm[2]) ? "ul" : "ol",
          content: lm[3],
        });
        return;
      }
      flushList();
      para.push(t);
    });
    flushAll();
    return html;
  }

  window.__md = (t) => renderMarkdown(t); // 렌더링 점검용 디버그 훅

  function renderMarkdown(text) {
    // ```lang ... ``` 코드 블록을 먼저 분리하고 나머지에 블록 markdown 적용
    const parts = String(text).split(/```(\w*)[ \t]*\n?([\s\S]*?)```/);
    let html = "";
    for (let i = 0; i < parts.length; i += 3) {
      html += mdBlocks(parts[i] || "");
      if (i + 2 < parts.length) {
        const lang = parts[i + 1] || "";
        const code = (parts[i + 2] || "").replace(/\n$/, "");
        html += '<div class="codewrap"><div class="codehead"><span>' + esc(lang || "code") +
          '</span><button class="copycode iconbtn" type="button" title="코드 복사">' + ICON_COPY + "</button></div>" +
          '<pre><code class="' + (lang ? "language-" + esc(lang) : "") + '">' + esc(code) + "</code></pre></div>";
      }
    }
    return html;
  }

  function msgTs(ts) {
    return ts ? String(ts).slice(0, 16).replace("T", " ") : ""; // "YYYY-MM-DD HH:MM"
  }

  function scrollMsgIntoTop(el) {
    const box = $("#chat-messages");
    if (!el) { box.scrollTop = box.scrollHeight; return; }
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 4;
  }

  // ChatGPT 차용 아이콘 (복사·수정)
  const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>';

  function msgHtml(m, i) {
    const role = m.role === "user" ? "user" : "assistant";
    const ts = msgTs(m.ts);
    const editedMark = m.edited_at
      ? ' <span class="edited" title="수정: ' + esc(msgTs(m.edited_at)) + '">수정됨</span>' : "";
    // context 편집 모드: LLM 재전송 없이 내용만 제자리 수정 (user·assistant 모두 가능)
    if (state.ctxEditIdx === i) {
      return '<div class="msgwrap ' + role + '"><div class="msgedit">' +
        '<textarea id="ctx-edit-ta" spellcheck="false">' + esc(m.content) + "</textarea>" +
        '<div class="editbtns"><span class="hint" style="margin-right:auto">LLM 재전송 없음 — 다음 질문부터 수정된 context가 반영됩니다</span>' +
        '<button id="ctx-edit-cancel" class="small" type="button">취소</button>' +
        '<button id="ctx-edit-save" class="insertbtn" type="button">수정 저장</button></div></div></div>';
    }
    // 수정 모드: 그 질문 box 안에서 편집 + 취소/전송 버튼
    if (role === "user" && state.editingIdx === i) {
      return '<div class="msgwrap user"><div class="msgedit">' +
        '<textarea id="edit-msg-ta" spellcheck="false">' + esc(m.content) + "</textarea>" +
        '<div class="editbtns"><button id="edit-msg-cancel" class="small" type="button">취소</button>' +
        '<button id="edit-msg-send" class="insertbtn" type="button">전송</button></div></div></div>';
    }
    let cap = "";
    if (role === "user") {
      const entry = ((state.chatDoc || {}).alts || {})[String(i)];
      if (entry && entry.variants && entry.variants.length > 1) {
        cap += '<span class="bnav"><button class="bstep" data-bi="' + i + '" data-dir="-1" type="button">&#9664;</button>' +
          (entry.active + 1) + "/" + entry.variants.length +
          '<button class="bstep" data-bi="' + i + '" data-dir="1" type="button">&#9654;</button></span>';
      }
      cap += (cap ? " " : "") + esc(ts) + editedMark +
        ' <button class="iconbtn copymsg" data-mi="' + i + '" type="button" title="메시지 복사">' + ICON_COPY + "</button>" +
        '<button class="iconbtn editmsg" data-mi="' + i + '" type="button" title="수정 후 재전송 (분기 생성)">' + ICON_EDIT + "</button>";
    } else {
      cap = esc(ts) + editedMark;
      const u = m.usage || {};
      if (m.model) cap += (cap ? " · " : "") + esc(m.model);
      if (m.latency_ms) cap += " · " + (m.latency_ms / 1000).toFixed(1) + "초";
      if (u.prompt_tokens || u.completion_tokens) {
        cap += " · in " + (u.prompt_tokens || 0).toLocaleString() +
          " / out " + (u.completion_tokens || 0).toLocaleString() + " tok";
      }
      cap += ' <button class="iconbtn copymsg" data-mi="' + i + '" type="button" title="답변 전체 복사">' + ICON_COPY + "</button>";
    }
    // metadata(시각·모델·토큰)는 말풍선 밖 캡션으로. assistant는 markdown 렌더링
    const body = role === "assistant" ? renderMarkdown(m.content) : esc(m.content);
    return '<div class="msgwrap ' + role + '"><div class="msg ' + role + '">' + body + "</div>" +
      (cap ? '<div class="mcap">' + cap + "</div>" : "") + "</div>";
  }

  function renderChatMessages() {
    const box = $("#chat-messages");
    const msgs = (state.chatDoc && state.chatDoc.messages) || [];
    box.innerHTML = msgs.length
      ? msgs.map((m, i) => msgHtml(m, i)).join("")
      : '<div class="empty">메시지를 보내면 ' + (state.chatId ? "대화가 이어집니다." : "새 대화가 시작됩니다.") + "</div>";
    // syntax highlight (highlight.js — language-* class 사용, 없으면 자동 인식)
    if (window.hljs) {
      box.querySelectorAll(".codewrap pre code").forEach((el) => {
        try { window.hljs.highlightElement(el); } catch (e) { /* 하이라이트 실패는 무시 */ }
      });
    }
    // 수식 렌더링 (KaTeX auto-render — 코드 영역은 제외)
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(box, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "\\(", right: "\\)", display: false },
            { left: "$", right: "$", display: false },
          ],
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
          throwOnError: false,
        });
      } catch (e) { /* 수식 렌더 실패는 무시 */ }
    }
    // 스크롤: 방금 보낸 질문이 있으면 그 질문을 상단에 앵커 (답변을 처음부터 읽도록),
    // 아니면 맨 아래로
    if (state.scrollAnchor != null) {
      let target = null;
      if (state.scrollAnchor === "last-user") {
        const users = box.querySelectorAll(".msgwrap.user");
        target = users[users.length - 1];
      } else {
        target = box.children[state.scrollAnchor];
      }
      state.scrollAnchor = null;
      scrollMsgIntoTop(target);
    } else {
      box.scrollTop = box.scrollHeight;
    }
    // 누적 토큰 · 컨텍스트(마지막 요청 규모) / 한계 · 사용률
    let cum = 0, ctx = 0;
    msgs.forEach((m) => {
      const u = m.usage || {};
      if (u.total_tokens) {
        cum += u.total_tokens;
        ctx = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
      }
    });
    const limit = state.contextLimit || 200000;
    $("#chat-stats").textContent = msgs.length && cum
      ? "누적 " + cum.toLocaleString() + " tok · 컨텍스트 " + ctx.toLocaleString() + " / " +
        limit.toLocaleString() + " (" + (ctx * 100 / limit).toFixed(1) + "%)"
      : "";
    renderChatRequest();
    renderChatTree();
  }

  function buildRequestPreview(msg) {
    // 전송 버튼 클릭 직후 즉시 렌더링할 요청 재구성 — 서버 저장본(last_request)과 동일 구조
    const cfg = state.llmConfig || {};
    const model = $("#model").value || cfg.model || "sonnet";
    const url = cfg.url && String(cfg.url).trim()
      ? String(cfg.url).trim()
      : String(cfg.base_url || "http://127.0.0.1:8820").replace(/\/+$/, "") + "/" + model + "/v1/chat/completions";
    const msgs = [];
    const sys = $("#chat-system").value.trim();
    if (sys) msgs.push({ role: "system", content: sys });
    (((state.chatDoc || {}).messages) || []).forEach((m) => msgs.push({ role: m.role, content: m.content }));
    msgs.push({ role: "user", content: msg });
    const payload = { model: model, messages: msgs };
    if (cfg.extra_payload && typeof cfg.extra_payload === "object") Object.assign(payload, cfg.extra_payload);
    return {
      method: "POST", url: url, model: model, payload: payload,
      payload_bytes: new TextEncoder().encode(JSON.stringify(payload)).length,
      headers: (state.llmStatus && state.llmStatus.headers) || { "Content-Type": "application/json" },
      timeout_s: parseInt(cfg.timeout, 10) || 300,
      ts: (function () {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
          p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      })(),
      pending: true,
    };
  }

  // ---- 대화 분기 그래프 (git graph 스타일: SVG 레일·노드·대각 분기 직선) ----
  // 레인 색: Google 계열 고시인성 팔레트, 레인 순서대로 배정.
  // 레인 수가 팔레트보다 많아지면 % 로 loop — 모든 색 참조는 lane % length 사용.
  const LANE_COLORS = ["#4285f4", "#ea4335", "#f9ab00", "#34a853",
    "#9334e6", "#12b5cb", "#fa7b17", "#f538a0"];

  function renderChatTree() {
    const box = document.getElementById("chat-tree");
    const doc = state.chatDoc;
    if (!doc || !(doc.messages || []).length) {
      box.innerHTML = '<div class="empty">대화가 없습니다.</div>';
      return;
    }
    // 1) 트리 워크 → 행 목록. git처럼 graph 구조는 활성 분기와 무관하게 고정:
    //    변형은 항상 생성 순서(j)로 배치되고, 가지 0이 부모 레인을 이어받는다.
    //    활성 경로는 색(accent)으로만 표시 — 분기 전환 시 모양은 그대로, 강조만 이동.
    const rows = [];
    let laneMax = 0;
    function walk(messages, alts, base, lane, onActive, parentPos, branchTag, forkPath) {
      const keys = Object.keys(alts || {}).map(Number).filter((k) => k >= base).sort((a, b) => a - b);
      const first = keys.length ? keys[0] : null;
      const linEnd = first === null ? messages.length : Math.min(first - base, messages.length);
      let prev = parentPos;
      let tag = branchTag || null;
      for (let i = 0; i < linEnd; i++) {
        rows.push({ msg: messages[i], absIdx: base + i, lane: lane, active: onActive, connect: prev, branch: tag, forks: forkPath });
        prev = { lane: lane, row: rows.length - 1 };
        tag = null;
      }
      if (first !== null) {
        const entry = alts[String(first)];
        const subAlts = {};
        keys.slice(1).forEach((k) => { subAlts[String(k)] = alts[String(k)]; });
        let rootAnchor = null; // #0 fork(트렁크 행 없음)의 형제 연결용 가상 접점 — 가지 0의 head
        entry.variants.forEach((v, j) => {
          const isAct = j === entry.active;
          const msgs = isAct ? messages.slice(first - base) : (v.messages || []);
          const as = isAct ? subAlts : (v.alts || {});
          const childLane = j === 0 ? lane : ++laneMax;
          const headRow = rows.length;
          walk(msgs, as, first, childLane, onActive && isAct, prev || rootAnchor,
            { bi: first, j: j, total: entry.variants.length, isActive: isAct },
            forkPath.concat([{ bi: first, j: j, isActive: isAct }]));
          if (!prev && !rootAnchor && rows.length > headRow) rootAnchor = { lane: childLane, row: headRow };
        });
      }
    }
    walk(doc.messages, doc.alts || {}, 0, 0, true, null, null, []);
    state.treeRows = rows;

    // 2) SVG 레일·곡선·노드
    const rowH = 24, laneW = 16, pad = 12;
    const gutter = pad + (laneMax + 1) * laneW + 4;
    const H = rows.length * rowH;
    const X = (lane) => pad + lane * laneW;
    const Y = (row) => row * rowH + rowH / 2;
    const laneColor = (r) => LANE_COLORS[r.lane % LANE_COLORS.length];
    let svg = "";
    // 레인당 연속 레일 (진입 45° 대각 직선 + 수직선). 한 레인에서 활성 구간은 앞쪽 연속
    // 접두뿐이므로 [활성 run]+[비활성 run] 최대 2개의 이어진 경로로 그린다 — 끊김 없음.
    const lanes = {};
    rows.forEach((r, ri) => { (lanes[r.lane] = lanes[r.lane] || []).push({ r: r, ri: ri }); });
    Object.keys(lanes).map(Number).sort((a, b) => a - b).forEach((ln) => {
      const list = lanes[ln];
      const xTop = X(ln);
      const laneStroke = LANE_COLORS[ln % LANE_COLORS.length];
      const emit = (d, act) => {
        // 활성 경로도 색은 그대로 — 같은 레인 색에 굵기·불투명도만 강조 (색 변경은 오해 유발)
        svg += '<path d="' + d + '" stroke="' + laneStroke +
          '" stroke-width="' + (act ? 3.2 : 1.8) + '" fill="none" opacity="' + (act ? 1 : 0.5) +
          '" stroke-linecap="round" stroke-linejoin="miter"/>';
      };
      const head = list[0];
      const conn = head.r.connect;
      let startD;
      if (conn && conn.lane !== ln) {
        // 분기 직후 45° 대각 직선으로 새 레인 진입
        const x1 = X(conn.lane), y1 = Y(conn.row), y2 = Y(head.ri);
        const bendY = Math.min(y1 + Math.abs(xTop - x1), y2);
        startD = "M" + x1 + " " + y1 + " L" + xTop + " " + bendY;
      } else {
        startD = "M" + xTop + " " + Y(conn ? conn.row : head.ri);
      }
      let split = list.findIndex((e) => !e.r.active);
      if (split === -1) split = list.length;
      if (split > 0) {
        emit(startD + " L" + xTop + " " + Y(list[split - 1].ri), true);
        if (split < list.length) {
          emit("M" + xTop + " " + Y(list[split - 1].ri) + " L" + xTop + " " + Y(list[list.length - 1].ri), false);
        }
      } else {
        emit(startD + " L" + xTop + " " + Y(list[list.length - 1].ri), false);
      }
    });
    rows.forEach((r, ri) => {
      const c = laneColor(r);
      const cx = X(r.lane), cy = Y(ri);
      const op = r.active ? 1 : 0.5;
      if (r.msg.role === "user") {
        svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r.active ? 5 : 4) +
          '" fill="' + c + '" opacity="' + op + '"/>';
      } else {
        svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r.active ? 4.5 : 3.8) +
          '" fill="var(--card)" stroke="' + c + '" stroke-width="' + (r.active ? 2.6 : 1.8) +
          '" opacity="' + op + '"/>';
      }
    });

    // 3) 행 라벨 — 분기점 pill은 상태 표지(버튼 아님). 전환은 행 자체를 클릭(= checkout).
    const tipIdx = (doc.messages || []).length - 1;
    const rowsHtml = rows.map((r, ri) => {
      const m = r.msg;
      const preview = String(m.content || "").replace(/\s+/g, " ").slice(0, 64);
      let meta = "";
      if (m.role === "assistant") {
        const u = m.usage || {};
        if (m.model) meta += m.model;
        if (u.total_tokens) meta += (meta ? " · " : "") + u.total_tokens.toLocaleString() + "tok";
      }
      // 칩 색 = 그 가지의 레인 색 (테두리·글자·레일·노드 통일, 레인 수 초과 시 색 loop)
      const laneStroke = LANE_COLORS[r.lane % LANE_COLORS.length];
      const onPath = !!(r.branch && r.branch.isActive && r.active); // 현재 대화 경로 위의 선택 가지
      const pill = r.branch
        ? '<span class="tpill' + (onPath ? " on" : "") + '" style="color:' + laneStroke +
          ";border-color:" + laneStroke + (onPath ? ";background:" + laneStroke + "1f" : "") +
          '" title="#' + r.branch.bi + ' 지점의 가지 ' + (r.branch.j + 1) + "/" + r.branch.total +
          (onPath ? " — 현재 대화"
            : r.branch.isActive ? " — 이 지점의 선택된 가지 (상위 가지가 비활성) · 행 클릭으로 전환"
              : " — 행을 클릭하면 이 가지로 전환") + '">' +
          (r.branch.j + 1) + "/" + r.branch.total + "</span>"
        : "";
      const headMark = r.active && r.absIdx === tipIdx ? '<span class="tcur">현재</span>' : "";
      // 활성 경로 메시지만 context 편집 가능 (chat.messages 인덱스와 일치)
      const editBtn = r.active
        ? '<button class="tedit" data-cedit="' + r.absIdx +
          '" type="button" title="내용 직접 수정 — LLM 재전송 없이 context만 교체">' + ICON_EDIT + "</button>"
        : "";
      // 표기 순서: [분기 pill] timestamp → 편집 → #번호 → 대화요약 → (우측) 현재·모델·토큰
      return '<div class="trow' + (r.active ? " act" : " dim") + '" data-ri="' + ri +
        '" style="height:' + rowH + 'px" title="' +
        esc((r.active ? "" : "클릭: 이 가지로 전환\n") + String(m.content || "").slice(0, 300)) + '">' +
        pill + '<span class="tts">' + esc(msgTs(m.ts)) + "</span>" + editBtn +
        '<span class="tidx">#' + r.absIdx + "</span>" +
        '<span class="tprev">' + esc(preview) + "</span>" +
        (headMark || meta
          ? '<span class="tmeta">' + headMark + (headMark && meta ? " · " : "") + esc(meta) + "</span>" : "") +
        "</div>";
    }).join("");

    box.innerHTML = '<div class="hint treehint">굵게 표시된 경로가 지금 보고 있는 대화입니다. ' +
      '흐린 행을 클릭하면 그 가지로 전환됩니다 — git checkout처럼 그래프 모양과 색은 그대로, 굵기만 이동합니다.</div>' +
      '<div class="tgraph">' +
      '<svg width="' + gutter + '" height="' + H + '" class="tsvg">' + svg + "</svg>" +
      '<div class="trows" style="margin-left:' + gutter + 'px">' + rowsHtml + "</div></div>";
  }

  document.getElementById("chat-tree").addEventListener("click", async (e) => {
    const te = e.target.closest(".tedit");
    if (te) {
      e.preventDefault();
      if ($("#chat-send").disabled) { toast("응답 대기 중에는 수정할 수 없습니다"); return; }
      state.editingIdx = null;
      state.ctxEditIdx = Number(te.getAttribute("data-cedit"));
      renderChatMessages();
      const wrap = $("#chat-messages").children[state.ctxEditIdx];
      if (wrap) scrollMsgIntoTop(wrap);
      const ta = document.getElementById("ctx-edit-ta");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    const rowEl = e.target.closest(".trow[data-ri]");
    if (!rowEl) return;
    const row = (state.treeRows || [])[Number(rowEl.getAttribute("data-ri"))];
    if (!row) return;
    if (row.active) {
      // 활성 경로 행: 해당 메시지로 스크롤
      const el = $("#chat-messages").children[row.absIdx];
      if (el) {
        scrollMsgIntoTop(el);
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1200);
      }
      return;
    }
    // 비활성 행 클릭 = checkout: 필요한 분기 선택(바깥쪽→안쪽)을 한 요청으로 원자 전환.
    // graph 구조는 그대로 두고 강조(활성 경로)만 이동한다.
    if ($("#chat-send").disabled) { toast("응답 대기 중에는 분기를 전환할 수 없습니다"); return; }
    if (state.checkoutBusy) return; // 전환 진행 중 재클릭 무시 (인터리브 방지)
    state.checkoutBusy = true;
    const cid = state.chatId;
    let switchErr = null;
    try {
      try {
        const switches = (row.forks || []).filter((f) => !f.isActive)
          .map((f) => ({ index: f.bi, to: f.j }));
        await apiPost("api/chat/branch", { id: cid, switches: switches });
      } catch (err) { switchErr = err; }
      // 성공·실패와 무관하게 서버 상태로 재동기화
      if (state.chatId === cid) {
        state.editingIdx = null;
        state.ctxEditIdx = null;
        await loadChatDoc(cid);
      }
      refreshChats();
    } finally { state.checkoutBusy = false; }
    toast(switchErr ? "분기 전환 실패: " + switchErr.message
      : "분기 전환: 선택한 가지가 현재 대화가 되었습니다");
  });

  function renderChatRequest(preview) {
    const box = $("#chat-request");
    const lr = preview || (state.chatDoc && state.chatDoc.last_request);
    state.lastRenderedRequest = lr || null;
    if (!lr) {
      box.innerHTML = '<div class="empty">아직 전송된 요청이 없습니다.</div>';
      return;
    }
    box.innerHTML =
      '<div class="reqline"><code>' + esc(lr.method || "POST") + " " + esc(lr.url || "") + "</code> · payload " +
      (lr.payload_bytes || 0).toLocaleString() + " bytes · " + esc(lr.ts || "") +
      (lr.pending ? ' · <b>방금 전송됨 — 응답 대기 중</b>' : "") +
      ' <button class="copyreq" type="button" title="요청 전문 복사">요청 복사</button></div>' +
      '<h4>headers (토큰 마스킹)</h4><pre class="raw">' + esc(JSON.stringify(lr.headers || {}, null, 2)) + "</pre>" +
      '<h4>body (실제 전송 전문)</h4><pre class="raw">' + esc(JSON.stringify(lr.payload || {}, null, 2)) + "</pre>";
    const rbox = $("#chat-response");
    const lresp = state.chatDoc && state.chatDoc.last_response;
    if (!lresp || !lresp.envelope) {
      rbox.innerHTML = '<div class="empty">아직 수신된 응답이 없습니다.</div>';
      return;
    }
    rbox.innerHTML =
      '<div class="reqline"><code>HTTP 200</code> · ' + (lresp.bytes || 0).toLocaleString() + " bytes · " +
      (lresp.latency_ms ? (lresp.latency_ms / 1000).toFixed(1) + "초 · " : "") + esc(lresp.ts || "") + "</div>" +
      '<h4>envelope (수신 전문)</h4><pre class="raw">' + esc(JSON.stringify(lresp.envelope, null, 2)) + "</pre>";
  }

  async function sendChat() {
    const input = $("#chat-input");
    const btn = $("#chat-send");
    const msg = input.value.trim();
    if (!msg || btn.disabled) return;
    btn.disabled = true;
    input.value = "";
    const box = $("#chat-messages");
    if (!((state.chatDoc && state.chatDoc.messages) || []).length) box.innerHTML = "";
    box.insertAdjacentHTML("beforeend",
      '<div class="msgwrap user" id="chat-just-sent"><div class="msg user">' + esc(msg) + "</div></div>");
    box.insertAdjacentHTML("beforeend",
      '<div class="msg pending" id="chat-pending"><span class="spin"></span> 응답 대기 중 ' +
      timerHtml(Date.now()) + "</div>");
    // 방금 보낸 질문을 채팅창 상단에 앵커 — 질문과 그 아래 대기 타이머가 항상 보이게
    scrollMsgIntoTop(document.getElementById("chat-just-sent"));
    renderChatRequest(buildRequestPreview(msg)); // 요청 전문은 전송 직후 즉시 표시
    const sentChatId = state.chatId; // 응답 도착 시 사용자가 다른 대화로 이동했으면 화면을 뺏지 않는다
    try {
      const r = await apiPost("api/chat/send", {
        id: sentChatId, message: msg, model: $("#model").value,
        system: $("#chat-system").value.trim(),
      });
      const stillViewing = state.chatId === sentChatId; // 새 대화(null)였다면 여전히 null인지
      if (stillViewing) {
        state.scrollAnchor = "last-user"; // 답변 도착 후에도 질문을 상단에 유지
        await loadChatDoc(r.id);
      }
      refreshChats(); // 목록(토큰·턴 수)만 갱신, 현재 선택 유지
    } catch (e) {
      if (state.chatId === sentChatId) {
        const p = document.getElementById("chat-pending");
        if (p) p.remove();
        input.value = msg; // 실패 시 입력 복원 (서버도 user 메시지를 저장하지 않음)
      }
      toast("전송 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  $("#chat-send").addEventListener("click", sendChat);
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendChat();
  });
  $("#chat-new").addEventListener("click", () => {
    state.chatId = null;
    state.chatDoc = null;
    $("#chat-system").value = DEFAULT_CHAT_SYSTEM;
    renderChatList();
    renderChatMessages();
    pushRoute(); // 목록(새 대화) 상태도 history entry — 뒤로가기로 이전 대화 복귀
    $("#chat-input").focus();
    toast("새 대화 — 첫 메시지를 보내면 생성됩니다");
  });
  $("#chat-list").addEventListener("click", (e) => {
    const rn = e.target.closest(".crename");
    if (rn) { startChatRename(rn.getAttribute("data-cid")); return; }
    const pn = e.target.closest(".cpin");
    if (pn) { togglePin(pn.getAttribute("data-cid")); return; }
    const mv = e.target.closest(".cmove");
    if (mv) { openMoveModal(mv.getAttribute("data-cid")); return; }
    const pr = e.target.closest(".prename");
    if (pr) { startProjectRename(pr.getAttribute("data-pid")); return; }
    const pd = e.target.closest(".pdel");
    if (pd) { deleteProject(pd.getAttribute("data-pid")); return; }
    if (e.target.closest("input")) return; // 이름 변경 입력 중 클릭은 무시
    const it = e.target.closest("[data-chat]");
    if (it && it.getAttribute("data-chat") !== state.chatId) loadChatDoc(it.getAttribute("data-chat"));
  });

  // 인라인 이름 변경 공통: target 요소를 input으로 바꾸고 Enter/blur 확정, Esc 취소
  function inlineRename(el, current, onCommit) {
    el.innerHTML = '<input class="rninput" type="text" maxlength="60">';
    const inp = el.querySelector("input");
    inp.value = current;
    inp.focus();
    inp.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const name = inp.value.trim();
      if (!name || name === current) { renderChatList(); return; }
      try { await onCommit(name); } catch (err) {
        toast("이름 변경 실패: " + (err.code ? "(" + err.code + ") " : "") + err.message);
        renderChatList();
      }
    };
    inp.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") commit();
      else if (ev.key === "Escape") { done = true; renderChatList(); }
    });
    inp.addEventListener("blur", commit);
  }

  function startChatRename(cid) {
    const item = $("#chat-list").querySelector('[data-chat="' + cid + '"]');
    const c = (state.chats || []).find((x) => x.id === cid);
    if (!item || !c) return;
    inlineRename(item.querySelector(".ctitle"), c.title, async (name) => {
      await apiPost("api/chat/meta", { id: cid, title: name });
      await refreshChats();
      toast("대화 이름을 변경했습니다");
    });
  }

  function startProjectRename(pid) {
    const btn = $("#chat-list").querySelector('.prename[data-pid="' + pid + '"]');
    const p = (state.projects || {})[pid];
    if (!btn || !p) return;
    inlineRename(btn.closest(".lsec"), p.name, async (name) => {
      await apiPost("api/project/rename", { id: pid, name: name });
      await refreshChats();
      toast("프로젝트 이름을 변경했습니다");
    });
  }

  async function deleteProject(pid) {
    const p = (state.projects || {})[pid];
    if (!p) return;
    const n = (state.chats || []).filter((c) => c.project === pid).length;
    if (!confirm('프로젝트 "' + p.name + '"을(를) 삭제합니다.' +
      (n ? "\n소속 대화 " + n + "개는 삭제되지 않고 최상위 목록으로 이동합니다." : ""))) return;
    try {
      await apiPost("api/project/delete", { id: pid });
      await refreshChats();
      toast("프로젝트를 삭제했습니다" + (n ? " — 대화 " + n + "개는 최상위로 이동" : ""));
    } catch (err) { toast("삭제 실패: " + (err.code ? "(" + err.code + ") " : "") + err.message); }
  }

  $("#chat-newproj").addEventListener("click", async () => {
    const name = prompt("새 프로젝트 이름을 입력하세요");
    if (name == null || !name.trim()) return;
    try {
      await apiPost("api/project/create", { name: name.trim() });
      await refreshChats();
      toast("프로젝트를 만들었습니다 — 대화 항목의 폴더 아이콘으로 이동하세요");
    } catch (err) { toast("생성 실패: " + (err.code ? "(" + err.code + ") " : "") + err.message); }
  });

  async function togglePin(cid) {
    const c = (state.chats || []).find((x) => x.id === cid);
    if (!c) return;
    try {
      await apiPost("api/chat/meta", { id: cid, pinned: !c.pinned });
      await refreshChats();
      toast(c.pinned ? "고정을 해제했습니다" : "상위에 고정했습니다");
    } catch (err) { toast("고정 변경 실패: " + err.message); }
  }

  function openMoveModal(cid) {
    const c = (state.chats || []).find((x) => x.id === cid);
    if (!c) return;
    const projects = state.projects || {};
    const rows = Object.keys(projects).map((pid) =>
      '<button class="small mvopt" type="button" data-mvp="' + esc(pid) + '"' +
      (c.project === pid ? " disabled" : "") + ">" + ICON_FOLDER + " " +
      esc(projects[pid].name) + (c.project === pid ? " (현재)" : "") + "</button>").join(" ");
    openHtmlModal('"' + c.title + '" 프로젝트로 이동',
      '<div class="hint">이동할 프로젝트를 선택하거나 새로 만듭니다. 프로젝트는 최신 대화 활동순으로 정렬됩니다.</div>' +
      (rows ? '<div class="dsbtns" style="flex-wrap:wrap;gap:6px;margin:8px 0">' + rows + "</div>"
        : '<div class="empty">아직 프로젝트가 없습니다 — 아래에서 새로 만드세요.</div>') +
      '<div class="dsbtns" style="margin-top:10px;gap:6px">' +
      '<input id="mv-newname" class="rninput" type="text" placeholder="새 프로젝트 이름" maxlength="60">' +
      '<button id="mv-create" class="small" type="button">새 프로젝트 만들어 이동</button>' +
      (c.project ? '<button id="mv-root" class="small" type="button">프로젝트에서 제거</button>' : "") + "</div>");
    // onclick 할당(누적 방지) — modal-form은 재사용되는 요소라 addEventListener를 겹쳐 달면 안 된다
    $("#modal-form").onclick = async (e) => {
      const opt = e.target.closest(".mvopt");
      const create = e.target.closest("#mv-create");
      const root = e.target.closest("#mv-root");
      if (!opt && !create && !root) return;
      try {
        let pid = opt ? opt.getAttribute("data-mvp") : "";
        if (create) {
          const name = (document.getElementById("mv-newname").value || "").trim();
          if (!name) { toast("프로젝트 이름을 입력하세요"); return; }
          pid = (await apiPost("api/project/create", { name: name })).id;
        }
        await apiPost("api/chat/meta", { id: cid, project: pid });
        $("#modal-form").onclick = null;
        $("#modal-overlay").hidden = true;
        await refreshChats();
        toast(pid ? "프로젝트로 이동했습니다" : "프로젝트에서 제거했습니다");
      } catch (err) { toast("이동 실패: " + (err.code ? "(" + err.code + ") " : "") + err.message); }
    };
  }
  function copyText(text, label) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(label + "을(를) 클립보드에 복사했습니다"))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  $("#chat-messages").addEventListener("click", (e) => {
    const cc = e.target.closest(".copycode");
    if (cc) {
      copyText(cc.closest(".codewrap").querySelector("code").textContent, "코드");
      return;
    }
    const cm = e.target.closest(".copymsg");
    if (cm) {
      const m = ((state.chatDoc || {}).messages || [])[Number(cm.getAttribute("data-mi"))];
      if (m) copyText(m.content, m.role === "assistant" ? "답변 전체" : "메시지"); // 원문 그대로 복사
      return;
    }
    const em = e.target.closest(".editmsg");
    if (em) {
      if ($("#chat-send").disabled) { toast("응답 대기 중에는 수정할 수 없습니다"); return; }
      state.ctxEditIdx = null;
      state.editingIdx = Number(em.getAttribute("data-mi"));
      renderChatMessages();
      const ta = document.getElementById("edit-msg-ta");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    if (e.target.closest("#edit-msg-cancel")) {
      state.editingIdx = null;
      renderChatMessages();
      return;
    }
    if (e.target.closest("#edit-msg-send")) {
      sendEdit();
      return;
    }
    if (e.target.closest("#ctx-edit-cancel")) {
      state.ctxEditIdx = null;
      renderChatMessages();
      return;
    }
    if (e.target.closest("#ctx-edit-save")) {
      saveContextEdit();
      return;
    }
    const bs = e.target.closest(".bstep");
    if (bs) {
      switchBranch(Number(bs.getAttribute("data-bi")), Number(bs.getAttribute("data-dir")));
      return;
    }
  });

  async function sendEdit() {
    const i = state.editingIdx;
    const ta = document.getElementById("edit-msg-ta");
    if (i == null || !ta) return;
    const content = ta.value.trim();
    if (!content) { toast("내용이 비어 있습니다"); return; }
    const btn = $("#chat-send");
    if (btn.disabled) return;
    btn.disabled = true;
    const sendBtn = document.getElementById("edit-msg-send");
    if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<span class="spin"></span> 응답 대기 중'; }
    const sentChatId = state.chatId;
    try {
      const r = await apiPost("api/chat/edit", {
        id: sentChatId, index: i, message: content,
        model: $("#model").value, system: $("#chat-system").value.trim(),
      });
      if (state.chatId === sentChatId) { // 다른 대화로 이동했으면 화면 유지
        state.editingIdx = null;
        state.scrollAnchor = i; // 수정한 질문을 상단에 앵커
        await loadChatDoc(r.id);
      }
      refreshChats();
      toast("분기 생성: " + (r.branch.active + 1) + "/" + r.branch.total);
    } catch (e) {
      toast("수정 전송 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = "전송"; }
    } finally {
      btn.disabled = false;
    }
  }

  async function saveContextEdit() {
    // context 편집 저장: LLM 호출 없이 이력만 교체 — 다음 질문부터 반영
    const i = state.ctxEditIdx;
    const ta = document.getElementById("ctx-edit-ta");
    if (i == null || !ta) return;
    const content = ta.value.trim();
    if (!content) { toast("내용이 비어 있습니다"); return; }
    const saveBtn = document.getElementById("ctx-edit-save");
    if (saveBtn) saveBtn.disabled = true;
    const sentChatId = state.chatId;
    try {
      await apiPost("api/chat/update", { id: sentChatId, index: i, content: content });
      if (state.chatId === sentChatId) { // 다른 대화로 이동했으면 화면 유지
        state.ctxEditIdx = null;
        state.scrollAnchor = i;
        await loadChatDoc(sentChatId);
      }
      toast("#" + i + " 내용 수정 완료 — 다음 질문부터 반영됩니다");
    } catch (e) {
      toast("수정 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function switchBranch(index, dir) {
    const entry = ((state.chatDoc || {}).alts || {})[String(index)];
    if (!entry) return;
    const to = entry.active + dir;
    if (to < 0 || to >= entry.variants.length) return;
    if (state.checkoutBusy) return; // 진행 중 전환과 인터리브 방지
    state.checkoutBusy = true;
    try {
      await apiPost("api/chat/branch", { id: state.chatId, index: index, to: to });
      await loadChatDoc(state.chatId);
      refreshChats(state.chatId);
    } catch (e) { toast("분기 전환 실패: " + e.message); }
    finally { state.checkoutBusy = false; }
  }
  $("#chat-request").addEventListener("click", (e) => {
    if (!e.target.closest(".copyreq")) return;
    const lr = state.lastRenderedRequest;
    if (!lr) return;
    copyText(JSON.stringify({ method: lr.method, url: lr.url, headers: lr.headers, body: lr.payload }, null, 2), "요청 전문");
  });

  // ---- 로그 탭 ----
  async function renderLogPanel() {
    const panel = $("#log-panel");
    if (panel.hidden) return;
    let logs = [];
    try {
      logs = (await api("api/dataset/log?limit=200")).logs || [];
    } catch (e) { /* 아래 empty 처리 */ }
    const box = $("#log-table");
    if (!logs.length) {
      box.innerHTML = '<div class="empty">기록된 로그가 없습니다.</div>';
      return;
    }
    box.innerHTML = '<div class="tblwrap"><table><thead><tr><th>시각</th><th>user</th><th>action</th><th>파일</th><th>상세</th></tr></thead><tbody>' +
      logs.map((l) => "<tr><td>" + esc(l.ts || "") + "</td><td>" + esc(l.user || "") + "</td><td>" + esc(l.action || "") +
        "</td><td>" + esc(l.file || "") + '</td><td class="logdetail">' + esc(JSON.stringify(l.detail || {})) + "</td></tr>").join("") +
      "</tbody></table></div>";
  }
  $("#log-refresh").addEventListener("click", renderLogPanel);

  $("#ds-save").addEventListener("click", () => {
    apiPost("api/dataset/save", { user: state.user }).then((r) => {
      $("#ds-file").textContent = r.file;
      toast(r.count + "행을 " + r.file + " 에 저장했습니다 (덮어쓰기)");
    }).catch((e) => toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  });
  $("#ds-saveas").addEventListener("click", () => {
    apiPost("api/dataset/saveas", { user: state.user }).then((r) => {
      $("#ds-file").textContent = r.file;
      if (state.dataset) state.dataset.file = r.file;
      toast(r.count + "행을 새 파일 " + r.file + " 으로 저장했습니다");
    }).catch((e) => toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message));
  });
  $("#ds-refresh").addEventListener("click", refreshDataset);
  $("#ds-clear").addEventListener("click", () => {
    if (!window.confirm("데이터셋의 모든 행을 삭제할까요?")) return;
    apiPost("api/dataset/clear", {}).then(() => {
      toast("데이터셋을 비웠습니다");
      refreshDataset();
    }).catch((e) => toast("비우기 실패: " + e.message));
  });

  $("#result").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ds-insert]");
    if (!b || b.disabled) return;
    const jid = b.getAttribute("data-ds-insert");
    b.disabled = true;
    apiPost("api/dataset/insert", { job_id: jid, user: state.user }).then((r) => {
      if (r.already) {
        b.textContent = "데이터셋에 추가됨";
        toast("이미 추가된 작업입니다 (누적 " + r.total + "행)");
      } else {
        b.textContent = "데이터셋에 추가됨 (누적 " + r.total + "행)";
        toast(r.inserted + "행을 데이터셋에 추가했습니다 (누적 " + r.total + "행)");
      }
      // 갱신된 표가 화면 밖(결과 패널 위)에 있어 안 보이는 문제 방지 — 추가 직후 보여준다
      refreshDataset().then(() => {
        const p = document.getElementById("dataset-panel");
        if (p && !p.hidden) p.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }).catch((err) => {
      b.disabled = false;
      toast("추가 실패: " + (err.code ? "(" + err.code + ") " : "") + err.message);
    });
  });

  // ---- 설정 (LLM 연결 / 시스템 프롬프트) 조회·저장 ----
  async function loadSettings() {
    try {
      const c = await api("api/config");
      $("#config").value = JSON.stringify(c.config, null, 2);
      $("#config-path").textContent = c.config_path || "";
      state.contextLimit = parseInt(c.config.context_limit_tokens, 10) || 200000;
      state.llmConfig = c.config;              // 대화 탭 요청 미리보기용
      state.llmStatus = c.status;              // 마스킹된 headers
    } catch (e) {
      $("#config").value = "// 설정 로드 실패: " + e.message;
    }
    try {
      const r = await fetch("api/prompt");
      if (!r.ok) throw new Error("HTTP " + r.status);
      $("#prompt").value = await r.text();
    } catch (e) {
      $("#prompt").value = "// 프롬프트 로드 실패: " + e.message;
    }
  }

  async function saveConfig() {
    let cfg;
    try {
      cfg = JSON.parse($("#config").value);
    } catch (e) {
      toast("설정이 올바른 JSON이 아닙니다: " + e.message);
      return;
    }
    try {
      const resp = await apiPost("api/config", { config: cfg });
      $("#config").value = JSON.stringify(resp.config, null, 2);
      toast("LLM 연결 설정을 저장했습니다 — 다음 변환부터 적용");
      refreshLlmStatus();
    } catch (e) {
      toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    }
  }

  async function savePrompt() {
    try {
      await apiPost("api/prompt", { text: $("#prompt").value });
      toast("시스템 프롬프트를 저장했습니다 — 다음 변환부터 적용");
    } catch (e) {
      toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    }
  }

  // ---- 상단 LLM(업스트림) 상태 ----
  async function refreshLlmStatus() {
    try {
      const h = await api("api/llm/health");
      const el = $("#llm-status");
      if (!h.reachable) {
        el.innerHTML = "LLM <b>연결 안 됨</b>";
        return;
      }
      const ex = h.executor || {};
      const busy = ex.running ? " · 실행 중(" + esc(ex.model || "?") + (ex.queued ? ", 대기 " + esc(ex.queued) : "") + ")" : "";
      const auth = h.auth && h.auth !== "ok" ? " · auth: " + esc(h.auth) : "";
      el.innerHTML = "LLM <b>연결됨</b>" + busy + auth;
    } catch (e) {
      $("#llm-status").textContent = "LLM 상태 조회 실패";
    }
  }

  // ---- 1초 tick: 경과 타이머 갱신 + 5초마다 LLM 상태 ----
  setInterval(() => {
    state.tick += 1;
    document.querySelectorAll("[data-timer]").forEach((el) => {
      const start = Number(el.getAttribute("data-start") || 0);
      if (start) el.textContent = Math.max(0, Math.round((Date.now() - start) / 1000)) + "초";
    });
    if (state.tick % 5 === 0) refreshLlmStatus();
  }, 1000);

  // ---- 이벤트 ----
  $("#run").addEventListener("click", submit);
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });
  $("#cancel").addEventListener("click", async () => {
    const target = activeCancelTarget();
    if (!target) { toast("취소할 진행 중 작업이 없습니다"); return; }
    try {
      const resp = await apiPost("api/cancel", { id: target });
      if (resp.requested) {
        const job = findJob(target);
        if (job) { job.cancel_requested = true; renderHistory(); }
        toast("취소 요청: " + target + (resp.active ? " (실행 중인 LLM 호출 중단)" : " (대기열에서 제거 예정)"));
      } else {
        toast("이미 종료된 작업입니다 (" + resp.state + ")");
      }
    } catch (e) { toast("취소 실패: " + e.message); }
  });
  async function refreshJobs() {
    try {
      const jobs = await api("api/jobs?limit=30");
      (jobs.jobs || []).forEach((j) => upsertJob({
        id: j.id, mode: j.mode || "fill", state: j.state, model: j.model, preview: j.input_preview,
        created_ms: Date.parse(j.created_at || "") || Date.now(),
        started_at_ms: j.started_at_ms, latency_ms: j.latency_ms, error: j.error,
        record_count: j.record_count, steps: j.steps || [], cancel_requested: j.cancel_requested,
      }));
      state.jobs.sort((a, b) => (a.id < b.id ? 1 : -1));
      renderHistory();
      updateCancelButton();
      toast("이력을 새로고침했습니다");
    } catch (e) { toast("이력 새로고침 실패: " + e.message); }
  }
  $("#refresh-jobs").addEventListener("click", refreshJobs);

  $("#history").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const id = del.getAttribute("data-del");
      apiDelete("api/job?id=" + encodeURIComponent(id)).then(() => {
        state.jobs = state.jobs.filter((j) => j.id !== id);
        state.fullJobs.delete(id);
        if (state.selected === id) { state.selected = null; state.renderedKey = null; }
        Object.values(state.tabState).forEach((t) => { if (t.selected === id) t.selected = null; });
        renderHistory();
        renderResult();
        toast("이력을 삭제했습니다: " + id);
      }).catch((err) => toast("삭제 실패: " + (err.code ? "(" + err.code + ") " : "") + err.message));
      return;
    }
    const retry = e.target.closest("[data-retry]");
    if (retry) {
      const job = findJob(retry.getAttribute("data-retry"));
      if (!job) return;
      const full = state.fullJobs.get(job.id);
      if (full) {
        $("#input").value = full.input_text || $("#input").value;
        $("#schema").value = JSON.stringify(full.schema, null, 2);
        submit();
      } else {
        // 문서를 아직 안 가져온 잡 — 현재 입력창 내용으로 오제출하지 않도록 먼저 불러온다
        api("api/job?id=" + encodeURIComponent(job.id)).then((doc) => {
          applyJobDoc(job, doc);
          $("#input").value = doc.input_text || "";
          $("#schema").value = JSON.stringify(doc.schema, null, 2);
          submit();
        }).catch((err) => toast("재시도 실패: 작업 문서를 불러오지 못했습니다 (" + err.message + ")"));
      }
      return;
    }
    const resume = e.target.closest("[data-resume]");
    if (resume) {
      const job = findJob(resume.getAttribute("data-resume"));
      if (job) { job.pollingStopped = false; renderHistory(); pollJob(job); }
      return;
    }
    const card = e.target.closest("[data-job]");
    if (card) {
      state.selected = card.getAttribute("data-job");
      const job = findJob(state.selected);
      if (job && !state.fullJobs.get(job.id) && (job.state === "done" || job.state === "error")) {
        // 서버 재기동 전 잡: 문서를 지금 가져온다
        api("api/job?id=" + encodeURIComponent(job.id))
          .then((doc) => { applyJobDoc(job, doc); renderResult(); })
          .catch(() => {});
      }
      renderHistory();
      renderResult();
    }
  });
  $("#save-config").addEventListener("click", saveConfig);
  $("#save-prompt").addEventListener("click", savePrompt);
  document.querySelectorAll("#tabs .tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.getAttribute("data-tab"))));
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove();
    toast(ok ? "결과 JSON을 클립보드에 복사했습니다" : "클립보드 복사 실패");
  }

  $("#copy-json").addEventListener("click", () => {
    const doc = state.selected && state.fullJobs.get(state.selected);
    if (!doc || !doc.result) { toast("복사할 결과가 없습니다"); return; }
    const text = JSON.stringify(doc.result, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast("결과 JSON을 클립보드에 복사했습니다"))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text); // HTTP 프록시 origin에서는 navigator.clipboard가 없음
    }
  });

  init();
})();
