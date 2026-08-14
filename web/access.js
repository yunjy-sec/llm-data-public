/* 접근 제어 화면 (독립 모듈).
 *
 * 다른 곳에 그대로 떼어 쓸 수 있게 만들었다. app.js를 참조하지 않고, 이 파일이 없어도
 * 앱은 그대로 동작한다. 붙이는 방법은 index.html에 <script src="access.js"></script> 한 줄.
 *
 * 허용되지 않으면 denied.html로 넘긴다(오버레이가 아니라 실제 이동). 판정이 끝나기 전에는
 * 화면을 잠시 감춰 내용이 먼저 보이지 않게 한다.
 *
 * 서버와의 약속은 세 곳뿐이다.
 *   GET  api/access/check   -> {allowed, admin, via, reason, user}
 *   POST api/access/temp    -> {token}          (임시 id/pw)
 *   GET/POST api/access/rules                    (admin만)
 *
 * 임시 접속 토큰은 localStorage에 두고 X-Access-Token 헤더로 보낸다. 통행증일 뿐이라
 * 화면의 사용자 표시(SSO 결과)는 건드리지 않는다.
 */
(function () {
  "use strict";

  var KEY = "llm-data.access-token";
  var el = null;      // 차단 화면
  var state = { admin: false, checked: false };

  function token() {
    try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }
  function setToken(v) {
    try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) { /* 사설 모드 */ }
  }

  function api(path, opts) {
    opts = opts || {};
    var h = { "Accept": "application/json" };
    if (opts.body) h["Content-Type"] = "application/json";
    var t = token();
    if (t) h["X-Access-Token"] = t;
    return fetch(path, { method: opts.method || "GET", headers: h, cache: "no-store",
      body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || d.message || ("HTTP " + r.status));
          return d;
        });
      });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- 차단: 별도 페이지로 보낸다 ------------------------------------------------
  // 오버레이로 덮으면 그 아래 내용이 잠깐 보인다. 아예 다른 주소로 넘긴다.
  var DENIED = "denied.html";

  function onDeniedPage() {
    return /(^|\/)denied\.html$/.test(location.pathname);
  }

  function goDenied() {
    if (onDeniedPage()) return;
    location.replace(DENIED);
  }

  // 판정이 끝나기 전에는 화면을 감춘다. 판정이 오래 걸리거나 실패하면 그대로 보여준다.
  var hider = null;
  function hideUntilChecked() {
    if (hider || onDeniedPage()) return;
    hider = document.createElement("style");
    hider.id = "acc-hide";
    hider.textContent = "body > *:not(#acc-hide) { visibility: hidden !important; }";
    (document.head || document.documentElement).appendChild(hider);
    setTimeout(reveal, 4000);   // 안전장치 — 접근 제어 때문에 화면이 영영 안 보이면 안 된다
  }
  function reveal() {
    if (hider) { hider.remove(); hider = null; }
  }

  // ---- 관리 화면 (admin) --------------------------------------------------------
  function lines(arr) { return (arr || []).join("\n"); }
  function parseLines(v) {
    return String(v || "").split("\n").map(function (x) { return x.trim(); })
      .filter(function (x) { return x; });
  }

  function openAdmin() {
    api("api/access/rules").then(function (r) {
      var box = document.createElement("div");
      box.className = "accgate accadmin";
      box.innerHTML =
        '<div class="accbox accwide">' +
        "<h1>사용자 허가 설정</h1>" +
        '<p class="acchint">한 줄에 하나씩 적습니다. 부서는 이름의 일부만 적어도 걸립니다. ' +
        "목록이 모두 비면 아무도 막지 않습니다.</p>" +
        '<label>허용 id<textarea id="acc-allow-id" rows="5">' + esc(lines(r.allow.id)) + "</textarea></label>" +
        '<label>허용 부서<textarea id="acc-allow-dept" rows="4">' + esc(lines(r.allow.dept)) + "</textarea></label>" +
        '<label>관리자 id (SSO 로그인 id와 임시 접속 id 모두 적을 수 있습니다)' +
        '<textarea id="acc-admin-id" rows="3">' + esc(lines(r.admin.id)) + "</textarea></label>" +
        '<label>임시 접속 (id pw 메모 순, 공백 구분. pw를 비우면 기존 값을 유지)' +
        '<textarea id="acc-temp" rows="4">' +
        esc((r.temp || []).map(function (t) { return t.id + "  " + (t.note || ""); }).join("\n")) +
        "</textarea></label>" +
        '<p class="accpath">' + esc(r.config_path) + "</p>" +
        '<div class="accbtns"><button id="acc-save" type="button">저장</button>' +
        '<button id="acc-close" type="button" class="ghost">닫기</button></div>' +
        '<p class="accerr" id="acc-aerr" hidden></p>' +
        "</div>";
      document.body.appendChild(box);
      var aerr = box.querySelector("#acc-aerr");
      box.querySelector("#acc-close").addEventListener("click", function () { box.remove(); });
      box.querySelector("#acc-save").addEventListener("click", function () {
        aerr.hidden = true;
        var temp = parseLines(box.querySelector("#acc-temp").value).map(function (line) {
          var p = line.split(/\s+/);
          return { id: p[0], pw: p[1] || "", note: p.slice(2).join(" ") };
        });
        api("api/access/rules", { method: "POST", body: {
          allow: { id: parseLines(box.querySelector("#acc-allow-id").value),
                   dept: parseLines(box.querySelector("#acc-allow-dept").value) },
          admin: { id: parseLines(box.querySelector("#acc-admin-id").value) },
          temp: temp } })
          .then(function () { box.remove(); check(); })
          .catch(function (e) {
            console.log("[access] 허가 목록 저장 실패", String(e));
            aerr.textContent = String(e.message || e);
            aerr.hidden = false;
          });
      });
    }).catch(function (e) {
      console.log("[access] 허가 목록을 불러오지 못했습니다", String(e));
    });
  }

  function renderAdminButton(on) {
    var b = document.getElementById("acc-admin-btn");
    if (!on) { if (b) b.remove(); return; }
    if (b) return;
    var host = document.querySelector("header .brand") || document.body;
    b = document.createElement("button");
    b.id = "acc-admin-btn";
    b.type = "button";
    b.className = "iconbtn gearbtn";
    b.title = "사용자 허가 설정";
    b.textContent = "🔑";
    b.addEventListener("click", openAdmin);
    host.appendChild(b);
  }

  // ---- 판단 --------------------------------------------------------------------
  function check() {
    return api("api/access/check").then(function (info) {
      state.checked = true;
      state.admin = !!info.admin;
      if (info.allowed) reveal(); else goDenied();
      renderAdminButton(!!info.admin);
      return info;
    }).catch(function (e) {
      // 판단 자체가 실패하면 막지 않는다 — 접근 제어 때문에 서비스가 멈추면 안 된다
      console.log("[access] 확인 실패, 통과시킵니다", String(e));
      reveal();
      return null;
    });
  }

  window.accessControl = { check: check, openAdmin: openAdmin, token: token, clear: function () { setToken(""); } };

  hideUntilChecked();   // 판정 전 내용 노출 방지 — script 태그가 읽히는 즉시 건다
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", check);
  } else {
    check();
  }
})();
