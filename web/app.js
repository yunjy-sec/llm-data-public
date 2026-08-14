/* llm-data 프론트엔드 — 상대경로 fetch + 순수 폴링 (SSE 없음) */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const TAB_DESC = {
    fill: "데이터가 스키마를 전부 채우는 기본 시나리오",
    missing: "데이터에 빈 셀이 있어 스키마를 못 채우는 시나리오 빈 값 필드를 노란색 배경으로 표시",
    dataset: "변환 결과를 기존 데이터셋 표에 새 행으로 추가(insert) 방금 추가된 행은 녹색 표시",
    edit: "데이터셋 파일을 골라 HTML 표로 보고, 행 클릭 편집 새 행 추가 삭제(CRUD)를 modal로 수행",
    log: "행 CRUD와 데이터셋 마스터 작업의 감사 로그",
    master: "변환 CRUD가 참조하는 스키마와 코드 테이블(enum)을 관리",
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
      throw new Error("세션 만료 페이지를 새로고침해 다시 로그인하세요");
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
      state.modelList = models.models || [];
      state.modelOptions = models.options || {};   // {model: {temperature:[], reasoning_effort:[]}}
      state.scales = models.scales || {};          // 소요 시간·토큰 색상 범위 (설정에서 온다)
      state.defaultModel = models.default;
      initChatOptbar();
      renderSystemChips();
      state.examples = examples.examples || [];
      renderExampleButtons();
      if (!$("#schema").value) {
        const schema = await api("api/schema");
        $("#schema").value = JSON.stringify(schema, null, 2);
      }
      loadSettings();
      refreshRates();   // 주기·창 길이·색 범위는 이 응답에 담겨 온다
      // SSO: 1단계(로컬 에이전트 웹소켓)를 먼저 시도하고, 없거나 실패하면 쿠키만으로 확인한다.
      // 어느 쪽이 실패하든 id는 guest로 남고 나머지 기능은 그대로 동작한다.
      ssoSignIn().then((w) => w || api("api/whoami")).then(applySsoUser).catch(() => {});
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
      console.log("[init] 초기화 실패", e && e.stack ? e.stack : e);
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
    applyChatFullLayout(tab === "chat");
    setSidebar(false);
    pushRoute();
  }

  // ---- 소프트 키보드 대응 (keyboard occlusion) ----
  // 모바일에서 키보드가 올라오면 layout viewport(vh)는 그대로인데 실제로 보이는
  // visual viewport만 줄어들어 입력창이 키보드에 가린다. VisualViewport로 실측한
  // 높이를 --vvh에 넣어 채팅 영역이 항상 "보이는 만큼만" 차지하게 한다.
  function syncViewportHeight() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    // iOS는 레이아웃을 줄이지 않고 페이지를 밀어 올리므로 오프셋도 보정한다
    document.documentElement.style.setProperty("--vvtop", (vv.offsetTop || 0) + "px");
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
    window.visualViewport.addEventListener("scroll", syncViewportHeight);
    syncViewportHeight();
  }
  // 입력창에 포커스가 가면 키보드가 올라온 뒤 확실히 보이도록 스크롤을 맞춘다
  $("#chat-input").addEventListener("focus", () => {
    setTimeout(() => {
      syncViewportHeight();
      const el = document.querySelector(".chatinput");
      if (el) el.scrollIntoView({ block: "nearest" });
      const box = $("#chat-messages");
      if (box && !state.userScrolled) { markProgScroll(); box.scrollTop = box.scrollHeight; }
    }, 250);
  });

  // ---- info 툴팁 (긴 안내문 대체) ----
  // 아이콘을 누르면(터치·클릭) 말풍선으로 설명을 띄우고, 다른 곳을 누르면 닫는다.
  // 설명 원문은 아이콘의 data-tip에 두므로 마크업만 추가하면 어디서든 재사용된다.
  function hideTip() {
    const b = document.getElementById("tipbubble");
    if (b) b.remove();
    document.querySelectorAll(".infotip.on").forEach((el) => el.classList.remove("on"));
  }

  function showTip(btn) {
    hideTip();
    btn.classList.add("on");
    const b = document.createElement("div");
    b.id = "tipbubble";
    b.innerHTML = btn.getAttribute("data-tip") || "";
    document.body.appendChild(b);
    const r = btn.getBoundingClientRect(), bb = b.getBoundingClientRect();
    let left = Math.min(Math.max(8, r.left - 6), window.innerWidth - bb.width - 8);
    let top = r.bottom + 6;
    if (top + bb.height > window.innerHeight - 8) top = Math.max(8, r.top - bb.height - 6);
    b.style.left = Math.round(left) + "px";
    b.style.top = Math.round(top) + "px";
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".infotip");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains("on")) hideTip(); else showTip(btn);
      return;
    }
    if (!e.target.closest("#tipbubble")) hideTip();
  });
  window.addEventListener("scroll", hideTip, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });

  // ---- 모바일 사이드바 드로어 (off-canvas) ----
  function setSidebar(open) {
    document.body.classList.toggle("sideopen", !!open);
    const bd = document.getElementById("side-backdrop");
    if (bd) bd.hidden = !open;
    const btn = document.getElementById("side-toggle");
    if (btn) btn.setAttribute("aria-label", open ? "대화 목록 닫기" : "대화 목록 열기");
    updateProjectRail();
  }

  // 현재 보고 있는 대화(또는 프로젝트 홈)가 속한 프로젝트
  function currentProjectId() {
    if (state.viewProject) return state.viewProject;
    const c = (state.chats || []).find((x) => x.id === state.chatId);
    return (c && c.project) || null;
  }

  // 드로어 오른쪽에 딱 붙는 프로젝트 이름 레일 — 드로어가 열려 있고 소속 프로젝트가 있을 때만
  function updateProjectRail() {
    const rail = document.getElementById("project-rail");
    if (!rail) return;
    const pid = currentProjectId();
    const p = pid ? (state.projects || {})[pid] : null;
    if (!p || !document.body.classList.contains("sideopen")) { rail.hidden = true; return; }
    rail.hidden = false;
    rail.setAttribute("data-pid", pid);
    rail.innerHTML = ICON_FOLDER + "<span>" + esc(p.name) + "</span>";
  }

  document.getElementById("project-rail").addEventListener("click", (e) => {
    const pid = e.currentTarget.getAttribute("data-pid");
    if (pid) openProjectHome(pid);
  });
  document.getElementById("side-toggle").addEventListener("click", () => {
    setSidebar(!document.body.classList.contains("sideopen"));
  });
  document.getElementById("side-backdrop").addEventListener("click", () => setSidebar(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("sideopen")) setSidebar(false);
  });

  // 대화 탭은 ChatGPT식 전체 화면 2분할 — 탭 버튼도 좌측 사이드로 옮긴다.
  // 원래 위치(부모·다음 형제)를 기억해 두었다가 다른 탭으로 나갈 때 그대로 되돌린다.
  function applyChatFullLayout(on) {
    const nav = document.getElementById("tabs");
    const slot = document.getElementById("chat-tabs-slot");
    if (!nav || !slot) return;
    if (on) {
      if (!state.tabsHome) state.tabsHome = { parent: nav.parentNode, next: nav.nextSibling };
      if (nav.parentNode !== slot) slot.appendChild(nav);
      syncHeadHeight();
      document.body.classList.add("chatfull");
    } else {
      if (state.tabsHome && nav.parentNode === slot) {
        state.tabsHome.parent.insertBefore(nav, state.tabsHome.next);
      }
      document.body.classList.remove("chatfull");
    }
  }

  // ---- 라우팅: 탭·대화 목록·개별 대화를 hash로 표현 — 브라우저 뒤로/앞으로 가기 지원 ----
  const ROUTE_TABS = ["fill", "missing", "dataset", "edit", "log", "master", "chat"];
  let applyingRoute = false; // hashchange 적용 중 pushRoute 재진입 방지

  function pushRoute() {
    if (applyingRoute) return;
    let h = "#tab=" + state.tab;
    if (state.tab === "chat" && state.viewProject) h += "&project=" + state.viewProject;
    else if (state.tab === "chat" && state.chatId) h += "&chat=" + state.chatId;
    if (location.hash !== h) location.hash = h; // 할당 = history entry 생성 → 뒤로가기 동작
  }

  async function applyRoute() {
    const m = /^#tab=([a-z]+)(?:&chat=([A-Za-z0-9-]+))?(?:&project=([A-Za-z0-9-]+))?/.exec(location.hash || "");
    if (!m || !ROUTE_TABS.includes(m[1])) return;
    const tab = m[1], chat = m[2] || null, proj = m[3] || null;
    applyingRoute = true;
    try {
      if (tab !== state.tab) switchTab(tab);
      if (tab === "chat") {
        if (proj) {
          state.viewProject = proj;
          if (state.openProjects) delete state.openProjects[proj];
          renderChatList();
          renderProjectHome();
          return;
        }
        if (state.viewProject) { // 프로젝트 홈에서 벗어나는 경우
          state.viewProject = null;
          $("#project-home").hidden = true;
          document.querySelector(".chatmain").classList.remove("projmode");
          renderChatList();
        }
        if (chat && chat !== state.chatId) await loadChatDoc(chat);
        else if (!chat && state.chatId) {
          // 대화 미지정 route = 목록(새 대화 대기) 상태
          state.chatId = null;
          state.chatDoc = null;
          $("#chat-system").value = DEFAULT_CHAT_SYSTEM;
      markSystemChips();
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
      const sec = job.latency_ms != null ? (job.latency_ms / 1000).toFixed(1) + "s" : "";
      return '<span class="chip ok">완료 ' + sec + " " + (job.record_count || 0) + "건</span>";
    }
    return '<span class="chip err">실패</span>';
  }

  function fmtDur(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "s";
  }

  function elapsedSec(startMs) {
    return Math.max(0, Math.round((Date.now() - startMs) / 1000));
  }

  function elapsedText(startMs) {
    return elapsedSec(startMs) + "s";
  }

  // 재렌더링 시 "0s"로 초기화되면 1초 tick이 고칠 때까지 0s↔Ns로 깜빡인다.
  // 처음부터 현재 경과값으로 그려서 리셋을 우회한다.
  // 대기 중인 시간도 응답 시간과 같은 색 스케일을 따른다 — 오래 걸릴수록 진해진다.
  function timerHtml(startMs) {
    const start = startMs || Date.now();
    const sec = elapsedSec(start);
    return '<b data-timer data-start="' + start + '" style="color:' + latencyColor(sec) + '">' +
      sec + "s</b>";
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
      return highlightMissing ? '<td class="miss"></td>' : '<td class="null"> </td>';
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
      ? '<div class="reqline"><code>' + esc(req.method || "POST") + " " + esc(req.url) + "</code> model <b>" +
        esc(req.model || "") + "</b> payload " + (req.payload_bytes || 0).toLocaleString() + " bytes response_format " +
        (req.response_format ? "YES" : "no") + " timeout " + (req.timeout_s || "?") + "s</div>"
      : '<div class="empty">LLM 요청 정보는 프롬프트 구성 후 표시됩니다.</div>';
    const reqHeaders = req.url
      ? (req.headers
        ? '<h4>headers (토큰 마스킹)</h4><pre class="raw">' + esc(JSON.stringify(req.headers, null, 2)) + "</pre>"
        : '<button type="button" class="infotip" aria-label="설명" data-tip="headers 기록 추가 전에 실행된 작업이라 headers 전문이 없습니다. 새 변환부터 표시됩니다.">i</button>')
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
      html += '<div class="usage">tokens: ' + esc(u.prompt_tokens) + " in / " + esc(u.completion_tokens) + " out model " + esc(doc.model || "") + "</div>";
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
        (String(d.what).indexOf("헤더") !== -1 ? " 스키마 변경은 마스터 관리 탭에서 하세요" : " (자동 관리 열)"));
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
      (ds.last_insert ? " 최근 추가 " + ds.last_insert.count + "행" : "");
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
    missing.forEach((c) => violations.push("헤더: '" + c + "' 열이 변경되거나 삭제됨 스키마 변경은 마스터 관리 탭에서"));
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
          violations.push("행 " + (pr.id || "신규") + ": '" + k + "' 값 '" + v + "' 허용 코드: " + spec.enum.join(", "));
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
        ? '<div class="jerr">정합성 위반 ' + violations.length + "건 아래 항목을 수정한 뒤 다시 \"시트 변경사항 적용\"으로 검증하세요. 저장할 수 없습니다.</div>" +
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
      toast("저장 완료: 수정 " + r.updated + " 추가 " + r.created + " 삭제 " + r.deleted + " (총 " + r.total + "행)");
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
    return '<label class="mfield"><span title="id: ' + esc(k) + (desc ? " " + desc : "") + '">' + esc(shown) + "</span>" + input + "</label>";
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
      (row ? '<div class="meta-ro">user_id ' + esc(row.user_id || "") + " created " + esc(row.created_at || "") +
             " updated " + esc(row.updated_at || "") + " (자동 관리 편집 불가)</div>" : "");
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
        o.textContent = m.name + " (" + m.fields + "필드 코드 " + m.codes + ")";
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
          const cell = (v) => "<td>" + (v ? esc(v) : '<span class="null"> </span>') + "</td>";
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
    $("#modal-title").textContent = fieldName ? "필드 편집 " + fieldName : "새 필드 추가";
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
      line("name", "id (key)", fieldName || "", "영문 숫자 _") +
      line("label", "label (표시명)", spec.label, "예: 시료 번호") +
      line("type", "type", spec.type || "string", "string") +
      line("desc", "description", spec.description, "필드의 의미") +
      line("desc2", "description_detail", spec.description_detail, "상세 규칙 (없으면 비움)") +
      line("mlogic1", "mapping_logic_ip_eval_esd", spec.mapping_logic_ip_eval_esd, "원본 열에서 가져오는 방법") +
      line("mlogic2", "mapping_logic_chatbot", spec.mapping_logic_chatbot, "챗봇 매핑 지침") +
      line("codes", "enum (코드 테이블)", Array.isArray(spec.enum) ? spec.enum.join(", ") : "", "콤마 구분, 비우면 자유 입력") +
      '<div class="meta-ro">필드 = id(key) label type description description_detail mapping_logic_ip_eval_esd mapping_logic_chatbot' +
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
    if (!/^[A-Za-z0-9_]{1,60}$/.test(name)) { toast("필드명은 영문 숫자 _ 만 (1~60자)"); return; }
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
    toast("필드 반영 상단 '저장'으로 확정하세요");
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
      window.alert("삭제 불가 '" + ds.file + "' 데이터셋 " + usedIds.length + "개 행에 '" + name + "' 데이터가 있습니다.\n행 id: " + preview);
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
    toast("필드 삭제 반영 상단 '저장'으로 확정하세요");
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
      toast("적용 완료: 추가 " + r.added.length + " 제거 " + r.removed.length + " 이관 " +
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
        toast("group 이름 변경 상단 '저장'으로 확정하세요");
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
    const name = window.prompt("새 스키마 이름 (영문 숫자 - _ 1~40자):", "");
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
      window.alert("삭제 불가 마스터 '" + name + "'에 연결된 데이터가 있습니다.\n'" +
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
  // 기본은 비워 둔다 — 아무 지시도 붙이지 않고 모델 기본 동작 그대로 쓴다.
  const DEFAULT_CHAT_SYSTEM = "";

  // 자주 쓰는 지시 묶음. 칩을 누르면 아래 입력칸을 그 내용으로 채운다.
  // 그대로 쓰거나 고쳐 쓰면 되고, 직접 입력해도 된다. 여기만 고치면 칩이 바뀐다.
  const SYSTEM_PRESETS = [
    {
      label: "빠른 대답", tip: "핵심만 짧게. 결론 먼저",
      text: [
        "핵심만 짧게 답하세요.",
        "",
        "- 결론을 첫 문장에 씁니다. 서론과 인사말은 쓰지 않습니다.",
        "- 3문장을 넘기지 않습니다. 목록이 필요하면 항목 5개 이내로 줄입니다.",
        "- 물어본 것만 답하고, 묻지 않은 배경 설명은 덧붙이지 않습니다.",
        "- 확실하지 않으면 추측하지 말고 모른다고 말합니다.",
      ].join("\n"),
    },
    {
      label: "기본 대답", tip: "정확하고 간결하게. 근거 한 줄",
      text: [
        "정확하고 간결하게 답하세요.",
        "",
        "- 결론을 먼저 쓰고, 그렇게 판단한 근거를 한두 줄로 덧붙입니다.",
        "- 사실과 추정을 구분해 적습니다. 추정이면 그렇다고 밝힙니다.",
        "- 모르는 것은 지어내지 않습니다. 확인이 필요하면 무엇을 확인해야 하는지 적습니다.",
        "- 코드나 명령을 줄 때는 그대로 실행할 수 있는 형태로 씁니다.",
        "- 답이 길어지면 소제목으로 나누되, 불필요하게 늘리지 않습니다.",
      ].join("\n"),
    },
    {
      label: "상세 전문가 대답", tip: "배경·근거·예외·주의점까지",
      text: [
        "해당 분야 전문가로서 깊이 있게 답하세요.",
        "",
        "1. 결론을 먼저 제시합니다.",
        "2. 그 결론의 근거와 전제를 설명합니다. 어떤 조건에서 성립하는지 밝힙니다.",
        "3. 예외와 실패하는 경우, 흔히 하는 오해를 짚습니다.",
        "4. 대안이 있으면 장단점을 비교하고, 어느 쪽을 언제 쓰는지 적습니다.",
        "5. 실제로 적용할 때의 주의점과 확인 방법을 마지막에 정리합니다.",
        "",
        "판단이 갈리는 지점은 어느 쪽 근거가 더 강한지 밝히고, 확실하지 않은 부분은",
        "확실하지 않다고 표시합니다. 근거 없이 단정하지 않습니다.",
        "필요하면 표나 예시를 써서 비교를 분명히 합니다.",
      ].join("\n"),
    },
    {
      label: "정형 format 출력", tip: "요청한 형식만 그대로",
      text: [
        "요청받은 형식으로만 출력하세요.",
        "",
        "- 형식 밖의 인사말, 머리말, 맺음말, 설명을 붙이지 않습니다.",
        "- JSON을 요청받으면 파싱 가능한 JSON만 출력합니다. 주석과 후행 쉼표를 넣지 않고,",
        "  코드 펜스로 감싸지 않습니다.",
        "- 표를 요청받으면 표만 출력합니다. 열 이름과 순서를 요청한 그대로 유지합니다.",
        "- 값이 없으면 비워 두거나 null을 씁니다. 임의로 채워 넣지 않습니다.",
        "- 형식이 모호하면 가장 단순한 해석을 택하고, 그 해석을 형식 안에서 표현합니다.",
      ].join("\n"),
    },
  ];
  function renderSystemChips() {
    const box = document.getElementById("chat-system-chips");
    if (!box || box.dataset.ready) return;
    box.dataset.ready = "1";
    box.innerHTML = SYSTEM_PRESETS.map((p, i) =>
      '<button type="button" class="pchipbtn" data-preset="' + i + '" title="' + esc(p.tip) + '">' +
      esc(p.label) + "</button>").join("") +
      '<button type="button" class="pchipbtn ghost" data-preset="clear" title="비우기">비우기</button>';
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-preset]");
      if (!b) return;
      const key = b.getAttribute("data-preset");
      const ta = $("#chat-system");
      ta.value = key === "clear" ? "" : (SYSTEM_PRESETS[Number(key)] || {}).text || "";
      ta.focus();
      markSystemChips();
    });
    markSystemChips();
  }

  // 지금 입력칸 내용과 같은 칩을 눌린 상태로 표시 — 무엇이 적용됐는지 한눈에 보이게
  function markSystemChips() {
    const box = document.getElementById("chat-system-chips");
    if (!box) return;
    const cur = ($("#chat-system").value || "").trim();
    box.querySelectorAll("[data-preset]").forEach((b) => {
      const key = b.getAttribute("data-preset");
      const on = key === "clear" ? cur === ""
        : cur === (((SYSTEM_PRESETS[Number(key)] || {}).text) || "").trim();
      b.classList.toggle("on", on);
    });
  }

  // 모델 카드: 이 정보만으로 해당 LLM과 대화 가능한 수준의 상세(endpoint·timeout·상태)
  async function fetchLlmModels() {
    try {
      state.llmModels = await api("api/llm/models");
    } catch (e) {
      state.llmModels = { reachable: false, models: [] };
    }
    renderModelCards();
  }

  // 모델이 제공하는 추가 설정(요청 payload 옵션)을 카드에 표시 — 없으면 그렇게 명시
  function modelOptsHtml(mid) {
    const o = (state.modelOptions || {})[mid] || {};
    const parts = Object.keys(o).map((k) => {
      const spec = normSpec(o[k]);
      if (!spec) return "";
      const desc = spec.kind === "range" ? spec.min + "~" + spec.max : spec.values.join(", ");
      const dflt = spec.default === undefined || spec.default === null ? "" : " default " + spec.default;
      return '<span class="pchip">' + esc(k) + " " + esc(desc) + esc(dflt) + "</span>";
    }).filter(Boolean);
    return '<div class="mopts">' +
      (parts.length ? parts.join(" ") : '<span class="cmeta">no extra options</span>') + "</div>";
  }

  function renderModelCards() {
    const box = document.getElementById("chat-models");
    if (!box) return;
    const data = state.llmModels;
    if (!data) { box.innerHTML = ""; return; }
    const list = data.models || [];
    // 상태 조회가 실패해도 설정(llm.json)의 모델 목록은 그대로 보여준다.
    // 게이트웨이는 모델 목록 API가 없는 것이 정상이므로 조회 실패가 곧 오류는 아니다.
    if (!list.length) {
      box.innerHTML = '<div class="empty">' +
        (data.reachable ? "No models" : "LLM not reachable " + esc(data.error || "")) + "</div>";
      return;
    }
    const notice = data.reachable ? "" :
      '<div class="cmeta mnotice" title="' + esc(data.error || "") +
      '">From config (status API not available)</div>';
    const selected = $("#model").value;
    box.innerHTML = notice + list.map((m) => {
      const dotCls = m.health === "ok" ? "ok" : (m.health === "auth" || (m.err && !m.ok) ? "err" : "");
      const badge = (m.backend || "") + (m.tier ? " " + m.tier : "");
      // 상태 값이 없는 항목(설정만으로 만든 카드)은 그 줄을 아예 만들지 않는다 — 0 ok / 0 err는 오해를 준다
      const runline = [
        m.max_inflight ? "max " + m.max_inflight : "",
        m.ewma_latency_ms ? "avg " + (m.ewma_latency_ms / 1000).toFixed(1) + "s" : "",
      ].filter(Boolean).join(" ");
      const callline = (m.ok === null || m.ok === undefined) && (m.err === null || m.err === undefined)
        ? "" : "calls " + (m.ok || 0) + " ok / " + (m.err || 0) + " err";
      return '<div class="mcard' + (m.id === selected ? " sel" : "") + '" data-mid="' + esc(m.id) +
        '" title="' + esc(m.note || "") + '">' +
        '<span class="mname"><span class="dot ' + dotCls + '"></span>' + esc(m.id) +
        (badge ? ' <span class="mbadge">' + esc(badge) + "</span>" : "") +
        '<button class="mdetail" type="button" title="View raw JSON">detail</button></span>' +
        '<div class="mendp">' + esc(m.endpoint || "") + "</div>" +
        "<div>timeout " + (m.timeout || "-") + "s" + (runline ? " " + runline : "") + "</div>" +
        (callline || m.enabled === false
          ? "<div>" + callline + (m.enabled === false ? " <b>disabled</b>" : "") + "</div>" : "") +
        modelOptsHtml(m.id) +
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
    openHtmlModal("접목 가이드 이 repo를 다른 LLM 백엔드에 연결하기",
      '<div class="hint">이 서비스의 LLM 접점은 <code>llm.py</code> 하나입니다. 기본값은 OpenAI 호환 ' +
      "endpoint(<code>base_url + /{model}/v1/chat/completions</code> 또는 <code>url</code> 직접 지정)이며, " +
      "설정은 0번 설정 탭 또는 <code>config/llm.json</code>(경로는 ⚙ 참고, PERSIST 영역)에서 관리합니다. " +
      '전체 내용은 repo의 <code>INTEGRATION.md</code>에도 있습니다.</div>' +
      '<div class="rsec"><h3>구동 방법</h3>' +
      '<div class="hint">의존성이 없습니다 (Python 표준 라이브러리만 사용). 프론트엔드도 빌드가 없어 ' +
      "<code>web/</code> 파일을 고치고 새로고침하면 반영됩니다.</div>" +
      '<pre class="raw">' + esc("python server.py --host 127.0.0.1 --port 8821\n" +
        "# 외부 접근: --host 0.0.0.0 (프록시 뒤에 둘 때는 stripPrefix 방식)\n" +
        "# 컨테이너: docker compose up -d --build (PERSIST 볼륨 DEPLOY.md)") + "</pre>" +
      '<div class="hint">기동 후 <b>0번 설정 탭</b>에서 <code>base_url</code>을 LLM 서버 위치로 맞추면 됩니다 ' +
      "상단 상태 표시줄이 연결됨으로 바뀌는지로 확인합니다.</div></div>" +
      '<div class="rsec"><h3>스키마 형식 (데이터셋 정의)</h3>' +
      '<div class="hint">변환 목표 데이터셋 마스터가 모두 같은 형식을 씁니다. ' +
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
      row("id", "<b>JSON 연산의 key</b> 레코드 행의 필드명. 스키마 전체에서 유일해야 합니다") +
      row("group", "표 헤더에서 열을 묶는 이름 (병합 셀). 데이터 구조에는 영향 없음") +
      row("label", "표시명 (사람이 보는 이름). key로 쓰지 않습니다") +
      row("type", "값 타입 저장되는 모든 값은 string입니다") +
      row("description / description_detail", "필드의 의미와 상세 규칙. LLM 변환 판단의 근거") +
      row("mapping_logic_ip_eval_esd / _chatbot", "원본의 어느 열에서 어떻게 가져올지에 대한 지침") +
      row("enum", "선택 허용 코드 목록. 있으면 행 편집 시트 반영 시 코드 검증이 걸립니다") +
      '</tbody></table></div><div class="hint">채울 수 없는 항목은 <code>""</code>로 비워 둡니다. ' +
      "표 헤더는 group(병합) → description → id → type → label 순서로 그려집니다. " +
      "구형 <code>properties</code> 스키마는 읽을 때 자동으로 이 형식으로 변환됩니다.</div></div>" +
      '<div class="rsec"><h3>대표 파일</h3><div class="tblwrap"><table><tbody>' +
      row("server.py", "백엔드 HTTP 서버 전체 API 잡 큐 저장. 저장 경로 상수가 상단에 있습니다") +
      row("llm.py", "<b>LLM 접점 전부</b> endpoint 조립 헤더 요청/파싱 설정. 접목 시 여기만 고칩니다") +
      row("web/index.html", "프론트 탭 패널 구조와 요소 id") +
      row("web/app.js", "프론트 모든 화면 로직 (변환 데이터셋 마스터 대화 라우팅)") +
      row("web/styles.css", "프론트 테마 변수(light/dark)와 전체 스타일") +
      row("web/sheet.html", "프론트 Luckysheet 격리 iframe (표 편집)") +
      row("config/llm.json.example", "설정 키 예시 복사해 llm.json으로 사용 (실제 파일은 커밋 금지)") +
      row("prompts/table_to_schema.md", "변환 시스템 프롬프트 <code>{{TARGET_SCHEMA}}</code> 치환") +
      "</tbody></table></div></div>" +
      '<div class="rsec"><h3>경로 설정 ① LLM endpoint (0번 설정 탭)</h3>' +
      '<div class="hint">설정 JSON을 고치고 저장하면 다음 요청부터 적용됩니다 (재기동 불필요). ' +
      "모델별 경로 규칙을 쓰는 서버는 <code>base_url</code>만, 규칙이 다른 게이트웨이는 " +
      "<code>url</code>에 <b>전체 endpoint</b>를 넣습니다 (이 값이 있으면 base_url 조립은 무시). " +
      "실제로 나가는 URL은 대화 변환 이력의 <b>요청 전문</b>에서 확인합니다.</div></div>" +
      '<div class="rsec"><h3>경로 설정 ② 저장 경로 (환경변수)</h3><div class="tblwrap"><table><tbody>' +
      row("LLM_DATA_PERSIST", "데이터셋 대화 마스터 프로젝트 로그 사용자 설정/프롬프트 (<b>유지 필요</b>)") +
      row("LLM_DATA_RUNTIME", "변환 작업 이력 (<b>유실 허용</b>)") +
      row("LLM_DATA_CONFIG", "설정 파일 경로 개별 지정 (PERSIST보다 우선)") +
      '</tbody></table></div><pre class="raw">' +
      esc("LLM_DATA_PERSIST=/data LLM_DATA_RUNTIME=/runtime python server.py --host 0.0.0.0 --port 8821") +
      '</pre><div class="hint">미설정 시 모두 <code>&lt;repo&gt;/data</code>를 씁니다. ' +
      "현재 적용된 실제 경로는 헤더 ⚙(저장 영역)에서 확인하세요.</div></div>" +
      '<div class="rsec"><h3>설정 구조 모델마다 url header body etc 한 벌</h3>' +
      '<div class="hint">최상위 키 이름이 곧 <b>모델 이름</b>이고, 그 안에 그 모델의 ' +
      "<code>url</code> <code>header</code> <code>body</code> <code>etc</code>가 온전히 들어갑니다. " +
      "모델 목록은 이 최상위 키들에서 잡힙니다. 요청을 결정하는 것은 <code>url</code> " +
      "<code>header</code> <code>body</code> 3개이고, 여기 적은 것이 그대로 나갑니다. " +
      "<code>etc</code>는 예외로 두는 자유 영역이며 <b>요청에 실리지 않습니다</b>." +
      "</div><div class=\"tblwrap\"><table><tbody>" +
      row("url", "이 모델의 전체 endpoint") +
      row("header", "실제 요청 헤더. 이름과 값 모두 적은 그대로 전송 (대소문자 보존), 값은 문자열") +
      row("body", "요청 본문 항목. <code>model</code>도 여기 둡니다") +
      row("etc", "설명 등 자유 기재. 전송되지 않습니다. <code>timeout</code> <code>probe_timeout</code> " +
        "<code>response_schema</code>를 넣으면 그 모델에 그 값으로 동작합니다") +
      "</tbody></table></div></div>" +
      '<div class="rsec"><h3>header</h3>' +
      '<div class="hint">값에 쓰는 <code>{uuid}</code> <code>{uuid_hex}</code> ' +
      "<code>{ts}</code>는 요청마다 치환됩니다. 자격 정보가 담긴 헤더는 요청 전문에서 <code>****</code>로 " +
      "마스킹됩니다.</div></div>" +
      '<div class="rsec"><h3>disabled 적어두되 보내지 않는 블록</h3>' +
      '<div class="hint"><code>header</code>와 <code>body</code> 맨 아래의 <code>disabled</code> 블록은 ' +
      "<b>적어만 두고 전송하지 않습니다</b>. 켜려면 그 줄을 <code>disabled</code> 밖으로 옮기고, " +
      "끄려면 도로 넣습니다. JSON에는 주석이 없고 설정 탭에서 저장하면 파일이 통째로 다시 기록되므로, " +
      "꺼둔 항목을 주석이 아니라 데이터로 남깁니다.</div><div class=\"tblwrap\"><table><tbody>" +
      row("header.disabled", "선택 헤더 <code>Chat-Id</code> <code>Prompt-Msg-Id</code> <code>Completion-Msg-Id</code>") +
      row("body.disabled", "설정이 관여하지 않는 본문 항목 <code>messages</code> <code>messages.role</code> " +
        "<code>messages.content</code> (대화 내용은 서비스가 만들어 넣습니다)") +
      "</tbody></table></div></div>" +
      '<div class="rsec"><h3>body 값의 형태가 곧 동작</h3><div class="tblwrap"><table><tbody>' +
      row("스칼라", "매 요청 그대로 전송 <code>\"model\": \"gpt-oss-120b\"</code> " +
        "<code>\"max_tokens\": 4096</code> <code>\"stream\": false</code>") +
      row("{min, max, step}", "그 범위의 수를 화면에서 고릅니다 " +
        "<code>\"temperature\": {\"min\":0,\"max\":1,\"step\":0.1}</code>") +
      row("[\"a\", \"b\"]", "그 목록 중 하나를 고릅니다 " +
        "<code>\"reasoning_effort\": [\"low\",\"medium\",\"high\"]</code>") +
      "</tbody></table></div>" +
      '<div class="hint">선택 항목은 <b>고르지 않으면 보내지 않습니다</b> (게이트웨이 기본값 사용). ' +
      "입력 프롬프트 위의 드롭다운과 숫자 입력은 이 스펙에서 자동 생성되므로 화면 수정이 필요 없습니다. " +
      "모델을 바꾸면 그 모델의 프로필 전체(endpoint 헤더 body timeout)가 함께 바뀝니다.</div></div>" +
      '<div class="rsec"><h3>설정 예시 게이트웨이 환경</h3>' +
      '<div class="hint">모델을 늘릴 때는 같은 모양의 블록을 하나 더 붙입니다. 화면의 모델 드롭다운에 그 순서대로 나옵니다.</div>' +
      '<pre class="raw">' +
      esc('{\n' +
        '  "gpt-oss-120b": {\n' +
        '    "url": "https://apigw.example.com/llm/v1/chat/completions",\n' +
        '    "header": {\n' +
        '      "Content-Type": "application/json",\n' +
        '      "Accept": "application/json",\n' +
        '      "x-dep-ticket": "credential:TICKET-...",\n' +
        '      "Send-System-Name": "playground",\n' +
        '      "User-Type": "AD_ID",\n' +
        '      "User-Id": "your.loginid",\n' +
        '      "disabled": {\n' +
        '        "Chat-Id": "{uuid}",\n' +
        '        "Prompt-Msg-Id": "{uuid}",\n' +
        '        "Completion-Msg-Id": "{uuid}"\n' +
        '      }\n' +
        '    },\n' +
        '    "body": {\n' +
        '      "model": "gpt-oss-120b",\n' +
        '      "max_tokens": 4096,\n' +
        '      "stream": false,\n' +
        '      "temperature": { "min": 0, "max": 1, "step": 0.1 },\n' +
        '      "reasoning_effort": ["low", "medium", "high"],\n' +
        '      "disabled": {\n' +
        '        "messages": "대화 내용은 서비스가 만들어 넣는다",\n' +
        '        "messages.role": "user | assistant | system",\n' +
        '        "messages.content": "메시지 본문"\n' +
        '      }\n' +
        '    },\n' +
        '    "etc": { "설명": "etc는 요청에 실리지 않습니다", "timeout": 900 }\n' +
        '  }\n' +
        '}') + "</pre></div>" +
      '<div class="rsec"><h3>그 외 과거 키</h3><div class="tblwrap"><table><tbody>' +
      row("base_url", "모델별 URL 경로를 쓰는 서버용 루트 <code>{base_url}/{model}/v1/chat/completions</code>") +
      row("api_base_url", "게이트웨이 루트. <code>/v1</code>로 끝나면 <code>/chat/completions</code>만 붙입니다") +
      row("headers / extra_payload", "각각 <code>header</code> <code>body</code>의 옛 이름. 계속 읽습니다") +
      row("credential_key / send_system_name / user_id", "값만 채우면 <code>x-dep-ticket</code> " +
        "<code>Send-System-Name</code> <code>User-Id</code> 헤더로 전송됩니다") +
      row("OPENAI_API_KEY", "표준 Bearer token 기본 구현이 그대로 사용") +
      "</tbody></table></div>" +
      '<div class="hint">토큰 발급형 게이트웨이(<code>user_id</code> <code>user_pw</code>로 먼저 토큰을 받는 형태)만 ' +
      "<code>llm.py</code>의 <code>_headers()</code>에 발급 호출을 넣으면 됩니다. 그 외에는 설정만으로 접목됩니다. " +
      "요청 응답 전문(마스킹된 headers 포함)은 변환 작업 이력과 대화 탭에서 항상 확인할 수 있어 " +
      "접목 디버깅에 그대로 활용됩니다.</div></div>");
  });

  // 저장 영역 안내 (헤더 ⚙): LOGIC / PERSIST / RUNTIME 구분과 설정 파일 경로
  document.getElementById("storage-btn").addEventListener("click", async () => {
    try {
      const s = await api("api/storage");
      const html = '<div class="hint">PERSIST 영역은 배포 환경의 영구 저장소(volume 마운트)에 두어야 하며, ' +
        "RUNTIME 영역은 재기동 시 유실되어도 무방합니다. 자세한 절차는 DEPLOY.md 참고.</div>" +
        (s.warning ? '<div class="rsec"><div class="warnbox">⚠ ' + esc(s.warning) + "</div></div>" : "") +
        s.areas.map((a) =>
          '<div class="rsec"><h3>' + esc(a.label) + "</h3>" +
          '<div class="reqline"><code>' + esc(a.root) + "</code>" +
          (a.env ? " env <b>" + esc(a.env) + "</b> " +
            (a.env_active ? '<span class="chip ok">적용됨</span>' : '<span class="chip err">미설정 코드 디렉터리 아래 기본 경로</span>') : "") +
          "</div><div class=\"tblwrap\"><table><tbody>" +
          a.entries.map((en) => "<tr><td>" + esc(en.name) +
            '</td><td class="logdetail"><code>' + esc(en.path) + "</code>" +
            (en.note ? ' <span class="cmeta"> ' + esc(en.note) + "</span>" : "") + "</td></tr>").join("") +
          "</tbody></table></div></div>").join("");
      openHtmlModal("저장 영역 설정 파일", html);
    } catch (e) { toast("저장 영역 정보 로드 실패: " + e.message); }
  });

  document.getElementById("chat-models").addEventListener("click", (e) => {
    const card = e.target.closest("[data-mid]");
    if (!card) return;
    const mid = card.getAttribute("data-mid");
    if (e.target.closest(".mdetail")) {
      const m = ((state.llmModels || {}).models || []).find((x) => x.id === mid);
      // 상세 JSON에도 이 모델이 지원하는 추가 설정(temperature·reasoning_effort)을 함께 싣는다
      if (m) openInfoModal("Model detail " + mid, Object.assign({}, m, { options: modelOptsFor(mid) }));
      return;
    }
    $("#model").value = mid;
    renderModelCards();
    toast("Model: " + mid);
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
      markSystemChips();
      renderChatList();
      renderChatMessages();
    }
  }

  const ICON_PIN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>';
  const ICON_FOLDER = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>';

  // 프로젝트는 기본 접힘. 현재 활성 대화가 속한 프로젝트(또는 보고 있는 프로젝트 홈)만 펼친다.
  // 사용자가 직접 토글한 프로젝트는 그 선택을 유지한다.
  function activeProjectId() {
    const c = (state.chats || []).find((x) => x.id === state.chatId);
    return (c && c.project) || null;
  }
  function isProjectOpen(pid) {
    const t = (state.openProjects || {})[pid];
    if (t !== undefined) return t;
    return pid === activeProjectId() || pid === state.viewProject;
  }

  function renderChatList() {
    const box = $("#chat-list-items");
    const chats = state.chats || [];
    if (!chats.length) {
      box.innerHTML = '<div class="empty">No chats yet.</div>';
      return;
    }
    const limit = state.contextLimit || 200000;
    const projects = state.projects || {};
    const itemHtml = (c) => {
      const tok = c.cum_tokens
        ? '<span class="cmeta">total ' + fmtNum(c.cum_tokens) + " " +
          fmtNum(c.ctx_tokens) + "/" + fmtNum(limit) + " (" +
          (c.ctx_tokens * 100 / limit).toFixed(1) + "%)</span>"
        : "";
      const btns = '<span class="citembtns">' +
        '<button class="iconbtn crename" data-cid="' + esc(c.id) + '" type="button" title="Rename chat">' + ICON_EDIT + "</button>" +
        '<button class="iconbtn cpin' + (c.pinned ? " on" : "") + '" data-cid="' + esc(c.id) +
        '" type="button" title="' + (c.pinned ? "Unpin" : "Pin to top") + '">' + ICON_PIN + "</button>" +
        '<button class="iconbtn cmove" data-cid="' + esc(c.id) + '" type="button" title="Move to project">' + ICON_FOLDER + "</button></span>";
      // 고정된 대화는 원래 그룹(프로젝트)에서 분리돼 상단에 뜨므로 소속을 작게 병기한다
      const projTag = c.pinned && c.project && projects[c.project]
        ? '<span class="cproj" title="Project">' + ICON_FOLDER + " " + esc(projects[c.project].name) + "</span>"
        : "";
      return '<div class="chatitem' + (c.id === state.chatId ? " sel" : "") + '" data-chat="' + esc(c.id) + '">' +
        '<span class="ctitle">' + (c.pinned ? '<span class="pinmark">' + ICON_PIN + "</span>" : "") +
        (c.model ? '<span class="mbadge">' + esc(c.model) + "</span> " : "") +
        (c.pending ? '<span class="spin"></span> ' : "") + esc(c.title) + "</span>" + btns + projTag +
        '<span class="cmeta">' + Math.floor(c.count / 2) + "turns " +
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
    if (pinned.length) html += '<div class="lsec">' + ICON_PIN + " pinned</div>" + pinned.map(itemHtml).join("");
    projOrder.forEach((pid) => {
      const upCount = allByProject[pid].length - byProject[pid].length; // 고정 섹션으로 올라간 수
      const open = isProjectOpen(pid);
      html += '<div class="lsec proj' + (state.viewProject === pid ? " cur" : "") + '">' +
        '<button class="pcaret" data-ptoggle="' + esc(pid) + '" type="button" title="' +
        (open ? "collapse" : "expand") + '">' + (open ? "▾" : "▸") + "</button>" +
        '<span class="pname" data-phome="' + esc(pid) + '" title="Open project home">' +
        ICON_FOLDER + " " + esc(projects[pid].name) +
        ' <span class="pcount">' + allByProject[pid].length +
        (upCount ? " <span class=\"pup\" title=\"Pinned to top\">↑" + upCount + "</span>" : "") + "</span></span>" +
        '<button class="iconbtn prename" data-pid="' + esc(pid) + '" type="button" title="Rename project">' + ICON_EDIT + "</button>" +
        '<button class="iconbtn pdel" data-pid="' + esc(pid) + '" type="button" title="Delete project (chats move to top level)">✕</button>' +
        '<span class="cmeta">' + esc(projTs(pid).slice(5, 16).replace("T", " ")) + "</span></div>" +
        (!open ? "" : (byProject[pid].length
          ? byProject[pid].map(itemHtml).join("")
          : '<div class="empty pempty">' +
            (upCount ? "All chats in this project are pinned"
              : "Move a chat here with the folder icon on the chat row") + "</div>"));
    });
    if (rest.length) {
      if (pinned.length || projOrder.length) html += '<div class="lsec">Chats</div>';
      html += rest.map(itemHtml).join("");
    }
    box.innerHTML = html;
    updateProjectRail();
  }

  // ---- 프로젝트 홈: 프로젝트에 속한 대화를 한눈에 보고 새 대화를 시작하는 화면 ----
  function openProjectHome(pid) {
    if (!(state.projects || {})[pid]) return;
    setSidebar(false);
    state.viewProject = pid;
    if (state.openProjects) delete state.openProjects[pid]; // 기본(열림)으로 되돌린다
    renderChatList();
    renderProjectHome();
    pushRoute();
  }

  function closeProjectHome() {
    if (!state.viewProject) return;
    state.viewProject = null;
    $("#project-home").hidden = true;
    document.querySelector(".chatmain").classList.remove("projmode");
    renderChatList();
    pushRoute();
  }

  function renderProjectHome() {
    const pid = state.viewProject;
    const box = $("#project-home");
    const main = document.querySelector(".chatmain");
    const p = (state.projects || {})[pid];
    if (!pid || !p) { box.hidden = true; main.classList.remove("projmode"); return; }
    box.hidden = false;
    main.classList.add("projmode"); // 대화 영역·입력창·전문 섹션을 숨긴다
    const items = (state.chats || []).filter((c) => c.project === pid)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const turns = items.reduce((n, c) => n + Math.floor((c.count || 0) / 2), 0);
    const tok = items.reduce((n, c) => n + (c.cum_tokens || 0), 0);
    const last = items.length ? String(items[0].updated_at || "").slice(0, 16).replace("T", " ") : " ";
    box.innerHTML =
      '<div class="phome">' +
      '<div class="phhead">' + ICON_FOLDER +
      '<h3 class="phname">' + esc(p.name) + "</h3>" +
      '<button class="iconbtn prename" data-pid="' + esc(pid) + '" type="button" title="Rename project">' + ICON_EDIT + "</button>" +
      '<span class="phspacer"></span>' +
      '<button id="ph-new" class="insertbtn" type="button">＋ New chat in this project</button>' +
      '<button id="ph-close" class="small" type="button">Close</button></div>' +
      '<div class="phmeta">' + items.length + " chats, " + turns + "turns " +
      fmtNum(tok) + " tok, last activity " + esc(last) +
      (p.created_at ? " created " + esc(String(p.created_at).slice(0, 16).replace("T", " ")) : "") + "</div>" +
      (items.length
        ? '<div class="phlist">' + items.map((c) =>
          '<div class="phitem" data-chat="' + esc(c.id) + '">' +
          '<span class="phtitle">' + (c.pinned ? '<span class="pinmark">' + ICON_PIN + "</span>" : "") +
          (c.model ? '<span class="mbadge">' + esc(c.model) + "</span> " : "") + esc(c.title) + "</span>" +
          '<span class="cmeta">' + Math.floor((c.count || 0) / 2) + "turns " +
          esc(String(c.updated_at || "").slice(0, 16).replace("T", " ")) +
          (c.cum_tokens ? " " + fmtNum(c.cum_tokens) + " tok" : "") + "</span>" +
          '<button class="iconbtn phout" data-cid="' + esc(c.id) + '" type="button" title="Remove from project">✕</button>' +
          "</div>").join("") + "</div>"
        : '<div class="empty">No chats yet. Use the button above to start one in this project.</div>') +
      "</div>";
  }

  $("#project-home").addEventListener("click", async (e) => {
    if (e.target.closest("#ph-close")) { closeProjectHome(); return; }
    const rn = e.target.closest(".prename");
    if (rn) {
      const pid = rn.getAttribute("data-pid");
      const cur = ((state.projects || {})[pid] || {}).name || "";
      const next = window.prompt("Rename this project", cur);
      if (next == null || !next.trim() || next.trim() === cur) return;
      try {
        await apiPost("api/project/rename", { id: pid, name: next.trim() });
        await refreshChats();
        renderProjectHome();
        toast("Project renamed");
      } catch (err) { toast("Rename failed: " + err.message); }
      return;
    }
    if (e.target.closest("#ph-new")) {
      // 이 프로젝트 소속으로 시작할 새 대화 — 첫 전송 후 자동으로 프로젝트에 넣는다
      state.pendingProject = state.viewProject;
      closeProjectHome();
      state.chatId = null;
      state.chatDoc = null;
      $("#chat-system").value = DEFAULT_CHAT_SYSTEM;
      markSystemChips();
      renderChatList();
      renderChatMessages();
      $("#chat-input").focus();
      toast("New chat, saved to this project on first message");
      return;
    }
    const out = e.target.closest(".phout");
    if (out) {
      try {
        await apiPost("api/chat/meta", { id: out.getAttribute("data-cid"), project: "" });
        await refreshChats();
        renderProjectHome();
        toast("Removed from project");
      } catch (err) { toast("Remove failed: " + err.message); }
      return;
    }
    const it = e.target.closest("[data-chat]");
    if (it) {
      closeProjectHome();
      loadChatDoc(it.getAttribute("data-chat"));
    }
  });

  async function loadChatDoc(id) {
    try {
      state.chatDoc = await api("api/chat?id=" + encodeURIComponent(id));
      if (state.chatId !== id) {
        state.editingIdx = null;
        state.ctxEditIdx = null;
        state.expandedMsgs = {}; // 대화가 바뀌면 펼침 상태 초기화 (인덱스 의미가 달라짐)
        state.userScrolled = false; // 다른 대화를 열면 맨 아래(최신)부터 본다
      }
      state.chatId = id;
      $("#chat-system").value = state.chatDoc.system != null && state.chatDoc.system !== ""
        ? state.chatDoc.system : DEFAULT_CHAT_SYSTEM;
      markSystemChips();
      renderChatList();
      renderChatMessages();
      const mini = document.getElementById("chat-title-mini");
      if (mini) mini.textContent = state.chatDoc.title || "";
      restorePending(state.chatDoc); // 서버에 진행 중인 전송이 있으면 질문·타이머 복원 + 폴링
      pushRoute(); // 같은 대화 재로드면 hash 불변(no-op), 대화 이동이면 history entry 추가
    } catch (e) { toast("Failed to load chats: " + e.message); }
  }

  // 새로고침·재접속해도 진행 중 전송을 복원: 서버 _CHAT_PENDING 기반 렌더링 + 완료 폴링
  // 대기 중인 한 턴의 마크업. 완료 상태(질문 줄 + 답변 줄)와 같은 구조라
  // 답변이 도착해도 자리가 움직이지 않는다.
  function pendingTurnHtml(msg, startMs, editIndex) {
    const label = (editIndex != null ? "#" + editIndex + " edit resend " : "") + "waiting for response ";
    return '<div class="msgwrap user" id="chat-just-sent"><div class="msg user">' +
      esc(msg) + "</div></div>" +
      '<div class="msgwrap assistant" id="chat-pending-wrap">' +
      '<div class="msg assistant pending" id="chat-pending"><span class="spin"></span> ' +
      label + timerHtml(startMs) + "</div></div>";
  }

  // 대기 표시 제거 — 질문 줄과 답변 자리 두 개를 함께 걷어낸다
  function removePendingTurn() {
    ["chat-just-sent", "chat-pending-wrap"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  function restorePending(doc) {
    clearTimeout(state.pendingPollTimer);
    if (!doc || !doc.pending || !state.chatId) {
      // 이 대화의 전송이 끝났으면 상태도 함께 해제 (서버가 단일 진실 원천)
      if (getTx(state.chatId) && !(doc && doc.pending)) setTx(null, state.chatId);
      return;
    }
    const p = doc.pending;
    // 서버가 알려준 in-flight 전송을 그대로 상태로 복원 — 새로고침·재접속에도 정지 버튼 유지
    setTx({ kind: p.edit_index != null ? "edit" : "send", chatId: state.chatId,
            editIndex: p.edit_index, startedMs: Date.parse(p.ts) || Date.now(),
            token: p.token || "" }, state.chatId);
    const box = $("#chat-messages");
    if (!document.getElementById("chat-pending")) {
      if (box.querySelector(".empty")) box.innerHTML = "";
      const row = () => pendingTurnHtml(p.message, Date.parse(p.ts) || Date.now(), p.edit_index);
      if (p.edit_index != null) {
        // 수정 재전송은 그 대화 위치에서 진행 중이므로 대기 표시도 그 자리에 둔다.
        // 수정 대상부터 뒤쪽 메시지는 곧 새 분기로 교체되므로 흐리게 표시한다.
        const target = box.children[p.edit_index];
        const doomed = [];
        for (let i = p.edit_index; i < box.children.length; i++) doomed.push(box.children[i]);
        if (target) target.insertAdjacentHTML("beforebegin", row());
        else box.insertAdjacentHTML("beforeend", row());
        doomed.forEach((el) => el.classList.add("superseded"));
      } else {
        box.insertAdjacentHTML("beforeend", row());
      }
      scrollMsgIntoTop(document.getElementById("chat-just-sent"));
    }
    const cid = state.chatId;
    state.pendingPollTimer = setTimeout(() => {
      if (state.chatId === cid) loadChatDoc(cid); // pending 유지 시 재귀 폴링, 완료 시 응답 렌더
    }, 2500);
  }

  // ---- assistant 메시지 markdown 렌더링 (모든 조각을 esc() 후 변환 — XSS 안전) ----
  // 수식 구간 정규식 — 순서 중요: $$ → \[ → \( → $.
  // 예전 패턴은 \(f(x)\)처럼 안쪽에 괄호가 있으면 매칭에 실패해 수식이 깨졌다.
  const MATH_RE = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?:\\.|[^$\\\n])+\$/g;

  function unesc(t) {
    return String(t).replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }

  // 마스킹한 수식을 KaTeX HTML로 직접 변환한다. auto-render는 markdown 변환으로 텍스트
  // 노드가 쪼개지면 구분자를 찾지 못해 문장 중간 수식을 놓치므로 여기서 확정적으로 렌더한다.
  function renderMathSegment(raw) {
    let tex = null, display = false;
    if (/^\$\$[\s\S]*\$\$$/.test(raw)) { tex = raw.slice(2, -2); display = true; }
    else if (/^\\\[[\s\S]*\\\]$/.test(raw)) { tex = raw.slice(2, -2); display = true; }
    else if (/^\\\([\s\S]*\\\)$/.test(raw)) { tex = raw.slice(2, -2); }
    else if (/^\$[\s\S]*\$$/.test(raw)) { tex = raw.slice(1, -1); }
    if (tex === null || !tex.trim() || !window.katex) return raw;
    try {
      return window.katex.renderToString(unesc(tex), { displayMode: display, throwOnError: false });
    } catch (e) {
      return raw; // 렌더 실패 시 원문 유지 — auto-render가 한 번 더 시도한다
    }
  }

  function mdInline(s) {
    // s는 이미 esc()된 문자열. 수식 구간은 마스킹해 *·_ 등이 markdown으로 오변환되지 않게 보호
    // 인라인 코드를 먼저 마스킹한다 — `$notmath$`처럼 코드 안의 $는 수식이 아니다
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return "" + (codes.length - 1) + "";
    });
    const masks = [];
    s = s.replace(MATH_RE, (m) => {
      masks.push(m);
      return "" + (masks.length - 1) + "";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(\d+)/g, (_, n) => renderMathSegment(masks[Number(n)]));
    s = s.replace(/(\d+)/g, (_, n) => "<code>" + codes[Number(n)] + "</code>");
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
          indent: lm[1].replace(/\t/g, " ").length,
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
          '</span><button class="copycode iconbtn" type="button" title="Copy code">' + ICON_COPY + "</button></div>" +
          '<pre><code class="' + (lang ? "language-" + esc(lang) : "") + '">' + esc(code) + "</code></pre></div>";
      }
    }
    return html;
  }

  // 분기 트리용 시각 표기: yyyy.mm.dd HH:MM:SS (초까지, 폭을 줄이려고 구분자는 점)
  function treeTs(ts) {
    if (!ts) return "";
    const t = String(ts).slice(0, 19).replace("T", " ");
    return t.slice(0, 10).replace(/-/g, ".") + t.slice(10);
  }

  function msgTs(ts) {
    return ts ? String(ts).slice(0, 16).replace("T", " ") : ""; // "YYYY-MM-DD HH:MM"
  }

  // 프로그램이 옮긴 스크롤은 "사용자가 스크롤했다"로 오인하지 않도록 표시해 둔다
  function markProgScroll() { state.progScrollUntil = Date.now() + 400; }

  function scrollMsgIntoTop(el) {
    const box = $("#chat-messages");
    markProgScroll();
    if (!el) { box.scrollTop = box.scrollHeight; return; }
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 4;
  }

  // 사용자가 위로 스크롤해 다른 부분을 보고 있으면 자동 스크롤을 멈춘다(scroll anchoring).
  // 맨 아래로 돌아오면 다시 따라가기(follow) 모드로 복귀한다.
  $("#chat-messages").addEventListener("scroll", () => {
    updateJumpButtons();
    if (Date.now() < (state.progScrollUntil || 0)) return; // 프로그램 스크롤은 무시
    const box = $("#chat-messages");
    state.userScrolled = box.scrollHeight - box.scrollTop - box.clientHeight > 24;
  }, { passive: true });

  // 스크롤 점프 버튼 — 스크롤할 여지가 있을 때만 반투명으로 겹쳐 보인다
  function updateJumpButtons() {
    const box = $("#chat-messages");
    const jump = document.getElementById("chat-jump");
    if (!jump) return;
    const scrollable = box.scrollHeight - box.clientHeight > 40;
    jump.hidden = !scrollable;
    if (!scrollable) return;
    // 대화창 아랫변에서 살짝 띄운다 — 입력창·경계에 걸쳐 잘리지 않도록 실측으로 맞춘다
    const main = jump.offsetParent;
    if (main) {
      const gap = main.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom;
      jump.style.bottom = Math.round(gap + 14) + "px";
    }
    const atTop = box.scrollTop <= 4;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 4;
    jump.querySelector('[data-jump="top"]').disabled = atTop;
    jump.querySelector('[data-jump="bottom"]').disabled = atBottom;
  }

  document.getElementById("chat-jump").addEventListener("click", (e) => {
    const b = e.target.closest("[data-jump]");
    if (!b) return;
    const box = $("#chat-messages");
    markProgScroll();
    if (b.getAttribute("data-jump") === "top") {
      box.scrollTop = 0;
      state.userScrolled = true;  // 위를 보고 있으므로 자동 스크롤 중단
    } else {
      box.scrollTop = box.scrollHeight;
      state.userScrolled = false; // 맨 아래 = 따라가기 모드 복귀
    }
    updateJumpButtons();
  });

  // ChatGPT 차용 아이콘 (복사·수정)
  const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>';

  // ---- 모델 추가 설정(extra payload): temperature · reasoning_effort ----
  // 모델이 지원하는 값 목록이 있을 때만 활성화되고, 선택 시 요청 payload에 실린다.
  function modelOptsFor(model) {
    const o = (state.modelOptions || {})[model] || {};
    return { temperature: o.temperature || [], reasoning_effort: o.reasoning_effort || [] };
  }

  // 옵션 바 정의 — 대화 입력창과 과거 대화 수정 상자가 같은 스펙을 공유한다(패턴화).
  // 레이블은 컨트롤 밖에 항상 표시하고, 드롭다운 안에는 유효한 값만 둔다.
  // 값을 고른 뒤에도 무엇을 고른 것인지 알 수 있어야 하기 때문(model은 값 자체가 자명해 레이블 생략).
  // 알려진 body 항목의 짧은 레이블·설명. 목록에 없는 항목은 키 이름을 그대로 쓴다.
  const OPT_LABELS = {
    temperature: { label: "temp", title: "temperature lower is more deterministic, higher is more varied" },
    reasoning_effort: { label: "reasoning", title: "reasoning effort how much reasoning to spend" },
    max_tokens: { label: "max tok", title: "max tokens to generate" },
    top_p: { label: "top_p", title: "nucleus sampling, top p of probability mass" },
  };

  // 옵션 바 구성은 설정(config의 body)에서 내려온 선택 항목으로 만든다.
  // 모델 선택 + 선택 가능한 body 항목들 = 이 화면의 옵션 필드.
  // 선택지 목록 정규화. 값이 아닌 것(함수 등)은 걸러 화면에 새어 나오지 않게 한다.
  function asList(v) {
    const arr = Array.isArray(v) ? v
      : (v === null || v === undefined || v === "") ? []
      : (typeof v === "object") ? Object.keys(v).map((k) => v[k])
      : [v];
    return arr.filter((x) => typeof x === "string" || typeof x === "number");
  }

  // 옵션 스펙 정규화. 서버가 {kind,...}로 주는 것이 정상이지만, 옛 형태(값 배열)나
  // {values:[...]}, {min,max}만 오는 경우도 그대로 받아들인다.
  // 배열을 그대로 쓰면 spec.values가 Array.prototype.values(함수)로 잡혀
  // 드롭다운에 "function values() { [native code] }"가 찍힌다.
  function normSpec(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) {
      const vals = asList(v).map(String);
      return vals.length ? { kind: "enum", values: vals, default: vals[vals.length - 1] } : null;
    }
    if (typeof v !== "object") return null;
    if (v.kind === "range" || (v.kind === undefined && v.min !== undefined && v.max !== undefined)) {
      const lo = Number(v.min), hi = Number(v.max), st = Number(v.step || 0.1);
      if (!isFinite(lo) || !isFinite(hi)) return null;
      return { kind: "range", min: lo, max: hi, step: st > 0 ? st : 0.1,
               default: v.default !== undefined ? v.default : hi };
    }
    const vals = asList(v.values).map(String);
    if (!vals.length) return null;
    return { kind: "enum", values: vals,
             default: v.default !== undefined ? String(v.default) : vals[vals.length - 1] };
  }

  function optFields() {
    const keys = new Set();
    Object.keys(state.modelOptions || {}).forEach((m) => {
      Object.keys((state.modelOptions || {})[m] || {}).forEach((k) => keys.add(k));
    });
    const fields = [{ id: "model", param: "model", label: "", title: "Model for this request" }];
    [...keys].sort().forEach((k, i) => {
      const meta = OPT_LABELS[k] || {};
      fields.push({ id: "opt" + i, param: k, label: meta.label || k,
        title: (meta.title || k) + " (sent in the request payload)" });
    });
    return fields;
  }
  const OPT_DEFAULT_LABEL = "default"; // 파라미터를 보내지 않음 — 무효값이 아니라 유효한 선택

  function optbarHtml(prefix) {
    return optFields().map((f) =>
      '<span class="optfield" id="' + prefix + "-" + f.id + '-wrap">' +
      (f.label ? '<label class="optlabel" for="' + prefix + "-" + f.id + '">' + esc(f.label) + "</label>" : "") +
      '<span class="optslot" id="' + prefix + "-" + f.id + '-slot"></span>' +
      "</span>").join("");
  }

  // 컨트롤을 스펙에 맞게 만든다: enum -> select(유효값만), range -> number 입력(min/max/step).
  // 모델이 그 항목을 제공하지 않으면 필드 전체를 비활성 표시로 둔다.
  function wireOptbar(prefix, cur) {
    cur = cur || {};
    const el = (id) => document.getElementById(prefix + "-" + id);
    const fields = optFields();
    const mSlot = el("model-slot");
    if (!mSlot) return;
    mSlot.innerHTML = '<select id="' + prefix + '-model" class="optsel" aria-label="model"></select>';
    const mSel = el("model");
    mSel.innerHTML = (state.modelList || []).map((m) =>
      '<option value="' + esc(m) + '">' + esc(m) + "</option>").join("");
    mSel.value = cur.model || state.defaultModel || (state.modelList || [])[0] || "";
    mSel.title = fields[0].title;
    const apply = () => {
      const opts = (state.modelOptions || {})[mSel.value] || {};
      fields.slice(1).forEach((f) => {
        const slot = el(f.id + "-slot");
        const wrap = el(f.id + "-wrap");
        if (!slot) return;
        const spec = normSpec(opts[f.param]);
        const want = cur[f.param];
        if (!spec) {
          slot.innerHTML = '<select id="' + prefix + "-" + f.id + '" class="optsel" disabled>' +
            "<option>" + OPT_DEFAULT_LABEL + "</option></select>";
          const tip = mSel.value + " " + f.param + " is not available on this model";
          el(f.id).title = tip;
          if (wrap) { wrap.classList.add("off"); wrap.title = tip; }
          return;
        }
        if (wrap) { wrap.classList.remove("off"); wrap.title = f.title; }
        // 고르지 않았을 때의 값은 스펙의 default (범위는 가장 큰 값, 목록은 맨 뒤 값).
        // 화면에 그 값을 미리 채워 두어 실제 전송되는 값과 보이는 값을 일치시킨다.
        const dflt = spec.default;
        if (spec.kind === "range") {
          slot.innerHTML = '<input id="' + prefix + "-" + f.id + '" class="optnum" type="number" ' +
            'min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" ' +
            'placeholder="' + esc(String(dflt === undefined ? OPT_DEFAULT_LABEL : dflt)) + '" title="' +
            esc(f.title) + " (" + spec.min + "~" + spec.max + ')">';
          const v = (want !== undefined && want !== "") ? want : dflt;
          if (v !== undefined && v !== null) el(f.id).value = v;
        } else {
          // 설정이 어떤 모양으로 오든 화면이 죽지 않게 목록으로 맞춘다
          // (객체면 값들을, 문자열이면 그 하나를 쓴다)
          const vals = asList(spec.values);
          slot.innerHTML = '<select id="' + prefix + "-" + f.id + '" class="optsel" title="' + esc(f.title) + '">' +
            vals.map((v) => '<option value="' + esc(v) + '">' + esc(v) + "</option>").join("") + "</select>";
          const v = (want && vals.map(String).indexOf(String(want)) >= 0) ? want : dflt;
          if (v !== undefined && v !== null) el(f.id).value = String(v);
        }
      });
    };
    apply();
    mSel.addEventListener("change", apply);
  }

  function readOptbar(prefix) {
    const el = (id) => document.getElementById(prefix + "-" + id);
    const out = { model: el("model") ? el("model").value : $("#model").value };
    optFields().slice(1).forEach((f) => {
      const c = el(f.id);
      if (c && !c.disabled && String(c.value).trim() !== "") out[f.param] = String(c.value).trim();
    });
    return out;
  }

  // 헤더 높이를 항상 최신으로 유지한다. 대화 화면 높이가 이 값으로 계산되므로,
  // 헤더가 나중에 바뀌면(접근 제어의 열쇠·임시 칩이 붙거나 창 폭이 바뀌어 줄바꿈되면)
  // 값이 낡아 입력창이 화면 밖으로 밀리고 대화를 덮는 것처럼 보인다.
  function syncHeadHeight() {
    const h = document.querySelector("header");
    if (!h) return;
    const px = h.offsetHeight;
    if (px && String(px) !== String(state.headh)) {
      state.headh = px;
      document.documentElement.style.setProperty("--headh", px + "px");
      if (typeof autoGrowInput === "function") autoGrowInput();
    }
  }

  (function watchHeader() {
    const h = document.querySelector("header");
    if (!h) return;
    if (window.ResizeObserver) new ResizeObserver(syncHeadHeight).observe(h);
    window.addEventListener("resize", syncHeadHeight);
    syncHeadHeight();
  })();

  // 입력창 자동 높이 — 내용만큼 커지되 대화 영역을 침범하지 않게 상한을 둔다.
  // 상한이 없으면 긴 질문에서 입력창이 대화를 덮는다. 전송 중에도 같은 규칙이 유지된다.
  function autoGrowInput() {
    const ta = document.getElementById("chat-input");
    if (!ta) return;
    const main = ta.closest(".chatmain") || ta.parentElement;
    const room = main ? main.getBoundingClientRect().height : 0;
    // 대화 영역에 최소 180px는 남긴다. 그 안에서만 입력창이 커진다.
    const max = Math.max(88, Math.min(room ? room - 180 : 240, 320));
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight + 2, max) + "px";
    ta.style.overflowY = ta.scrollHeight + 2 > max ? "auto" : "hidden";
    syncBottomSpacer();
  }

  function resetInputHeight() {
    const ta = document.getElementById("chat-input");
    if (!ta) return;
    ta.style.height = "";
    ta.style.overflowY = "";
    syncBottomSpacer();
  }

  function initChatOptbar() {
    const sysEl = document.getElementById("chat-system");
    if (sysEl && !sysEl.dataset.chipsWired) {
      sysEl.dataset.chipsWired = "1";
      sysEl.addEventListener("input", markSystemChips);   // 직접 고치면 칩 강조도 풀린다
    }
    const bar = document.getElementById("chat-optbar");
    if (bar && !bar.querySelector("select")) bar.innerHTML = optbarHtml("chat");
    wireOptbar("chat", { model: $("#model").value || state.defaultModel });
  }

  // ChatGPT식 아이콘: 보내기(위 화살표) / 정지(사각형)
  const ICON_SEND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V5"/><path d="M5.5 11.5 12 5l6.5 6.5"/></svg>';
  const ICON_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect></svg>';

  // 전송/정지 버튼 패턴 — 대화 입력창과 과거 대화 수정 상자가 같은 마크업·상태 전환을 공유한다
  function sendBtnHtml(id, label) {
    return '<button id="' + id + '" class="iconsend" type="button" title="' + esc(label) +
      '" aria-label="' + esc(label) + '">' + ICON_SEND + "</button>";
  }

  function setSendBtnMode(btn, mode) { // mode: "send" | "stop"
    if (!btn) return;
    const stop = mode === "stop";
    btn.classList.add("iconsend");
    btn.classList.toggle("stopbtn", stop);
    btn.innerHTML = stop ? ICON_STOP : ICON_SEND;
    btn.title = stop ? "Stop the response being generated" : "Send (Ctrl+Enter)";
    btn.setAttribute("aria-label", stop ? "Stop" : "Send");
    btn.disabled = false;
  }

  // ---- 전송 상태(tx) 관리 ----------------------------------------------------
  // 단일 진실 원천은 "서버의 in-flight 전송"이다. 로컬 변수만 쓰면 새로고침에서 상태가
  // 사라지므로(정지 버튼이 보내기로 되돌아감), 서버 pending을 읽어 같은 형태로 복원한다.
  //   state.txs[chatId] = { kind: "send"|"edit", chatId, editIndex, startedMs, token }
  // 대화마다 따로 둔다 — 한 대화가 응답을 기다리는 동안 다른 대화에서 바로 보낼 수 있다.
  // 새 대화(아직 id 없음)는 "" 키를 쓰고, 서버가 id를 알려주면 그 키로 옮긴다.
  // 화면 반영은 renderTxState() 한 곳에서만 한다 — 버튼·상태문구·가드가 항상 같은 상태를 본다.
  function txKey(chatId) {
    return chatId || "";
  }

  function getTx(chatId) {
    return (state.txs || {})[txKey(chatId === undefined ? state.chatId : chatId)] || null;
  }

  function setTx(tx, chatId) {
    const key = txKey(chatId === undefined ? (tx ? tx.chatId : state.chatId) : chatId);
    state.txs = state.txs || {};
    if (tx) state.txs[key] = tx; else delete state.txs[key];
    renderTxState();
  }

  // 새 대화의 전송이 끝나 id가 생기면 그 키로 옮긴다 (정지 버튼이 계속 그 대화를 가리키도록)
  function rekeyTx(fromId, toId) {
    const a = txKey(fromId), b = txKey(toId);
    if (a === b || !state.txs || !state.txs[a]) return;
    state.txs[b] = Object.assign(state.txs[a], { chatId: toId });
    delete state.txs[a];
    renderTxState();
  }

  function txActive() {
    return !!getTx();
  }

  function renderTxState() {
    // 지금 보고 있는 대화의 전송만 이 화면에 반영한다. 다른 대화의 전송은 그대로 진행된다.
    const tx = getTx();
    const here = !!tx;
    state.sending = here;        // 기존 가드 호환 (수정·분기 전환 잠금) — 이 대화 기준
    state.sendToken = tx ? tx.token : null;
    state.sendingChatId = tx ? tx.chatId : null;
    setSendBtnMode($("#chat-send"), here ? "stop" : "send");
    // 수정 상자가 열려 있으면 그 버튼·상태 문구도 같은 상태를 따른다
    const eb = document.getElementById("edit-msg-send");
    const st = document.getElementById("edit-msg-status");
    const editing = here && tx && tx.kind === "edit";
    if (eb) setSendBtnMode(eb, editing ? "stop" : "send");
    if (st) {
      st.innerHTML = editing
        ? '<span class="spin"></span> waiting for response ' + timerHtml(tx.startedMs || Date.now())
        : "";
    }
  }

  async function cancelSend() {
    const tx = getTx();
    if (!tx) return;   // 이 대화에 진행 중인 전송이 없으면 아무것도 하지 않는다
    const btn = $("#chat-send");
    btn.disabled = true;
    try {
      const r = await apiPost("api/chat/cancel",
        { id: tx.chatId || "", token: tx.token || "" });
      toast(r.cancelled ? "Stop requested. The response will not be saved." : "Nothing is being sent");
    } catch (e) {
      toast("Stop failed: " + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // 발신자 표시 — 내가 보낸 메시지는 생략하고 상대(모델·다른 사람)만 적는다.
  // 향후 여러 사람·여러 모델이 한 대화에 참여하는 그룹 채팅을 염두에 둔 규칙:
  // 메시지에 name/user가 있으면 그 값을, 없으면 assistant는 모델명을 발신자로 쓴다.
  function senderLabel(m) {
    if (!m) return "";
    if (m.role === "user") {
      const who = m.name || m.user || "";
      return who && who !== state.user ? who : ""; // 내 메시지는 생략
    }
    return m.name || m.model || "assistant";
  }

  // 메시지 분량 — 글자 수(코드포인트 기준)와 UTF-8 바이트 용량. 보낸·받은 메시지 모두 표시
  // 큰 수를 3자리 단위(k M G T)로 압축 표기 - 가로폭을 아끼기 위해
  // ---- 크기를 색으로 (소요 시간·토큰) ------------------------------------------
  // 파랑 한 색상 램프 위를 log 스케일로 "연속" 이동한다. 단계로 끊지 않는다 —
  // 1초와 3초, 1분과 3분이 서로 다른 색으로 보여야 하기 때문이다.
  // 임계를 넘으면 상태색(빨강)으로 바꾼다. 숫자는 항상 함께 보이므로 색만으로 뜻을 전달하지 않는다.
  // 범위는 llm.json의 etc.latency_scale / etc.token_scale에서 온다.
  const RAMP_LIGHT = ["#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
  const RAMP_DARK = ["#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4"];
  // 오래 걸리는 구간: 주황 -> 빨강. 1분을 넘으면 여기로 넘어간다.
  const WARM_LIGHT = ["#c2761a", "#bb4f16", "#b42318"];
  const WARM_DARK = ["#f5a54b", "#f78a59", "#f97066"];
  const ALARM_LIGHT = "#b42318";
  const ALARM_DARK = "#f97066";

  function isDark() {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
  }

  function hex2rgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function rgb2hex(c) {
    return "#" + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
  }

  // 램프 위 위치 p(0~1)의 색. 문서화된 단계 사이를 선형 보간하므로 색상과 밝기 순서가 유지된다.
  function rampAt(p, ramp) {
    ramp = ramp || (isDark() ? RAMP_DARK : RAMP_LIGHT);
    const x = Math.max(0, Math.min(1, p)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(x));
    const t = x - i;
    const a = hex2rgb(ramp[i]), b = hex2rgb(ramp[i + 1]);
    return rgb2hex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }

  // 값 v를 [lo, hi] 구간에 log로 매핑한다. 자릿수가 다른 값들이 고르게 벌어진다.
  function logPos(v, lo, hi) {
    const x = Math.max(Number(lo) || 0.001, Number(v) || 0);
    const a = Math.log(Math.max(0.001, Number(lo) || 0.001));
    const b = Math.log(Math.max(a + 0.001, Number(hi) || 1));
    return (Math.log(x) - a) / (b - a);
  }

  function scaleCfg(name) {
    const sc = (state.scales || {})[name] || {};
    return name === "latency"
      ? { lo: sc.min_s != null ? sc.min_s : 0.5, hi: sc.max_s != null ? sc.max_s : 300,
          warm: sc.warm_s != null ? sc.warm_s : 60,
          alarm: sc.alarm_s != null ? sc.alarm_s : 300 }
      : { lo: sc.min != null ? sc.min : 100, hi: sc.max != null ? sc.max : 100000,
          alarm: sc.alarm != null ? sc.alarm : Infinity };
  }

  // 1분(warm_s)까지는 파랑이 진해지고, 그 뒤로는 주황에서 빨강으로 간다.
  // 두 구간 모두 연속이고, 넘어가는 지점만 눈에 띄게 바뀐다 — "오래 걸린다"를 알아보게.
  function latencyColor(sec) {
    const c = scaleCfg("latency");
    if (sec >= c.alarm) return isDark() ? ALARM_DARK : ALARM_LIGHT;
    if (sec >= c.warm) {
      return rampAt(logPos(sec, c.warm, c.alarm), isDark() ? WARM_DARK : WARM_LIGHT);
    }
    return rampAt(logPos(sec, c.lo, c.warm));
  }

  function tokenColor(n) {
    const c = scaleCfg("token");
    if (n >= c.alarm) return isDark() ? ALARM_DARK : ALARM_LIGHT;
    return rampAt(logPos(n, c.lo, c.hi));
  }

  // ---- 서버 전체 요청 지표 (모델별) ----
  // 내 사용량이 아니라 이 서버가 지금 얼마나 붐비는지를 본다. 창 길이·주기·색 범위는
  // 모두 서버(config/server.json의 rate)에서 내려온다 — 여기에 적힌 값은 없다.

  function rateColor(v, sc) {
    const lo = Number((sc || {}).min) || 0;
    const hi = Number((sc || {}).max) || 0;
    if (!(lo > 0) || !(hi > lo)) return "";   // 범위를 못 받으면 색을 입히지 않는다
    return rampAt(logPos(v, lo, hi));
  }

  function rateNum(v, sc, unit) {
    const n = Number(v) || 0;
    const txt = n >= 10 ? fmtNum(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
    const col = rateColor(n, sc);
    return '<b class="ratev"' + (col ? ' style="color:' + col + '"' : "") + ">" + txt + "</b>" +
      '<span class="rateu">' + unit + "</span>";
  }

  function renderRates(doc) {
    const bar = document.getElementById("rate-bar");
    if (!bar) return;
    const rows = (doc && doc.rates) || [];
    if (!rows.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    const sc = doc.scale || {};
    const win = doc.window || {};
    const mins = (s) => Math.round((Number(s) || 0) / 60);
    bar.title = "server-wide, sliding window — requests " + mins(win.request_s) +
      "m / tokens " + mins(win.token_s) + "m";
    // rate, token/s, model 순서로 한 행 — 값이 앞이라 눈이 숫자부터 읽는다
    bar.innerHTML = rows.map((r) =>
      '<span class="rateitem">' + rateNum(r.rpm, sc.request, "/m") +
      rateNum(r.tpm, sc.token, "t/m") +
      '<span class="ratem">' + esc(r.model) + "</span></span>").join("");
    bar.hidden = false;
  }

  async function refreshRates() {
    try {
      const doc = await api("api/rates");
      if (doc && doc.poll_seconds) state.ratePoll = Number(doc.poll_seconds) || state.ratePoll;
      renderRates(doc);
    } catch (e) { /* 지표를 못 가져와도 대화에는 영향이 없다 */ }
  }

  // 숫자에 색을 입힌 조각. 숫자 자체가 라벨이므로 색은 보조 표시일 뿐이다.
  function scaled(text, color, title) {
    return '<span class="scaled" style="color:' + color + '"' +
      (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(text) + "</span>";
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    const units = [["T", 1e12], ["G", 1e9], ["M", 1e6], ["k", 1e3]];
    for (let i = 0; i < units.length; i++) {
      const u = units[i][0], base = units[i][1];
      if (v >= base) {
        const x = v / base;
        return (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, "")) + u;
      }
    }
    return String(v);
  }

  function sizeMeta(text) {
    const s = String(text || "");
    const chars = Array.from(s).length;
    const bytes = new TextEncoder().encode(s).length;
    const size = bytes < 1024 ? bytes.toLocaleString() + " B" : (bytes / 1024).toFixed(1) + " KB";
    return chars.toLocaleString() + " chars " + size;
  }

  function msgHtml(m, i) {
    const role = m.role === "user" ? "user" : "assistant";
    const ts = msgTs(m.ts);
    const editedMark = m.edited_at
      ? '<span class="capi edited" title="edited: ' + esc(msgTs(m.edited_at)) + '">edited</span>' : "";
    // context 편집 모드: LLM 재전송 없이 내용만 제자리 수정 (user·assistant 모두 가능)
    if (state.ctxEditIdx === i) {
      return '<div class="msgwrap editing ' + role + '"><div class="msgedit">' +
        '<textarea id="ctx-edit-ta" spellcheck="false">' + esc(m.content) + "</textarea>" +
        '<div class="editbtns"><button type="button" class="infotip" style="margin-right:auto" aria-label="Info" data-tip="Replaces the history only, without resending. The edited context applies from the next question.">i</button>' +
        '<button id="ctx-edit-cancel" class="small" type="button">Cancel</button>' +
        '<button id="ctx-edit-save" class="insertbtn" type="button">Save</button></div></div></div>';
    }
    // 수정 모드: 그 질문 box 안에서 편집 + 취소/전송 버튼
    if (role === "user" && state.editingIdx === i) {
      // 수정 후 재전송: 모델·추가 설정(temp·reasoning)을 여기서도 지정할 수 있다
      return '<div class="msgwrap editing user"><div class="msgedit">' +
        '<div class="optbar">' + optbarHtml("edit") + "</div>" +
        '<textarea id="edit-msg-ta" spellcheck="false">' + esc(m.content) + "</textarea>" +
        '<div class="editbtns"><span id="edit-msg-status" class="hint"></span>' +
        '<button id="edit-msg-cancel" class="small" type="button">Cancel</button>' +
        sendBtnHtml("edit-msg-send", "Send") + "</div></div></div>";
    }
    let cap = "";
    if (role === "user") {
      const entry = ((state.chatDoc || {}).alts || {})[String(i)];
      if (entry && entry.variants && entry.variants.length > 1) {
        cap += '<span class="bnav"><button class="bstep" data-bi="' + i + '" data-dir="-1" type="button">&#9664;</button>' +
          (entry.active + 1) + "/" + entry.variants.length +
          '<button class="bstep" data-bi="' + i + '" data-dir="1" type="button">&#9654;</button></span>';
      }
      cap += '<span class="capi">' + esc(ts) + "</span>" + editedMark +
        '<span class="capi msize">' + esc(sizeMeta(m.content)) + "</span>" +
        '<span class="mtoggleslot"></span>' +
        '<button class="iconbtn copymsg" data-mi="' + i + '" type="button" title="Copy message">' + ICON_COPY + "</button>" +
        '<button class="iconbtn editmsg" data-mi="' + i + '" type="button" title="Edit and resend (creates a branch)">' + ICON_EDIT + "</button>";
    } else {
      const u = m.usage || {};
      const parts = [esc(ts), esc(sizeMeta(m.content))];
      // 모델명은 말풍선 위 발신자 표시와 겹치므로 다를 때만 캡션에 남긴다
      if (m.model && m.model !== senderLabel(m)) parts.push(esc(m.model));
      if (m.latency_ms) {
        const sec = m.latency_ms / 1000;
        parts.push(scaled(sec.toFixed(1) + "s", latencyColor(sec), "response in " + sec.toFixed(1) + "s"));
      }
      if (u.prompt_tokens || u.completion_tokens) {
        const tot = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
        parts.push("in " + fmtNum(u.prompt_tokens || 0) + " / out " +
                   scaled(fmtNum(u.completion_tokens || 0), tokenColor(tot),
                          "this reply " + tot.toLocaleString() + " tok") + " tok");
      }
      cap = parts.map((t) => '<span class="capi">' + t + "</span>").join("") + editedMark +
        '<span class="mtoggleslot"></span>' +
        '<button class="iconbtn copymsg" data-mi="' + i + '" type="button" title="Copy full answer">' + ICON_COPY + "</button>";
    }
    // metadata(시각·모델·토큰)는 말풍선 밖 캡션으로. assistant는 markdown 렌더링
    // 실패 메시지는 그대로 보여준다 (markdown이 아니라 오류 문구다)
    const body = (role === "assistant" && !m.failed) ? renderMarkdown(m.content) : esc(m.content);
    const who = senderLabel(m);
    const failCls = m.failed ? " failed" : "";
    return '<div class="msgwrap ' + role + '" data-mi="' + i + '">' +
      (who ? '<div class="sender">' + esc(who) + "</div>" : "") +
      '<div class="msg ' + role + failCls + '">' + body + "</div>" +
      (cap ? '<div class="mcap">' + cap + "</div>" : "") + "</div>";
  }

  // 긴 질문·답변은 기본 150px로 접어 두고 버튼으로 펼친다 (펼침 상태는 대화별로 기억)
  const MSG_COLLAPSE_PX = 150;

  function applyMsgCollapse() {
    const box = $("#chat-messages");
    const expanded = state.expandedMsgs || (state.expandedMsgs = {});
    box.querySelectorAll(".msgwrap[data-mi]").forEach((wrap) => {
      const msg = wrap.querySelector(".msg");
      if (!msg) return;
      const key = wrap.getAttribute("data-mi");
      const slot = wrap.querySelector(".mtoggleslot");
      if (slot) slot.innerHTML = "";
      const put = (label) => {
        const html = '<button class="msgtoggle" type="button" data-toggle="' + key + '">' + label + "</button>";
        if (slot) slot.innerHTML = html;
        else wrap.insertAdjacentHTML("beforeend", html);
      };
      msg.classList.remove("clamped");
      // 펼친 글은 길다 — 접기 버튼이 든 캡션 줄을 화면에 붙여 두어야 어디서든 접을 수 있다
      wrap.classList.toggle("expanded", !!expanded[key]);
      if (expanded[key]) { put("collapse ▴"); return; }
      if (msg.scrollHeight > MSG_COLLAPSE_PX + 8) {
        msg.classList.add("clamped");
        put("expand ▾");
      }
    });
    syncBottomSpacer();  // 마지막 질문도 맨 위까지 올릴 수 있도록 아래 여백 확보
    updateJumpButtons(); // 높이가 바뀌었으므로 스크롤 점프 버튼 표시도 갱신
  }

  // 마지막 턴(질문+답변)이 화면보다 짧으면 그 질문을 상단까지 스크롤할 수 없다.
  // ChatGPT처럼 목록 끝에 여백을 두어 어떤 질문이든 맨 위에 놓을 수 있게 한다.
  function syncBottomSpacer() {
    const box = $("#chat-messages");
    let sp = box.querySelector(".msgspacer");
    const wraps = [...box.querySelectorAll(".msgwrap[data-mi]")];
    if (!wraps.length) { if (sp) sp.remove(); return; }
    let lastQ = null;
    for (let i = wraps.length - 1; i >= 0; i--) {
      if (wraps[i].classList.contains("user")) { lastQ = wraps[i]; break; }
    }
    const from = lastQ || wraps[wraps.length - 1];
    if (!sp) {
      sp = document.createElement("div");
      sp.className = "msgspacer";
      box.appendChild(sp);
    } else {
      box.appendChild(sp); // 항상 맨 끝 유지
    }
    sp.style.height = "0px";
    const tail = box.scrollHeight - (from.offsetTop - box.offsetTop);
    sp.style.height = Math.max(0, Math.round(box.clientHeight - tail - 8)) + "px";
  }

  function renderChatMessages() {
    const box = $("#chat-messages");
    const prevTop = box.scrollTop; // 사용자가 보던 위치 보존용
    const msgs = (state.chatDoc && state.chatDoc.messages) || [];
    box.innerHTML = msgs.length
      ? msgs.map((m, i) => msgHtml(m, i)).join("")
      : '<div class="empty">Send a message to ' + (state.chatId ? "continue this chat." : "start a new chat.") + "</div>";
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
          ignoredClasses: ["katex"], // mdInline이 이미 렌더한 수식은 다시 건드리지 않는다
          throwOnError: false,
        });
      } catch (e) { /* 수식 렌더 실패는 무시 */ }
    }
    applyMsgCollapse(); // 접기 상태 적용 — 스크롤 앵커 계산 전에 높이를 확정한다
    renderTxState();    // 새로 그려진 수정 상자 버튼에도 현재 전송 상태를 반영
    // 스크롤: 방금 보낸 질문이 있으면 그 질문을 상단에 앵커 (답변을 처음부터 읽도록),
    // 아니면 맨 아래로
    const anchor = state.scrollAnchor;
    state.scrollAnchor = null;
    if (state.userScrolled) {
      // 사용자가 보고 있는 위치를 고정 — 답변이 도착해도 화면은 그대로이고 스크롤바만 작아진다
      markProgScroll();
      box.scrollTop = prevTop;
    } else if (anchor != null) {
      let target = null;
      if (anchor === "last-user") {
        const users = box.querySelectorAll(".msgwrap.user");
        target = users[users.length - 1];
      } else {
        target = box.children[anchor];
      }
      scrollMsgIntoTop(target);
    } else {
      markProgScroll();
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
      ? "total " + fmtNum(cum) + " context " + fmtNum(ctx) + "/" + fmtNum(limit) +
        " (" + (ctx * 100 / limit).toFixed(1) + "%)"
      : "";
    renderChatRequest();
    renderChatTree();
  }

  function buildRequestPreview(msg, opts) {
    // 전송 버튼 클릭 직후 즉시 렌더링할 요청 재구성 — 서버 저장본(last_request)과 동일 구조
    const cfg = state.llmConfig || {};
    opts = opts || {};
    const model = opts.model || $("#model").value || cfg.model || "sonnet";
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
    // 모델 추가 설정도 extra payload처럼 실린다
    if (opts.temperature) payload.temperature = parseFloat(opts.temperature);
    if (opts.reasoning_effort) payload.reasoning_effort = opts.reasoning_effort;
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
      box.innerHTML = '<div class="empty">No chats yet.</div>';
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
    // 보기 옵션: 구조순(기본, 분기 트리 순서) / 시간순(모든 가지를 timestamp로 재배치).
    // 레인(가지)과 부모 연결은 그대로 두고 행 순서만 바꾸므로 어느 뷰에서도 계보가 유지된다.
    const timeView = state.treeOrder === "time";
    if (timeView) {
      const order = rows.map((r, i) => i)
        .sort((a, b) => String(rows[a].msg.ts || "").localeCompare(String(rows[b].msg.ts || "")) || a - b);
      const newIdx = {};
      order.forEach((oldI, ni) => { newIdx[oldI] = ni; });
      const sorted = order.map((i) => rows[i]);
      sorted.forEach((r) => {
        if (r.connect) r.connect = { lane: r.connect.lane, row: newIdx[r.connect.row] };
      });
      rows.length = 0;
      sorted.forEach((r) => rows.push(r));
    }
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
    if (timeView) {
      // 시간순: 같은 레인의 연속한 두 노드를 잇는 선분 + 부모에서 들어오는 대각선
      Object.keys(lanes).map(Number).sort((a, b) => a - b).forEach((ln) => {
        const list = lanes[ln];
        const color = LANE_COLORS[ln % LANE_COLORS.length];
        const seg = (d, act) => {
          svg += '<path d="' + d + '" stroke="' + color + '" stroke-width="' + (act ? 3.2 : 1.8) +
            '" fill="none" opacity="' + (act ? 1 : 0.5) +
            '" stroke-linecap="round" stroke-linejoin="miter"/>';
        };
        const conn = list[0].r.connect;
        if (conn && conn.lane !== ln) {
          seg("M" + X(conn.lane) + " " + Y(conn.row) + " L" + X(ln) + " " + Y(list[0].ri), list[0].r.active);
        }
        for (let k = 1; k < list.length; k++) {
          seg("M" + X(ln) + " " + Y(list[k - 1].ri) + " L" + X(ln) + " " + Y(list[k].ri),
            list[k - 1].r.active && list[k].r.active);
        }
      });
    } else
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
    const flat = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const rowsHtml = rows.map((r, ri) => {
      const m = r.msg;
      // 요약: 답변 행은 [질문 앞부분 → 답변 앞부분]으로 한 턴을 함께 보여준다
      let preview = flat(m.content, 64);
      if (m.role === "assistant") {
        const prevRow = rows[ri - 1];
        const q = prevRow && prevRow.msg.role === "user" ? flat(prevRow.msg.content, 30) : "";
        preview = (q ? q + " → " : "") + flat(m.content, q ? 40 : 64);
      }
      let meta = "";
      if (m.role === "assistant") {
        const u = m.usage || {};
        if (m.model) meta += m.model;
        if (u.total_tokens) meta += (meta ? " " : "") + fmtNum(u.total_tokens) + "tok";
      }
      // 칩 색 = 그 가지의 레인 색 (테두리·글자·레일·노드 통일, 레인 수 초과 시 색 loop)
      const laneStroke = LANE_COLORS[r.lane % LANE_COLORS.length];
      const onPath = !!(r.branch && r.branch.isActive && r.active); // 현재 대화 경로 위의 선택 가지
      const pill = r.branch
        ? '<span class="tpill' + (onPath ? " on" : "") + '" style="color:' + laneStroke +
          ";border-color:" + laneStroke + (onPath ? ";background:" + laneStroke + "1f" : "") +
          '" title="#' + r.branch.bi + ' branches at ' + (r.branch.j + 1) + "/" + r.branch.total +
          (onPath ? " current chat"
            : r.branch.isActive ? " selected branch here (its parent is inactive) click a row to switch"
              : " click a row to switch to this branch") + '">' +
          (r.branch.j + 1) + "/" + r.branch.total + "</span>"
        : "";
      const headMark = r.active && r.absIdx === tipIdx ? '<span class="tcur">current</span>' : "";
      // 활성 경로 메시지만 context 편집 가능 (chat.messages 인덱스와 일치)
      const editBtn = r.active
        ? '<button class="tedit" data-cedit="' + r.absIdx +
          '" type="button" title="Edit content only, no resend, replaces context">' + ICON_EDIT + "</button>"
        : "";
      // 표기 순서: [분기 pill] timestamp → 편집 → #번호 → 대화요약 → (우측) 현재·모델·토큰
      return '<div class="trow' + (r.active ? " act" : " dim") + '" data-ri="' + ri +
        '" style="height:' + rowH + 'px" title="' +
        esc((r.active ? "" : "Click to switch to this branch\n") +
          (m.role === "assistant" && rows[ri - 1] && rows[ri - 1].msg.role === "user"
            ? "Q: " + flat(rows[ri - 1].msg.content, 200) + "\nA: " : "") +
          String(m.content || "").slice(0, 300)) + '">' +
        // 열을 고정 폭 셀로 분리한다: 분기 chip | 시각 | 편집 | #번호 | 요약 | 메타
        '<span class="tcell tts">' + esc(treeTs(m.ts)) + "</span>" +
        '<span class="tcell tedcell">' + editBtn + "</span>" +
        '<span class="tcell tpillcell">' + pill + "</span>" +
        '<span class="tcell tidx">#' + r.absIdx + "</span>" +
        '<span class="tprev">' + esc(preview) + "</span>" +
        '<span class="tmeta">' + headMark + (headMark && meta ? " " : "") + esc(meta) + "</span>" +
        "</div>";
    }).join("");

    const tipBox = document.getElementById("chat-tree-box");
    // 보기 전환 버튼 (구조순 / 시간순)
    if (tipBox && !tipBox.querySelector(".tviews")) {
      tipBox.querySelector("summary").insertAdjacentHTML("beforeend",
        '<span class="tviews">' +
        '<button type="button" class="tvbtn" data-tview="struct" title="Order by branch structure">structure</button>' +
        '<button type="button" class="tvbtn" data-tview="time" title="Order all branches by time">time</button></span>');
    }
    if (tipBox) {
      tipBox.querySelectorAll(".tvbtn").forEach((b) => {
        b.classList.toggle("on", b.getAttribute("data-tview") === (state.treeOrder || "struct"));
      });
    }
    if (tipBox && !tipBox.querySelector(".infotip")) {
      tipBox.querySelector("summary").insertAdjacentHTML("beforeend",
        '<button type="button" class="infotip" aria-label="Info" data-tip="The bold path is the chat you are viewing. Click a dimmed row to switch to that branch. Like git checkout, the graph shape and colors stay put and only the emphasis moves.">i</button>');
    }
    box.innerHTML = '<div class="tgraph">' +
      '<svg width="' + gutter + '" height="' + H + '" class="tsvg">' + svg + "</svg>" +
      '<div class="trows" style="margin-left:' + gutter + 'px">' + rowsHtml + "</div></div>";
  }

  document.getElementById("chat-tree-box").addEventListener("click", (e) => {
    const b = e.target.closest(".tvbtn");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    state.treeOrder = b.getAttribute("data-tview");
    renderChatTree();
  });

  document.getElementById("chat-tree").addEventListener("click", async (e) => {
    const te = e.target.closest(".tedit");
    if (te) {
      e.preventDefault();
      if (state.sending) { toast("Cannot edit while waiting for a response"); return; }
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
      // 활성 경로 행: 그 대화가 시작된 "질문"이 맨 위에 오도록 스크롤한다.
      // 답변 행을 눌러도 앞선 질문부터 읽을 수 있게 하기 위함.
      const msgs = (state.chatDoc && state.chatDoc.messages) || [];
      let qIdx = row.absIdx;
      while (qIdx > 0 && (msgs[qIdx] || {}).role !== "user") qIdx -= 1;
      const box = $("#chat-messages");
      const anchor = box.querySelector('.msgwrap[data-mi="' + qIdx + '"]');
      const target = box.querySelector('.msgwrap[data-mi="' + row.absIdx + '"]');
      if (anchor) scrollMsgIntoTop(anchor);
      if (target) { // 실제로 누른 메시지를 잠깐 강조
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1200);
      }
      // 특정 지점을 보고 있으므로 새 응답이 와도 화면을 뺏지 않는다 (마지막 턴 제외)
      state.userScrolled = row.absIdx < msgs.length - 1;
      return;
    }
    // 비활성 행 클릭 = checkout: 필요한 분기 선택(바깥쪽→안쪽)을 한 요청으로 원자 전환.
    // graph 구조는 그대로 두고 강조(활성 경로)만 이동한다.
    if (state.sending) { toast("Cannot switch branches while waiting for a response"); return; }
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
    toast(switchErr ? "Branch switch failed: " + switchErr.message
      : "Switched: the selected branch is now the current chat");
  });

  function renderChatRequest(preview) {
    const box = $("#chat-request");
    const lr = preview || (state.chatDoc && state.chatDoc.last_request);
    state.lastRenderedRequest = lr || null;
    if (!lr) {
      box.innerHTML = '<div class="empty">No request sent yet.</div>';
      return;
    }
    // payload 파라미터를 요약 줄로 노출 — body 전문은 messages가 길어 끝까지 스크롤해야
    // temperature 같은 옵션이 보이므로, 실제로 실린 키를 여기서 먼저 보여준다.
    const pl = lr.payload || {};
    const extras = Object.keys(pl).filter((k) => k !== "messages" && k !== "model");
    const paramLine = '<div class="reqparams">model <b>' + esc(pl.model || lr.model || "") + "</b>" +
      (extras.length
        ? extras.map((k) => ' <span class="pchip">' + esc(k) + " <b>" +
          esc(typeof pl[k] === "object" ? JSON.stringify(pl[k]) : String(pl[k])) + "</b></span>").join("")
        : ' <span class="cmeta">no extra options</span>') +
      " timeout " + esc(lr.timeout_s || "?") + "s</div>";
    box.innerHTML =
      '<div class="reqline"><code>' + esc(lr.method || "POST") + " " + esc(lr.url || "") + "</code> payload " +
      (lr.payload_bytes || 0).toLocaleString() + " bytes " + esc(lr.ts || "") +
      (lr.pending ? ' <b>just sent, waiting for response</b>' : "") +
      ' <button class="copyreq" type="button" title="Copy request">copy</button></div>' +
      paramLine +
      '<h4>headers (tokens masked)</h4><pre class="raw wrap">' + esc(JSON.stringify(lr.headers || {}, null, 2)) + "</pre>" +
      '<h4>body (as sent)</h4><pre class="raw">' + esc(JSON.stringify(lr.payload || {}, null, 2)) + "</pre>";
    const rbox = $("#chat-response");
    const lresp = state.chatDoc && state.chatDoc.last_response;
    if (!lresp || !lresp.envelope) {
      rbox.innerHTML = '<div class="empty">No response received yet.</div>';
      return;
    }
    rbox.innerHTML =
      '<div class="reqline"><code>HTTP 200</code> ' + (lresp.bytes || 0).toLocaleString() + " bytes " +
      (lresp.latency_ms ? (lresp.latency_ms / 1000).toFixed(1) + "s " : "") + esc(lresp.ts || "") + "</div>" +
      '<h4>envelope (as received)</h4><pre class="raw">' + esc(JSON.stringify(lresp.envelope, null, 2)) + "</pre>";
  }

  async function sendChat() {
    const input = $("#chat-input");
    const msg = input.value.trim();
    if (!msg || getTx()) return;   // 이 대화가 이미 응답을 기다리는 중이면 무시
    const opts = readOptbar("chat");
    state.userScrolled = false; // 내가 보낸 메시지는 보여야 하므로 따라가기 모드로 복귀
    const token = "SEND-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    setTx({ kind: "send", chatId: state.chatId || "", startedMs: Date.now(), token: token },
          state.chatId || "");
    input.value = "";
    resetInputHeight();
    const box = $("#chat-messages");
    if (!((state.chatDoc && state.chatDoc.messages) || []).length) box.innerHTML = "";
    // 완료 상태와 같은 구조로 그린다 — 답변이 와도 자리가 움직이지 않는다
    box.insertAdjacentHTML("beforeend", pendingTurnHtml(msg, Date.now(), null));
    // 방금 보낸 질문을 채팅창 상단에 앵커 — 질문과 그 아래 대기 타이머가 항상 보이게
    scrollMsgIntoTop(document.getElementById("chat-just-sent"));
    renderChatRequest(buildRequestPreview(msg, opts)); // 요청 전문은 전송 직후 즉시 표시
    const sentChatId = state.chatId; // 응답 도착 시 사용자가 다른 대화로 이동했으면 화면을 뺏지 않는다
    try {
      const r = await apiPost("api/chat/send", Object.assign({
        id: sentChatId, message: msg, client_token: token,
        system: $("#chat-system").value.trim(),
      }, opts));
      // 프로젝트 홈에서 시작한 새 대화는 생성 직후 그 프로젝트에 넣는다
      if (!sentChatId && state.pendingProject) {
        try { await apiPost("api/chat/meta", { id: r.id, project: state.pendingProject }); }
        catch (err) { /* 소속 지정 실패는 대화 자체를 막지 않는다 */ }
        state.pendingProject = null;
      }
      rekeyTx(sentChatId || "", r.id);   // 새 대화였다면 "" -> 새 id
      _lastChatId = r.id || "";
      if (r.failed) {
        // 실패: 질문과 실패 메시지가 서버에 저장됐다. 입력창으로 되돌리지 않는다.
        if (state.chatId === sentChatId) {
          state.scrollAnchor = "last-user";
          await loadChatDoc(r.id);
        }
        refreshChats();
        toast("Failed: " + (r.code ? "(" + r.code + ") " : "") + (r.message || ""));
        return;
      }
      if (r.stopped) {
        // 정지: 질문은 남고 답변 자리는 비어 있다. 입력창으로 되돌리지 않는다.
        if (state.chatId === sentChatId) {
          state.scrollAnchor = "last-user";
          await loadChatDoc(r.id);
        }
        refreshChats();
        toast("Stopped. The question was kept.");
        return;
      }
      const stillViewing = state.chatId === sentChatId; // 새 대화(null)였다면 여전히 null인지
      if (stillViewing) {
        state.scrollAnchor = "last-user"; // 답변 도착 후에도 질문을 상단에 유지
        await loadChatDoc(r.id);
      }
      refreshChats(); // 목록(토큰·턴 수)만 갱신, 현재 선택 유지
    } catch (e) {
      if (state.chatId === sentChatId) {
        const p = document.getElementById("chat-pending");
        removePendingTurn(); // 질문 줄과 답변 자리를 함께 제거
        input.value = msg; // 실패 시 입력 복원 (서버도 user 메시지를 저장하지 않음)
        autoGrowInput();
      }
      toast(e.code === "E-1022" ? "Stopped. The response was not saved."
        : "Send failed: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    } finally {
      setTx(null, sentChatId || "");
      setTx(null, lastChatId());   // 새 대화였다면 새로 받은 id 쪽도 함께 해제
      refreshRates();              // 방금 보낸 요청이 다음 주기를 기다리지 않고 바로 지표에 보이게
      input.focus();
    }
  }

  // sendChat이 마지막으로 다룬 대화 id (새 대화는 전송 뒤에야 id가 생긴다)
  let _lastChatId = "";
  function lastChatId() { return _lastChatId; }

  $("#chat-send").addEventListener("click", () => { if (getTx()) cancelSend(); else sendChat(); });
  renderTxState(); // 초기 아이콘(보내기) 렌더
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendChat();
  });
  $("#chat-input").addEventListener("input", autoGrowInput);
  window.addEventListener("resize", autoGrowInput);
  $("#chat-new").addEventListener("click", () => {
    closeProjectHome();
    setSidebar(false);
    state.pendingProject = null;
    state.chatId = null;
    state.chatDoc = null;
    $("#chat-system").value = DEFAULT_CHAT_SYSTEM;
      markSystemChips();
    renderChatList();
    renderChatMessages();
    pushRoute(); // 목록(새 대화) 상태도 history entry — 뒤로가기로 이전 대화 복귀
    $("#chat-input").focus();
    toast("New chat, created on first message");
  });
  $("#chat-list").addEventListener("click", (e) => {
    const ct = e.target.closest("[data-ptoggle]");
    if (ct) {
      const pid = ct.getAttribute("data-ptoggle");
      state.openProjects = state.openProjects || {};
      state.openProjects[pid] = !isProjectOpen(pid);
      renderChatList();
      return;
    }
    const ph = e.target.closest("[data-phome]");
    if (ph) { openProjectHome(ph.getAttribute("data-phome")); return; }
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
    if (it) {
      closeProjectHome();
      setSidebar(false); // 모바일: 대화를 고르면 드로어를 닫는다
      if (it.getAttribute("data-chat") !== state.chatId) loadChatDoc(it.getAttribute("data-chat"));
    }
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
        toast("Rename failed: " + (err.code ? "(" + err.code + ") " : "") + err.message);
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
    const item = $("#chat-list-items").querySelector('[data-chat="' + cid + '"]');
    const c = (state.chats || []).find((x) => x.id === cid);
    if (!item || !c) return;
    inlineRename(item.querySelector(".ctitle"), c.title, async (name) => {
      await apiPost("api/chat/meta", { id: cid, title: name });
      await refreshChats();
      toast("Chat renamed");
    });
  }

  function startProjectRename(pid) {
    const btn = $("#chat-list-items").querySelector('.prename[data-pid="' + pid + '"]');
    const p = (state.projects || {})[pid];
    if (!btn || !p) return;
    inlineRename(btn.closest(".lsec"), p.name, async (name) => {
      await apiPost("api/project/rename", { id: pid, name: name });
      await refreshChats();
      toast("Project renamed");
    });
  }

  async function deleteProject(pid) {
    const p = (state.projects || {})[pid];
    if (!p) return;
    const n = (state.chats || []).filter((c) => c.project === pid).length;
    if (!confirm('Project "' + p.name + '" will be deleted.' +
      (n ? "\nChats " + n + " chat(s) will move to the top level, not be deleted." : ""))) return;
    try {
      await apiPost("api/project/delete", { id: pid });
      await refreshChats();
      toast("Project deleted" + (n ? " chats " + n + " chat(s) moved to top level" : ""));
    } catch (err) { toast("Delete failed: " + (err.code ? "(" + err.code + ") " : "") + err.message); }
  }

  $("#chat-newproj").addEventListener("click", async () => {
    const name = prompt("Enter a project name");
    if (name == null || !name.trim()) return;
    try {
      await apiPost("api/project/create", { name: name.trim() });
      await refreshChats();
      toast("Project created. Use the folder icon on a chat row to move it in.");
    } catch (err) { toast("Create failed: " + (err.code ? "(" + err.code + ") " : "") + err.message); }
  });

  async function togglePin(cid) {
    const c = (state.chats || []).find((x) => x.id === cid);
    if (!c) return;
    try {
      await apiPost("api/chat/meta", { id: cid, pinned: !c.pinned });
      await refreshChats();
      toast(c.pinned ? "Unpinned" : "Pinned");
    } catch (err) { toast("Pin failed: " + err.message); }
  }

  function openMoveModal(cid) {
    const c = (state.chats || []).find((x) => x.id === cid);
    if (!c) return;
    const projects = state.projects || {};
    const rows = Object.keys(projects).map((pid) =>
      '<button class="small mvopt" type="button" data-mvp="' + esc(pid) + '"' +
      (c.project === pid ? " disabled" : "") + ">" + ICON_FOLDER + " " +
      esc(projects[pid].name) + (c.project === pid ? " (current)" : "") + "</button>").join(" ");
    openHtmlModal('"' + c.title + '" project',
      '<div class="hint">Pick a project to move this chat into, or create a new one. Projects are sorted by latest activity.</div>' +
      (rows ? '<div class="dsbtns" style="flex-wrap:wrap;gap:6px;margin:8px 0">' + rows + "</div>"
        : '<div class="empty">No projects yet. Create one below.</div>') +
      '<div class="dsbtns" style="margin-top:10px;gap:6px">' +
      '<input id="mv-newname" class="rninput" type="text" placeholder="New project name" maxlength="60">' +
      '<button id="mv-create" class="small" type="button">Create and move</button>' +
      (c.project ? '<button id="mv-root" class="small" type="button">Remove from project</button>' : "") + "</div>");
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
          if (!name) { toast("Enter a project name"); return; }
          pid = (await apiPost("api/project/create", { name: name })).id;
        }
        await apiPost("api/chat/meta", { id: cid, project: pid });
        $("#modal-form").onclick = null;
        $("#modal-overlay").hidden = true;
        await refreshChats();
        toast(pid ? "Moved to project" : "Removed from project");
      } catch (err) { toast("Move failed: " + (err.code ? "(" + err.code + ") " : "") + err.message); }
    };
  }
  // 복사 완료 피드백: 클립보드 기록이 끝난 뒤에만 버튼을 잠시 "복사됨"으로 바꾼다
  const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  function flashCopied(btn) {
    if (!btn || btn._copyTimer) return;
    const html = btn.innerHTML;
    btn.innerHTML = ICON_CHECK + (btn.classList.contains("copycode") ? "" : "");
    btn.classList.add("copied");
    btn._copyTimer = setTimeout(() => {
      btn.innerHTML = html;
      btn.classList.remove("copied");
      btn._copyTimer = null;
    }, 1400);
  }

  function copyText(text, label, btn) {
    const done = () => {
      toast(label + " copied to clipboard");
      flashCopied(btn);
    };
    // 확인 표시는 클립보드 기록이 "성공"했을 때만 — 실패하면 실패 토스트만 남는다
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done)
        .catch(() => { if (fallbackCopy(text)) flashCopied(btn); });
    } else if (fallbackCopy(text)) { // HTTP origin 등 clipboard API가 없는 환경
      flashCopied(btn);
    }
  }

  $("#chat-messages").addEventListener("click", (e) => {
    const tg = e.target.closest(".msgtoggle");
    if (tg) {
      const key = tg.getAttribute("data-toggle");
      const expanded = state.expandedMsgs || (state.expandedMsgs = {});
      if (expanded[key]) delete expanded[key]; else expanded[key] = true;
      applyMsgCollapse();
      return;
    }
    const cc = e.target.closest(".copycode");
    if (cc) {
      copyText(cc.closest(".codewrap").querySelector("code").textContent, "Code", cc);
      return;
    }
    const cm = e.target.closest(".copymsg");
    if (cm) {
      const m = ((state.chatDoc || {}).messages || [])[Number(cm.getAttribute("data-mi"))];
      if (m) copyText(m.content, m.role === "assistant" ? "Answer" : "Message", cm); // 원문 그대로 복사
      return;
    }
    const em = e.target.closest(".editmsg");
    if (em) {
      if (state.sending) { toast("Cannot edit while waiting for a response"); return; }
      state.ctxEditIdx = null;
      state.editingIdx = Number(em.getAttribute("data-mi"));
      renderChatMessages();
      wireOptbar("edit", readOptbar("chat")); // 대화 입력창의 현재 선택을 이어받는다
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
      if (getTx()) cancelSend(); else sendEdit();
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
    if (!content) { toast("Content is empty"); return; }
    if (getTx()) return;
    const opts = readOptbar("edit");
    const token = "EDIT-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    setTx({ kind: "edit", chatId: state.chatId || "", editIndex: i, startedMs: Date.now(), token: token });
    const editChatId = state.chatId || "";
    const restoreEditBtn = () => setTx(null, editChatId);
    const sentChatId = state.chatId;
    try {
      const r = await apiPost("api/chat/edit", Object.assign({
        id: sentChatId, index: i, message: content, client_token: token,
        system: $("#chat-system").value.trim(),
      }, opts));
      if (state.chatId === sentChatId) { // 다른 대화로 이동했으면 화면 유지
        state.editingIdx = null;
        state.scrollAnchor = i; // 수정한 질문을 상단에 앵커
        await loadChatDoc(r.id);
      }
      refreshChats();
      toast("Branch created: " + (r.branch.active + 1) + "/" + r.branch.total);
    } catch (e) {
      toast(e.code === "E-1022" ? "Stopped. No branch was created."
        : "Edit resend failed: " + (e.code ? "(" + e.code + ") " : "") + e.message);
      restoreEditBtn();
    } finally {
      setTx(null, editChatId);
    }
  }

  async function saveContextEdit() {
    // context 편집 저장: LLM 호출 없이 이력만 교체 — 다음 질문부터 반영
    const i = state.ctxEditIdx;
    const ta = document.getElementById("ctx-edit-ta");
    if (i == null || !ta) return;
    const content = ta.value.trim();
    if (!content) { toast("Content is empty"); return; }
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
      toast("#" + i + " content edited, applies from the next question");
    } catch (e) {
      toast("Edit failed: " + (e.code ? "(" + e.code + ") " : "") + e.message);
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
    } catch (e) { toast("Branch switch failed: " + e.message); }
    finally { state.checkoutBusy = false; }
  }
  $("#chat-request").addEventListener("click", (e) => {
    if (!e.target.closest(".copyreq")) return;
    const lr = state.lastRenderedRequest;
    if (!lr) return;
    copyText(JSON.stringify({ method: lr.method, url: lr.url, headers: lr.headers, body: lr.payload }, null, 2), "Request");
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
      toast("LLM 연결 설정을 저장했습니다 다음 변환부터 적용");
      refreshLlmStatus();
    } catch (e) {
      toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    }
  }

  async function savePrompt() {
    try {
      await apiPost("api/prompt", { text: $("#prompt").value });
      toast("시스템 프롬프트를 저장했습니다 다음 변환부터 적용");
    } catch (e) {
      toast("저장 실패: " + (e.code ? "(" + e.code + ") " : "") + e.message);
    }
  }

  // ---- 상단 LLM(업스트림) 상태 ----
  async function refreshLlmStatus() {
    try {
      const h = await api("api/llm/health");
      const el = $("#llm-status");
      if (h.poll_seconds) state.llmPoll = Number(h.poll_seconds) || state.llmPoll;
      if (!h.reachable) {
        el.innerHTML = "LLM <b>not connected</b>";
        el.title = (h.error || "") + (h.url ? "\n" + h.url : "");
        return;
      }
      // 상태 API가 없는 게이트웨이는 "연결 안 됨"이 아니다 — 연결은 되고 상세만 없다
      if (h.probe === "unsupported") {
        el.innerHTML = "LLM <b>connected</b> " + esc(h.model || "");
        el.title = "No status API on this endpoint (requests work normally)\n" + (h.url || "");
        return;
      }
      if (h.poll_seconds) state.llmPoll = Number(h.poll_seconds) || state.llmPoll;
      const ex = h.executor || {};
      const busy = ex.running ? " running(" + esc(ex.model || "?") + (ex.queued ? ", queued " + esc(ex.queued) : "") + ")" : "";
      const auth = h.auth && h.auth !== "ok" ? " auth: " + esc(h.auth) : "";
      el.innerHTML = "LLM <b>connected</b>" + busy + auth;
      el.title = h.url || "";
    } catch (e) {
      $("#llm-status").textContent = "LLM status check failed";
    }
  }

  // ---- SSO 상태 ----------------------------------------------------------
  // LED: 초록 = id를 가져옴 / 주황 = 통신은 됐지만 찾는 값 없음 / 빨강 = 서비스 응답 없음
  //      설정(config/sso.json)이 없으면 LED 자체를 켜지 않는다. 어느 경우든 id는 guest로 유지된다.
  function applySsoState(w) {
    const dot = document.getElementById("sso-dot");
    if (!dot) return;
    const s = w || {};
    const ok = s.source === "sso" || s.source === "header";
    const down = s.service === "down";
    const nofield = !ok && s.service === "up"; // 통신 성공, 값 없음
    dot.hidden = !ok && !down && !nofield;
    dot.classList.toggle("ok", ok);
    dot.classList.toggle("warn", nofield);
    dot.classList.toggle("err", down);
    dot.title = down ? "SSO service not responding " + (s.url || "") + (s.error ? "\n" + s.error : "")
      : nofield ? "Could not find sign-in fields in the SSO response " + (s.error || "")
      : ok ? "SSO " + (s.id || "") + [s.name, s.dept].filter(Boolean).map((x) => " " + x).join("")
      : "";
    // 조회 결과가 바뀔 때마다 콘솔에 남긴다 (같은 상태를 반복해서 찍지는 않는다).
    // 서버 터미널에도 같은 내용이 [SSO] 접두어로 남는다.
    // 로그는 실패했을 때만 남긴다 (같은 상태를 반복해서 찍지는 않는다)
    const sig = [s.service, s.source, s.status, s.error].join("|");
    if (!ok && sig !== state.ssoSig) {
      state.ssoSig = sig;
      console.log("[sso] " + (down ? "service not responding" : "no sign-in fields"), {
        url: s.url, status: s.status, service: s.service, source: s.source,
        method_used: s.method_used, error: s.error, response: s.response,
      });
    }
    if (ok) state.ssoSig = sig;
    const meta = document.getElementById("login-meta");
    if (meta) {
      const parts = [s.name, s.dept].filter(Boolean);
      meta.textContent = parts.join(" ");
      meta.hidden = !parts.length;
    }
  }

  // 1단계: 사용자 PC의 로컬 에이전트에 웹소켓으로 붙어 토큰을 받는다.
  // 여기서 localhost는 서버가 아니라 이 브라우저가 도는 PC라서 이 단계는 브라우저만 할 수 있다.
  // 설정(config/sso.json의 local)에 적힌 url·request·response 그대로 동작한다.
  function ssoLocalToken(local) {
    return new Promise((resolve) => {
      const url = (local || {}).url;
      if (!url) return resolve({ skipped: true });
      let ws, done = false;
      const finish = (out) => {
        if (done) return;
        done = true;
        try { if (ws) ws.close(); } catch (e) { /* 이미 닫힘 */ }
        // 실패했을 때만 남긴다. 경로를 맞출 수 있도록 원본 메시지를 함께 찍는다.
        if (out && out.error) console.log("[sso] local agent " + url, out);
        resolve(out);
      };
      const timer = setTimeout(() => finish({ error: "timeout " + local.timeout + "s" }),
        Math.max(1, Number(local.timeout) || 3) * 1000);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(timer);
        return finish({ error: String(e) });
      }
      ws.onopen = () => {
        const req = local.request;
        if (req !== undefined && req !== null && req !== "") {
          ws.send(typeof req === "string" ? req : JSON.stringify(req));
        }
      };
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        let doc = ev.data;
        try { doc = JSON.parse(ev.data); } catch (e) { /* 문자열 그대로 쓴다 */ }
        // 설정의 response에 적힌 이름마다 경로로 값을 꺼낸다 (예: userInfo, key)
        const map = local.response || {};
        const values = {}, missing = [];
        Object.keys(map).forEach((name) => {
          const v = pickPath(doc, map[name]);
          if (v) values[name] = v; else missing.push(name + ' at "' + map[name] + '"');
        });
        // message = 에이전트가 보낸 원본 메시지 (경로를 맞출 때 이걸 보고 고친다).
        // 필드 이름을 raw로 두면 응답 안의 키로 오해된다.
        finish(missing.length ? { error: "missing " + missing.join(", "), message: doc, values: values }
          : { values: values, message: doc });
      };
      ws.onerror = () => { clearTimeout(timer); finish({ error: "websocket error " + url }); };
      ws.onclose = (ev) => {
        if (!done) { clearTimeout(timer); finish({ error: "closed before message (code " + ev.code + ")" }); }
      };
    });
  }

  // 점으로 이어진 경로로 값 꺼내기 (경로가 ""면 값 자체). 서버의 _pick과 같은 규칙이다.
  // 내려가는 도중 값이 JSON 문자열이면 한 번 파싱하고 계속 내려간다
  // (KnoxTray의 raw.data처럼 문자열 안에 JSON이 들어 있는 응답용).
  // 경로는 문자열 하나 또는 후보 배열. 먼저 값이 있는 경로를 쓴다.
  function pickPath(obj, path) {
    if (Array.isArray(path)) {
      for (const p of path) { const got = pickPath(obj, p); if (got) return got; }
      return null;
    }
    let cur = obj;
    if (String(path) !== "") {
      for (const part of String(path).split(".")) {
        if (cur === null || cur === undefined) return null;
        if (typeof cur === "string") {
          try { cur = JSON.parse(cur); } catch (e) { return null; }
        }
        cur = cur[Array.isArray(cur) ? Number(part) : part];
      }
    }
    return (typeof cur === "string" || typeof cur === "number") && String(cur).trim() ? String(cur).trim() : null;
  }

  // 1단계 토큰을 서버로 넘겨 2단계(verify_sso) 확인까지 마친다. 실패해도 guest로만 남는다.
  async function ssoSignIn() {
    try {
      const cfg = await api("api/sso/config");
      if (cfg.poll_seconds) state.ssoPoll = Number(cfg.poll_seconds) || state.ssoPoll;
      if (!cfg.configured) return null;               // 설정 없음 — SSO를 시도하지 않는다
      if (!(cfg.local || {}).url) return null;        // 1단계 없음 — 쿠키만으로 확인하는 구성
      const got = await ssoLocalToken(cfg.local);
      if (!got || !got.values || !Object.keys(got.values).length) {
        console.log("[sso] no values from local agent, staying as guest", got);
        return null;
      }
      return await apiPost("api/sso/verify", { values: got.values });
    } catch (e) {
      console.log("[sso] sign-in failed, staying as guest", String(e));
      return null;
    }
  }

  // 주기 갱신. 이미 로그인된 상태면 서비스 생사만 확인한다 —
  // 여기서 whoami를 토큰 없이 다시 부르면 1단계를 건너뛴 확인이 되어 로그인을 잃는다.
  async function refreshSsoStatus() {
    try {
      if (state.ssoUser) {
        const h = await api("api/sso/health");
        if (h.poll_seconds) state.ssoPoll = Number(h.poll_seconds) || state.ssoPoll;
        applySsoState(Object.assign({}, state.ssoUser, { service: h.service, error: h.error }));
        return;
      }
      const w = await ssoSignIn() || await api("api/whoami");
      applySsoUser(w);
    } catch (e) { /* SSO 확인 실패는 다른 기능에 영향 주지 않는다 */ }
  }

  // 확인 결과를 화면과 state에 반영. source가 sso/header일 때만 로그인으로 본다.
  function applySsoUser(w) {
    state.ssoUser = (w && (w.source === "sso" || w.source === "header")) ? w : null;
    state.user = (w && w.id) || "guest";
    $("#login-id").textContent = state.user;
    applySsoState(w);
  }

  // ---- 1초 tick: 경과 타이머 갱신 + 5초마다 LLM 상태 ----
  setInterval(() => {
    state.tick += 1;
    document.querySelectorAll("[data-timer]").forEach((el) => {
      const start = Number(el.getAttribute("data-start") || 0);
      if (!start) return;
      const sec = elapsedSec(start);
      el.textContent = sec + "s";
      el.style.color = latencyColor(sec);   // 기다리는 동안에도 색이 진해진다
    });
    // 주기는 설정에서 온다 (llm.json의 poll_seconds, sso.json의 etc.poll_seconds,
    // server.json의 rate.poll_seconds). 아래 숫자는 첫 응답이 오기 전 한 번만 쓰인다.
    if (state.tick % (state.llmPoll || 30) === 0) refreshLlmStatus();
    if (state.tick % (state.ssoPoll || 30) === 0) refreshSsoStatus();
    if (state.tick % (state.ratePoll || 5) === 0) refreshRates();
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
    toast(ok ? "클립보드에 복사했습니다" : "클립보드 복사 실패");
    return ok;
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
