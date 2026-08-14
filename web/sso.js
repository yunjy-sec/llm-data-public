/* SSO 로그인 클라이언트 (독립 모듈).
 *
 * 1단계는 브라우저만 할 수 있다 — 사용자 PC의 로컬 에이전트(KnoxTray)에 웹소켓으로 붙는다.
 * 여기서 얻은 값을 서버로 넘기면 서버가 2단계(verify_sso)를 처리하고, 확인된 신원을
 * 서명한 쿠키로 심어 준다. 그 뒤부터는 페이지 이동에도 신원이 실린다.
 *
 * 서버와의 약속은 두 곳뿐이다.
 *   GET  api/sso/config  -> {configured, local:{url, request, response, timeout}}
 *   POST api/sso/verify  -> {id, name, dept, source, ...}  (+ 신원 쿠키)
 *
 * window.ssoClient.signIn() -> Promise<결과 또는 null>
 */
(function () {
  "use strict";

  function api(path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "Accept": "application/json" }
                    : { "Accept": "application/json" },
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || d.message || ("HTTP " + r.status));
        return d;
      });
    });
  }

  // 점으로 이어진 경로로 값 꺼내기. 중간이 JSON 문자열이면 한 번 파싱하고 계속 내려간다
  // (KnoxTray는 data가 JSON 문자열이라 data.userInfo로 적는다).
  function pick(obj, path) {
    if (Array.isArray(path)) {
      for (var i = 0; i < path.length; i++) {
        var got = pick(obj, path[i]);
        if (got) return got;
      }
      return null;
    }
    var cur = obj;
    if (String(path) !== "") {
      var parts = String(path).split(".");
      for (var j = 0; j < parts.length; j++) {
        if (cur === null || cur === undefined) return null;
        if (typeof cur === "string") {
          try { cur = JSON.parse(cur); } catch (e) { return null; }
        }
        cur = cur[Array.isArray(cur) ? Number(parts[j]) : parts[j]];
      }
    }
    return (typeof cur === "string" || typeof cur === "number") && String(cur).trim()
      ? String(cur).trim() : null;
  }

  // 1단계: 로컬 에이전트에서 값 받기
  function localValues(local) {
    return new Promise(function (resolve) {
      var url = (local || {}).url;
      if (!url) return resolve({ skipped: true });
      var ws, done = false;
      function finish(out) {
        if (done) return;
        done = true;
        try { if (ws) ws.close(); } catch (e) { /* 이미 닫힘 */ }
        if (out && out.error) console.log("[sso] local agent " + url, out);
        resolve(out);
      }
      var timer = setTimeout(function () {
        finish({ error: "timeout " + (local.timeout || 3) + "s" });
      }, Math.max(1, Number(local.timeout) || 3) * 1000);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(timer);
        return finish({ error: String(e) });
      }
      ws.onopen = function () {
        var req = local.request;
        if (req !== undefined && req !== null && req !== "") {
          ws.send(typeof req === "string" ? req : JSON.stringify(req));
        }
      };
      ws.onmessage = function (ev) {
        clearTimeout(timer);
        var doc = ev.data;
        try { doc = JSON.parse(ev.data); } catch (e) { /* 문자열 그대로 */ }
        var map = local.response || {};
        var values = {}, missing = [];
        Object.keys(map).forEach(function (name) {
          var v = pick(doc, map[name]);
          if (v) values[name] = v; else missing.push(name + ' at "' + map[name] + '"');
        });
        finish(missing.length ? { error: "missing " + missing.join(", "), message: doc, values: values }
                              : { values: values, message: doc });
      };
      ws.onerror = function () { clearTimeout(timer); finish({ error: "websocket error " + url }); };
      ws.onclose = function (ev) {
        if (!done) { clearTimeout(timer); finish({ error: "closed before message (code " + ev.code + ")" }); }
      };
    });
  }

  // 1단계 + 2단계. 실패하면 null (로그인 없이도 서비스는 동작해야 한다).
  function signIn() {
    return api("api/sso/config").then(function (cfg) {
      if (!cfg.configured) return null;
      if (!(cfg.local || {}).url) return null;   // 1단계 없는 구성
      return localValues(cfg.local).then(function (got) {
        if (!got || !got.values || !Object.keys(got.values).length) {
          if (got && got.error) console.log("[sso] no values from local agent", got);
          return null;
        }
        return api("api/sso/verify", { values: got.values });
      });
    }).catch(function (e) {
      console.log("[sso] sign-in failed", String(e));
      return null;
    });
  }

  window.ssoClient = { signIn: signIn, pick: pick };
})();
