// Gym logger UI. Data lives in the artifact's database (collections
// `sessions`, `checkins`, `meta`); each finished session and check-in is
// also written to the coach's Google Sheet through the viewer's connector.
(function () {
  const L = window.GymLogic;
  const P = L.PLAN;
  const SHEETS = "Google Sheets";
  const BACKUP_KEY = "gymlog-unsaved-v1";
  const LOCAL_KEY = "gymlog-local-v1";

  const S = {
    sessions: {}, checkins: {}, settings: null,
    dbState: "loading", // loading | ok | slow | local
    dirty: {}, saveError: null,
    view: "today", key: null, ciWeek: null, ciDraft: null,
    calMonth: null, calSel: null,
    timer: null, toast: null, sheetTest: null, showWhy: false,
  };
  let db = null, mcp = null, needsRender = false, retryTimer = null, wakeLock = null;
  const inflight = {}; // paths with a sheet write running in this tab
  const app = document.getElementById("app");

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const today = () => L.localDate(new Date());
  const nowIso = () => new Date().toISOString();
  const num = L.fmtNum;
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const fmtDate = (d, opts = { month: "short", day: "numeric" }) => (d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, opts) : "");
  const blockClass = (week) => "b" + L.blockForWeek(week).n;
  const label = (sid) => L.sessionMeta(sid).label;

  function toast(msg) {
    S.toast = msg; renderToast();
    clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = null; renderToast(); }, 2600);
  }

  // ---------- persistence ----------
  function docFor(path) {
    const [col, id] = path.split("/");
    if (col === "sessions") return S.sessions[id];
    if (col === "checkins") return S.checkins[id];
    if (col === "meta" && id === "settings") return S.settings;
    return null;
  }

  function backup() {
    const out = {};
    for (const path of Object.keys(S.dirty)) { const d = docFor(path); if (d) out[path] = d; }
    lsSet(BACKUP_KEY, out);
    if (S.dbState === "local") lsSet(LOCAL_KEY, { sessions: S.sessions, checkins: S.checkins, settings: S.settings });
  }

  const writing = {};
  function save(path) {
    const d = docFor(path);
    if (!d) return;
    d.updatedAt = nowIso();
    S.dirty[path] = true;
    backup();
    if (!db) { delete S.dirty[path]; backup(); return; }
    if (writing[path]) { writing[path].again = true; return; }
    runWrite(path);
  }

  async function runWrite(path) {
    writing[path] = { again: false };
    try {
      do {
        writing[path].again = false;
        await db.doc(path).set(clone(docFor(path)));
      } while (writing[path].again);
      delete S.dirty[path];
      if (!Object.keys(S.dirty).length) S.saveError = null;
    } catch (e) {
      S.saveError = (e && e.code) || "unavailable";
      scheduleRetry();
    } finally {
      delete writing[path];
      backup();
      renderStatusOnly();
    }
  }

  // Only failed writes are retried: when the connection returns or after 20 s.
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(retryDirty, 20000);
  }
  function retryDirty() {
    clearTimeout(retryTimer); retryTimer = null;
    for (const path of Object.keys(S.dirty)) if (!writing[path]) runWrite(path);
  }
  window.addEventListener("online", retryDirty);

  function applyRemote(col, snap) {
    const target = col === "sessions" ? S.sessions : S.checkins;
    for (const ch of snap.docChanges()) {
      const path = `${col}/${ch.doc.id}`;
      if (S.dirty[path]) continue; // our newer local copy wins until saved
      if (ch.type === "removed") delete target[ch.doc.id];
      else {
        const d = clone(ch.doc.data());
        // A sync that was running when the app closed never finished.
        if (d.sync && d.sync.status === "syncing" && !inflight[path]) d.sync = { status: "error", code: "interrupted", msg: "The sheet write was interrupted. Retry to make sure it landed." };
        target[ch.doc.id] = d;
      }
    }
  }

  function restoreBackup() {
    const saved = lsGet(BACKUP_KEY) || {};
    for (const [path, d] of Object.entries(saved)) {
      const cur = docFor(path);
      if (!cur || (d.updatedAt || "") > (cur.updatedAt || "")) {
        const [col, id] = path.split("/");
        if (col === "sessions") S.sessions[id] = d;
        else if (col === "checkins") S.checkins[id] = d;
        else if (path === "meta/settings") S.settings = d;
        save(path);
      }
    }
  }

  async function connect() {
    const loadTimer = setTimeout(() => { if (S.dbState === "loading") { S.dbState = "slow"; render(); } }, 10000);
    try { db = await window.claude.use("db"); } catch (e) { db = null; }
    if (!db) {
      clearTimeout(loadTimer);
      const local = lsGet(LOCAL_KEY);
      if (local) { S.sessions = local.sessions || {}; S.checkins = local.checkins || {}; S.settings = local.settings || null; }
      S.dbState = "local";
      render();
      return;
    }
    let pending = 3, restored = false;
    const ready = (snap) => {
      if (snap.metadata && snap.metadata.fromCache) return;
      if (--pending === 0) {
        clearTimeout(loadTimer);
        S.dbState = "ok";
        if (!restored) { restored = true; restoreBackup(); }
      }
    };
    const onErr = (e) => { clearTimeout(loadTimer); S.saveError = (e && e.code) || "unavailable"; render(); };
    db.collection("sessions").onSnapshot((snap) => { applyRemote("sessions", snap); if (pending) ready(snap); scheduleRender(); }, onErr);
    db.collection("checkins").onSnapshot((snap) => { applyRemote("checkins", snap); if (pending) ready(snap); scheduleRender(); }, onErr);
    db.doc("meta/settings").onSnapshot((snap) => {
      if (!S.dirty["meta/settings"]) S.settings = snap.exists ? clone(snap.data()) : null;
      if (pending) ready(snap);
      scheduleRender();
    }, onErr);
  }

  async function connectMcp() {
    try { mcp = await window.claude.use("mcp"); } catch (e) { mcp = null; }
    render();
  }

  // Don't rebuild the DOM under someone typing; catch up when they leave the field.
  function scheduleRender() {
    const a = document.activeElement;
    if (a && app.contains(a) && /INPUT|TEXTAREA/.test(a.tagName)) { needsRender = true; return; }
    render();
  }
  app.addEventListener("focusout", () => { if (needsRender) { needsRender = false; setTimeout(render, 0); } });

  // ---------- Google Sheets ----------
  function sheetErrorText(e) {
    const code = e && e.code;
    switch (code) {
      case "no_mcp": return "Sheet sync runs when the app is open in claude.ai.";
      case "no_sheet": return "Add your sheet link in the Sheet tab.";
      case "needs_reauth": return "Reconnect Google Sheets in claude.ai Settings → Connectors, then retry.";
      case "server_not_connected": return "Add Google Sheets in claude.ai Settings → Connectors, then retry.";
      case "selection_required": return "Choose which Google Sheets connection to use when claude.ai asks, then retry.";
      case "not_in_manifest": return "Google Sheets access is off for this page. Turn it on in the artifact's Permissions menu.";
      case "approval_required": return "Allow Google Sheets access when claude.ai asks, then retry.";
      case "blocked_by_policy": return "Your organization blocks Google Sheets for this page.";
      case "server_unavailable": case "upstream_error": return "Google Sheets didn't answer. Your log is saved here; retry in a moment.";
      case "tool_error": return "Google Sheets refused the write: " + String(e.message || "").slice(0, 160);
      default: return (e && e.message) || "Sheet sync failed. Your log is saved here.";
    }
  }

  async function sheetCall(tool, input) {
    if (!mcp) throw { code: "no_mcp" };
    const res = await mcp.callTool(SHEETS, tool, input, { cache: false });
    return res.payload;
  }

  function valuesOf(p) {
    if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { return []; } }
    if (!p) return [];
    return p.values || (p.content && p.content.values) || [];
  }

  const sheetId = () => S.settings && S.settings.spreadsheetId;

  async function syncSession(key) {
    const doc = S.sessions[key];
    if (!doc) return;
    doc.sync = { status: "syncing" };
    inflight["sessions/" + key] = true;
    render();
    try {
      if (!sheetId()) throw { code: "no_sheet" };
      const block = L.blockForWeek(doc.week);
      const meta = L.sessionMeta(doc.sid);
      const colA = valuesOf(await sheetCall("get_values", { spreadsheetId: sheetId(), range: `'${block.tab}'!A1:A400` }));
      const rows = L.findSessionRows(colA, doc.week, meta.title, doc.ex.map((e) => e.name));
      const vals = L.sheetRowsForSession(doc);
      for (const run of L.rowRuns(rows)) {
        await sheetCall("update_values", {
          spreadsheetId: sheetId(),
          range: `'${block.tab}'!E${run.start}:I${run.end}`,
          values: run.idx.map((i) => vals[i]),
        });
      }
      doc.sync = { status: "ok", at: nowIso() };
    } catch (e) {
      doc.sync = { status: "error", at: nowIso(), code: (e && e.code) || "layout", msg: sheetErrorText(e) };
    }
    delete inflight["sessions/" + key];
    save("sessions/" + key);
    render();
  }

  async function syncCheckin(id) {
    const c = S.checkins[id];
    if (!c) return;
    c.sync = { status: "syncing" };
    inflight["checkins/" + id] = true;
    render();
    try {
      if (!sheetId()) throw { code: "no_sheet" };
      const row = L.checkinRow(c.week);
      await sheetCall("update_values", { spreadsheetId: sheetId(), range: `'${P.CHECKIN_TAB}'!C${row}:J${row}`, values: [L.checkinSheetRow(c)] });
      c.sync = { status: "ok", at: nowIso() };
    } catch (e) {
      c.sync = { status: "error", at: nowIso(), code: (e && e.code) || "unknown", msg: sheetErrorText(e) };
    }
    delete inflight["checkins/" + id];
    save("checkins/" + id);
    render();
  }

  function unsynced() {
    const s = Object.entries(S.sessions).filter(([, d]) => L.isDone(d) && d.sync && d.sync.status === "error").map(([k]) => ["s", k]);
    const c = Object.entries(S.checkins).filter(([, d]) => d.sync && d.sync.status === "error").map(([k]) => ["c", k]);
    return s.concat(c);
  }
  async function retryAll() {
    for (const [kind, k] of unsynced()) { if (kind === "s") await syncSession(k); else await syncCheckin(k); }
  }

  // ---------- rest timer ----------
  function startTimer(seconds, what) {
    S.timer = { end: Date.now() + seconds * 1000, total: seconds, what };
    tickTimer();
  }
  function tickTimer() {
    clearTimeout(tickTimer.t);
    renderTimer();
    if (!S.timer) return;
    const left = Math.round((S.timer.end - Date.now()) / 1000);
    if (left <= 0 && !S.timer.buzzed) { S.timer.buzzed = true; try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* not allowed */ } }
    if (left < -60) { S.timer = null; renderTimer(); return; }
    tickTimer.t = setTimeout(tickTimer, 250);
  }

  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }

  // ---------- routing ----------
  function route() {
    const h = location.hash.replace(/^#/, "");
    let m;
    if ((m = /^s-(w\d\d-\w+)$/.exec(h)) && L.parseKey(m[1])) { S.view = "session"; S.key = m[1]; }
    else if ((m = /^ci-w(\d\d)$/.exec(h))) { S.view = "checkin"; S.ciWeek = Number(m[1]); S.ciDraft = null; }
    else if (["plan", "calendar", "sheet"].includes(h)) S.view = h;
    else S.view = "today";
    keepAwake(S.view === "session");
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  const go = (h) => { if (location.hash === "#" + h) route(); else location.hash = h; };

  // ---------- views ----------
  function statusBanner() {
    if (S.dbState === "local") return `<div class="banner warn">Open this app on claude.ai to save your logs online. Right now they're only kept in this browser.</div>`;
    if (S.dbState === "slow") return `<div class="banner warn">Can't reach your saved logs yet. Check your connection; anything you log is kept on this phone until it saves.</div>`;
    if (S.saveError) return `<div class="banner warn"><span>Saving paused: no connection. Your sets are kept on this phone and will save when it's back.</span><button class="btn" data-act="retry-save">Retry now</button></div>`;
    return "";
  }

  function viewToday() {
    if (S.dbState === "loading") return `<div class="card empty-state"><h2>Loading your plan…</h2><p class="muted">Fetching your logged sessions.</p></div>`;
    const next = L.nextSession(S.sessions);
    const doneCount = L.SEQ.filter((s) => L.isDone(S.sessions[s.key])).length;
    const parts = [statusBanner()];

    const pend = unsynced();
    if (pend.length) {
      parts.push(`<div class="banner bad"><span>${pend.length} ${pend.length === 1 ? "entry isn't" : "entries aren't"} in your Google Sheet yet.</span><button class="btn" data-act="retry-all">Retry sync</button></div>`);
    }
    if (!sheetId() && S.dbState !== "local") parts.push(`<div class="banner info"><span>Connect your Google Sheet so finished sessions are copied into the coach's file.</span><a class="btn" href="#sheet">Set up</a></div>`);

    // Check-in due: the latest week with all six sessions done and no check-in.
    for (let w = P.WEEKS; w >= 1; w--) {
      if (L.weekComplete(S.sessions, w)) {
        if (!S.checkins["w" + L.pad(w)]) {
          parts.push(`<div class="card"><div class="spread"><div class="stack"><h3>Week ${w} done</h3><p class="muted small">30-second check-in: most of it is already filled in from your logs.</p></div><a class="btn primary" href="#ci-w${L.pad(w)}">Check in</a></div></div>`);
        }
        break;
      }
    }

    if (!next) {
      parts.push(`<div class="card empty-state"><h1>Plan complete</h1><p class="muted">All 72 sessions logged. Every number is in your sheet for the coach.</p></div>`);
      return parts.join("");
    }

    const block = L.blockForWeek(next.week);
    const doc = S.sessions[next.key];
    const ts = L.todayStatus(S.sessions, today());
    const pres = L.prescription(next.week, next.sid, doc ? doc.light : false);
    let note = "";
    if (ts.kind === "doneToday") note = `<p class="pill good">Trained today: ${ts.sessions.map((d) => label(d.sid)).join(", ")}</p>`;
    else if (ts.kind === "rest") note = `<p class="pill warn">Rest day suggested after ${label(ts.after.sid)}. Train anyway if you feel good.</p>`;

    parts.push(`
      <section class="hero">
        <p class="eyebrow"><span class="plate ${blockClass(next.week)}"></span>Week ${next.week} · Block ${block.n}: ${esc(block.name)}</p>
        <div class="progress" title="${doneCount} of 72 sessions"><i style="width:${(doneCount / 72) * 100}%"></i></div>
        <p class="small muted">${doneCount} of 72 sessions done</p>
      </section>
      <div class="card">
        <div class="spread"><h1>${doc ? "Continue" : "Next"}: ${label(next.sid)}</h1>${L.isLightWeek(next.week) ? `<span class="pill warn">Lighter week option</span>` : ""}</div>
        ${note}
        <ul class="next-list">${pres.map((e) => `<li><span>${esc(e.name)}</span><span class="rx">${e.sets} × ${esc(e.range)}</span></li>`).join("")}</ul>
        <a class="btn primary big" href="#s-${next.key}">${doc ? "Continue session" : "Start " + label(next.sid)}</a>
      </div>`);

    const recent = L.SEQ.map((s) => [s.key, S.sessions[s.key]]).filter(([, d]) => L.isDone(d))
      .sort((a, b) => (b[1].completedAt || "").localeCompare(a[1].completedAt || "")).slice(0, 4);
    if (recent.length) {
      parts.push(`<div class="card"><h3>Recent</h3><div class="stack">${recent.map(([k, d]) => `
        <a class="spread" href="#s-${k}" style="color:inherit;text-decoration:none">
          <span><b>${label(d.sid)}</b> <span class="muted small">Week ${d.week}${d.date ? " · " + fmtDate(d.date) : ""}</span></span>
          ${syncPill(d)}
        </a>`).join("")}</div></div>`);
    }
    return parts.join("");
  }

  function syncPill(d) {
    const s = d.sync && d.sync.status;
    if (s === "ok" && !((d.editedAt || "") > (d.sync.at || ""))) return `<span class="pill good">In sheet</span>`;
    if (s === "ok") return `<span class="pill warn">Edited</span>`;
    if (s === "syncing") return `<span class="pill">Syncing…</span>`;
    if (s === "error") return `<span class="pill bad">Not in sheet</span>`;
    if (s === "imported") return `<span class="pill good">From sheet</span>`;
    return `<span class="pill">Not synced</span>`;
  }

  function viewSession() {
    const key = S.key;
    const meta = L.parseKey(key);
    const block = L.blockForWeek(meta.week);
    const doc = S.sessions[key];
    const head = `
      <div class="topbar"><a class="btn ghost" href="#today">← Today</a></div>
      <section class="hero">
        <p class="eyebrow"><span class="plate ${blockClass(meta.week)}"></span>Week ${meta.week} · Block ${block.n}${doc && doc.date ? " · " + fmtDate(doc.date, { weekday: "short", month: "short", day: "numeric" }) : ""}</p>
        <h1>${label(meta.sid)}</h1>
      </section>`;

    if (!doc) {
      const pres = L.prescription(meta.week, meta.sid, false);
      const next = L.nextSession(S.sessions);
      const outOfOrder = next && next.key !== key;
      return head + statusBanner() + `
        <div class="card">
          ${outOfOrder ? `<p class="small muted">Your next session in order is ${label(next.sid)} (week ${next.week}). Doing this one first is fine; ${label(next.sid)} stays next.</p>` : ""}
          <ul class="next-list">${pres.map((e) => {
            const last = L.lastPerformance(S.sessions, e.name, key);
            return `<li><span>${esc(e.name)}${last ? `<br><span class="small muted">Last: ${esc(L.describeSets(last.sets))}</span>` : ""}</span><span class="rx">${e.sets} × ${esc(e.range)}</span></li>`;
          }).join("")}</ul>
          ${L.isLightWeek(meta.week) ? `<label class="toggle"><input type="checkbox" id="light-start"> Lighter week (one fewer set on 3-set exercises)</label>` : ""}
          <button class="btn primary big" data-act="start" data-key="${key}">Start session</button>
        </div>`;
    }

    const plan = L.prescription(meta.week, meta.sid, doc.light);
    const total = doc.ex.reduce((a, e) => a + e.sets.length, 0);
    const ticked = doc.ex.reduce((a, e) => a + e.sets.filter((s) => s.done).length, 0);
    const parts = [head, statusBanner()];

    if (L.isDone(doc)) {
      const s = doc.sync || {};
      const edited = s.status === "ok" && (doc.editedAt || "") > (s.at || "");
      if (s.status === "error") parts.push(`<div class="banner bad"><span>${esc(s.msg)}</span><button class="btn" data-act="sync" data-key="${key}">Retry</button></div>`);
      else if (s.status === "syncing") parts.push(`<div class="banner info">Writing to your Google Sheet…</div>`);
      else if (edited || s.status === "never" || !s.status) parts.push(`<div class="banner warn"><span>Changes not in your sheet yet.</span><button class="btn" data-act="sync" data-key="${key}">Update sheet</button></div>`);
      else if (s.status === "imported") parts.push(`<div class="banner good">Imported from your sheet. Edit a set and tap Update sheet to overwrite it there.</div>`);
      else parts.push(`<div class="banner good">Done${doc.date ? " on " + fmtDate(doc.date) : ""} · in your Google Sheet.</div>`);
    } else {
      if (doc.readiness == null) {
        parts.push(`<div class="card"><h3>Readiness today?</h3><p class="small muted">1 = wrecked, 10 = best you've felt. It's averaged into the weekly check-in.</p>
          <div class="chips">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button class="chip" data-act="ready" data-n="${n}">${n}</button>`).join("")}</div></div>`);
      }
      if (L.isLightWeek(meta.week)) {
        parts.push(`<label class="toggle card" style="display:flex"><input type="checkbox" id="light-toggle" ${doc.light ? "checked" : ""}> Lighter week: one fewer set on 3-set exercises</label>`);
      }
    }

    doc.ex.forEach((e, i) => {
      const p = plan[i] || { name: e.name, range: "", sets: e.sets.length, muscle: "" };
      const kind = L.exerciseKind(e.name, p.range);
      const last = L.lastPerformance(S.sessions, e.name, key);
      const sug = L.suggest(p, last);
      let hint = "";
      if (last) {
        hint = `Last (week ${last.week}): ${esc(L.describeSets(last.sets))}. `;
        hint += sug.progress ? `<b>Top of range on every set: add weight.</b>` : `Beat it: aim for ${L.repBounds(p.range).hi} on every set, then add weight.`;
      } else hint = `First time: pick a weight you can control for all ${esc(p.range)} reps.`;
      const wLabel = kind.pairedDB ? "lb each DB" : "lb";
      const rLabel = kind.unilateral ? "reps / side" : "reps";
      parts.push(`
        <div class="card ex" id="ex-${i}">
          <div class="ex-head">
            <div class="spread"><h3>${esc(e.name)}</h3><span class="pill">${esc(p.muscle)}</span></div>
            <p class="small muted">${p.sets} × ${esc(p.range)}${i === 0 ? " · rest 2–3 min" : " · rest 60–120 s"}</p>
            <p class="hint">${hint}</p>
          </div>
          <div class="unit-row"><span></span><span>${wLabel}</span><span>${rLabel}</span><span></span></div>
          <div class="sets">
            ${e.sets.map((s, j) => `
              <div class="set ${s.done ? "done" : ""}">
                <span class="n">${j + 1}</span>
                <div class="stepper"><button data-act="step" data-i="${i}" data-j="${j}" data-f="w" data-d="-2.5" aria-label="Less weight">−</button><input id="w-${i}-${j}" type="number" inputmode="decimal" step="0.5" min="0" value="${s.w == null ? "" : s.w}" data-i="${i}" data-j="${j}" data-f="w" aria-label="Set ${j + 1} weight"><button data-act="step" data-i="${i}" data-j="${j}" data-f="w" data-d="2.5" aria-label="More weight">+</button></div>
                <div class="stepper"><button data-act="step" data-i="${i}" data-j="${j}" data-f="r" data-d="-1" aria-label="Fewer reps">−</button><input id="r-${i}-${j}" type="number" inputmode="numeric" step="1" min="0" value="${s.r == null ? "" : s.r}" data-i="${i}" data-j="${j}" data-f="r" aria-label="Set ${j + 1} reps"><button data-act="step" data-i="${i}" data-j="${j}" data-f="r" data-d="1" aria-label="More reps">+</button></div>
                <button class="tick" data-act="tick" data-i="${i}" data-j="${j}" aria-pressed="${s.done}" aria-label="Set ${j + 1} done">✓</button>
              </div>`).join("")}
          </div>
          <div class="spread">
            <button class="btn ghost small" data-act="add-set" data-i="${i}">+ Add set</button>
            ${e.sets.length > 1 && !e.sets[e.sets.length - 1].done ? `<button class="btn ghost small" data-act="drop-set" data-i="${i}">Remove last set</button>` : ""}
          </div>
          <input class="note-input" id="note-${i}" data-note="${i}" placeholder="Note or substitution (goes in the coach's Notes column)" value="${esc(e.note)}">
        </div>`);
    });

    if (!L.isDone(doc)) {
      parts.push(`<button class="btn primary big" data-act="finish" data-key="${key}">Finish session · ${ticked} of ${total} sets</button>`);
      parts.push(`<button class="btn ghost small" data-act="discard" data-key="${key}">${S.confirmDiscard === key ? "Tap again to discard this session" : "Discard session"}</button>`);
    } else {
      parts.push(`<button class="btn ghost small" data-act="reopen" data-key="${key}">Mark as not done</button>`);
    }
    return parts.join("");
  }

  function viewPlan() {
    const next = L.nextSession(S.sessions);
    const cells = [];
    cells.push(`<span></span>${P.SESSIONS.map((s) => `<span class="hd">${s.label}</span>`).join("")}<span class="hd" title="Weekly check-in">CI</span>`);
    for (let w = 1; w <= P.WEEKS; w++) {
      const block = L.blockForWeek(w);
      if (block.weeks[0] === w) cells.push(`<div class="block-sep"><span class="plate b${block.n}"></span>Block ${block.n}: ${esc(block.name)}</div>`);
      cells.push(`<div class="wk">W${w}${L.isLightWeek(w) ? "<small>light opt.</small>" : ""}</div>`);
      for (const s of P.SESSIONS) {
        const key = L.sessionKey(w, s.id);
        const d = S.sessions[key];
        let cls = "cell", sub = "";
        if (L.isDone(d)) { cls += " done"; sub = d.date ? fmtDate(d.date, { month: "numeric", day: "numeric" }) : "✓"; }
        else if (d) { cls += " active"; sub = "started"; }
        if (next && next.key === key) cls += " next";
        cells.push(`<a class="${cls}" href="#s-${key}" style="text-decoration:none;color:inherit" aria-label="${s.label} week ${w}${L.isDone(d) ? ", done" : ""}"><span>${s.label}</span>${sub ? `<small>${sub}</small>` : ""}</a>`);
      }
      const ci = S.checkins["w" + L.pad(w)];
      const due = !ci && L.weekComplete(S.sessions, w);
      const any = L.weekSessions(S.sessions, w).some(L.isDone);
      cells.push(any || ci ? `<a class="ci-dot ${ci ? "done" : due ? "due" : ""}" href="#ci-w${L.pad(w)}" style="display:grid;place-items:center;text-decoration:none" aria-label="Week ${w} check-in">${ci ? "✓" : due ? "!" : "·"}</a>` : `<span></span>`);
    }
    return `${statusBanner()}<section class="hero"><h1>Plan</h1><p class="muted small">Tap any session to do it out of order. Crossed out = done, with the date. The plan moves by sessions, not calendar weeks.</p></section>
      <div class="card board-wrap"><div class="board">${cells.join("")}</div></div>`;
  }

  function viewCalendar() {
    const now = new Date();
    const m = S.calMonth || { y: now.getFullYear(), m: now.getMonth() };
    S.calMonth = m;
    const first = new Date(m.y, m.m, 1);
    const days = new Date(m.y, m.m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Monday first
    const byDate = {};
    for (const [k, d] of Object.entries(S.sessions)) if (d.date) (byDate[d.date] = byDate[d.date] || []).push([k, d]);
    const t = today();
    const cells = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<span class="dow">${d}</span>`);
    for (let i = 0; i < lead; i++) cells.push(`<span class="day empty"></span>`);
    for (let d = 1; d <= days; d++) {
      const ds = `${m.y}-${L.pad(m.m + 1)}-${L.pad(d)}`;
      const list = byDate[ds] || [];
      cells.push(`<button class="day ${ds === t ? "today" : ""} ${S.calSel === ds ? "sel" : ""}" data-act="cal-day" data-d="${ds}"><span class="d">${d}</span>${list.map(([, x]) => `<span class="tag ${L.isDone(x) ? "" : "ip"}">${label(x.sid)}</span>`).join("")}</button>`);
    }
    const sel = S.calSel && byDate[S.calSel];
    const monthName = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const trained = Object.keys(byDate).filter((d) => d.startsWith(`${m.y}-${L.pad(m.m + 1)}`)).length;
    return `${statusBanner()}<section class="hero"><div class="spread"><h1>${esc(monthName)}</h1>
        <div class="row"><button class="btn" data-act="cal-prev" aria-label="Previous month">←</button><button class="btn" data-act="cal-next" aria-label="Next month">→</button></div></div>
        <p class="muted small">${trained} training ${trained === 1 ? "day" : "days"} this month</p></section>
      <div class="card"><div class="cal">${cells.join("")}</div></div>
      ${S.calSel ? `<div class="card"><h3>${fmtDate(S.calSel, { weekday: "long", month: "long", day: "numeric" })}</h3>${sel ? sel.map(([k, x]) => `<a class="spread" href="#s-${k}" style="color:inherit;text-decoration:none"><span><b>${label(x.sid)}</b> <span class="muted small">Week ${x.week}</span></span>${syncPill(x)}</a>`).join("") : `<p class="muted">Nothing logged this day.</p>`}</div>` : ""}`;
  }

  const SORE = ["Shoulder", "Elbow", "Wrist", "Lower back", "Hip", "Knee"];
  function ciDraftFor(week) {
    const id = "w" + L.pad(week);
    if (S.ciDraft && S.ciDraft.week === week) return S.ciDraft;
    const existing = S.checkins[id];
    if (existing) { S.ciDraft = clone(existing); S.ciDraft.adjEdited = true; return S.ciDraft; }
    const auto = L.checkinDraft(S.sessions, week, S.checkins);
    const readiness = auto.readiness != null ? Math.round(auto.readiness) : null;
    S.ciDraft = {
      week, block: L.blockForWeek(week).short, bodyweight: auto.bodyweight, sleep: null,
      readiness, readinessAvg: auto.readiness, stress: null, performance: auto.performance, perfAuto: auto.performance,
      wins: auto.wins, soreness: [], note: "", adjustment: L.adjustmentFor(week, { readiness: auto.readiness, soreness: [] }), adjEdited: false,
    };
    return S.ciDraft;
  }

  function viewCheckin() {
    const w = S.ciWeek;
    if (!w || w < 1 || w > P.WEEKS) return `<div class="card">Unknown week.</div>`;
    const c = ciDraftFor(w);
    const saved = S.checkins["w" + L.pad(w)];
    const chips = (field, sel, auto) => `<div class="chips">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button class="chip ${auto === n && sel === n ? "auto" : ""}" aria-pressed="${sel === n}" data-act="ci-chip" data-f="${field}" data-n="${n}">${n}</button>`).join("")}</div>`;
    let syncLine = "";
    if (saved && saved.sync) {
      if (saved.sync.status === "error") syncLine = `<div class="banner bad"><span>${esc(saved.sync.msg)}</span><button class="btn" data-act="ci-sync" data-id="w${L.pad(w)}">Retry</button></div>`;
      else if (saved.sync.status === "ok") syncLine = `<div class="banner good">Saved and in your sheet (row ${L.checkinRow(w)} of Weekly Check-in).</div>`;
      else if (saved.sync.status === "syncing") syncLine = `<div class="banner info">Writing to your Google Sheet…</div>`;
    }
    return `
      <div class="topbar"><a class="btn ghost" href="#plan">← Plan</a></div>
      <section class="hero"><p class="eyebrow"><span class="plate ${blockClass(w)}"></span>Block ${L.blockForWeek(w).n}</p><h1>Week ${w} check-in</h1>
        <p class="muted small">Dashed numbers were worked out from your logs. Change anything that's off.</p></section>
      ${syncLine}
      <div class="card">
        <div class="grid2">
          <label class="field"><span>Bodyweight (lb)</span><input id="ci-bodyweight" type="number" inputmode="decimal" step="0.1" data-ci="bodyweight" value="${c.bodyweight ?? ""}"></label>
          <label class="field"><span>Sleep average (h)</span><input id="ci-sleep" type="number" inputmode="decimal" step="0.1" data-ci="sleep" value="${c.sleep ?? ""}"></label>
        </div>
        <div class="field"><span>Readiness 1–10${c.readinessAvg != null ? ` <span class="muted small">· your sessions averaged ${num(c.readinessAvg)}</span>` : ""}</span>${chips("readiness", c.readiness, c.readinessAvg != null ? Math.round(c.readinessAvg) : null)}</div>
        <div class="field"><span>Stress 1–10</span>${chips("stress", c.stress, null)}</div>
        <div class="field"><span>Performance 1–10${c.perfAuto != null ? ` <span class="muted small">· from reps and weight vs last time</span>` : ` <span class="muted small">· no earlier week to compare yet</span>`}</span>${chips("performance", c.performance, c.perfAuto)}</div>
        <label class="field"><span>Wins</span><textarea id="ci-wins" rows="2" data-ci="wins">${esc(c.wins)}</textarea></label>
        <div class="field"><span>Soreness / issues</span>
          <div class="chips">${SORE.map((s) => `<button class="chip" aria-pressed="${c.soreness.includes(s)}" data-act="ci-sore" data-s="${esc(s)}">${s}</button>`).join("")}</div>
          <input id="ci-note" class="note-input" data-ci="note" placeholder="Anything else (dictation works here)" value="${esc(c.note)}">
        </div>
        <label class="field"><span>Next-week adjustment</span><textarea id="ci-adjustment" rows="2" data-ci="adjustment">${esc(c.adjustment)}</textarea></label>
        <button class="btn primary big" data-act="ci-save">${saved ? "Update check-in" : "Save check-in"}</button>
      </div>`;
  }

  function viewSheet() {
    const id = sheetId();
    const t = S.sheetTest;
    const doneSessions = Object.values(S.sessions).filter(L.isDone).length;
    return `${statusBanner()}<section class="hero"><h1>Google Sheet</h1><p class="muted small">Each finished session is written to your copy of the coach's sheet: Sets done, Avg reps, Weight and Notes. The Volume column and tracker keep their own formulas.</p></section>
      <div class="card">
        <label class="field"><span>Sheet link</span><input id="sheet-link" placeholder="https://docs.google.com/spreadsheets/d/…" value="${id ? esc("https://docs.google.com/spreadsheets/d/" + id) : ""}"></label>
        <div class="row"><button class="btn primary" data-act="sheet-save">Save link</button><button class="btn" data-act="sheet-test" ${id ? "" : "disabled"}>Test connection</button>
          ${id ? `<a class="btn ghost" href="https://docs.google.com/spreadsheets/d/${esc(id)}/edit" target="_blank" rel="noopener">Open sheet ↗</a>` : ""}</div>
        ${t ? `<div class="banner ${t.ok ? "good" : "bad"}">${esc(t.msg)}</div>` : ""}
        ${!mcp ? `<p class="small muted">Sheet sync runs when this app is open on claude.ai with Google Sheets connected.</p>` : ""}
      </div>
      <div class="card">
        <h3>How numbers are written</h3>
        <ul class="small" style="margin:0;padding-left:18px;display:grid;gap:4px">
          <li>Two-dumbbell lifts: you log the weight of one dumbbell; the sheet gets both added together.</li>
          <li>One-sided moves (single-arm, single-leg, "/ leg"): you log reps per side; the sheet gets both sides added.</li>
          <li>Avg reps is the average over the sets you ticked. If the weight changed between sets, Weight is the average that keeps Volume exact.</li>
        </ul>
      </div>
      <div class="card">
        <h3>Resync everything</h3>
        <p class="small muted">Rewrites all ${doneSessions} finished sessions and saved check-ins to the sheet. Use it after changing the link.</p>
        <button class="btn" data-act="resync" ${id && doneSessions ? "" : "disabled"}>Resync all</button>
      </div>`;
  }

  // ---------- render ----------
  const ICONS = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h3v4H3zM18 10h3v4h-3zM6 8h3v8H6zM15 8h3v8h-3zM9 12h6"/></svg>',
    plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/></svg>',
  };
  function tabs() {
    const cur = S.view === "session" ? "today" : S.view === "checkin" ? "plan" : S.view;
    const t = (id, txt) => `<a href="#${id}" ${cur === id ? 'aria-current="page"' : ""}>${ICONS[id]}${txt}</a>`;
    return `<nav class="tabs">${t("today", "Today")}${t("plan", "Plan")}${t("calendar", "Calendar")}${t("sheet", "Sheet")}</nav>`;
  }

  function render() {
    let body;
    if (S.view === "session") body = viewSession();
    else if (S.view === "plan") body = viewPlan();
    else if (S.view === "calendar") body = viewCalendar();
    else if (S.view === "checkin") body = viewCheckin();
    else if (S.view === "sheet") body = viewSheet();
    else body = viewToday();
    app.innerHTML = `<main class="wrap ${S.timer ? "with-timer" : ""}">${body}</main>${tabs()}<div id="timer-slot"></div><div id="toast-slot"></div>`;
    renderTimer();
    renderToast();
  }
  function renderStatusOnly() { scheduleRender(); }

  function renderTimer() {
    const slot = document.getElementById("timer-slot");
    if (!slot) return;
    if (!S.timer) { slot.innerHTML = ""; return; }
    const left = Math.round((S.timer.end - Date.now()) / 1000);
    const a = Math.abs(left);
    const txt = `${left < 0 ? "+" : ""}${Math.floor(a / 60)}:${L.pad(a % 60)}`;
    const pct = Math.max(0, Math.min(100, (1 - left / S.timer.total) * 100));
    slot.innerHTML = `<div class="timer ${left <= 0 ? "over" : ""}" role="timer" aria-live="off"><span class="bar" style="width:${pct}%"></span><span class="t">${txt}</span><span class="lbl">${left <= 0 ? "Rest over. Next set." : "Rest · " + esc(S.timer.what)}</span><button data-act="timer-add">+30 s</button><button data-act="timer-skip">Skip</button></div>`;
  }
  function renderToast() {
    const slot = document.getElementById("toast-slot");
    if (slot) slot.innerHTML = S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : "";
  }

  // ---------- actions ----------
  function sessionDoc() { return S.sessions[S.key]; }
  function touch() { const d = sessionDoc(); if (d) d.editedAt = nowIso(); save("sessions/" + S.key); }

  app.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const i = Number(el.dataset.i), j = Number(el.dataset.j);
    const doc = S.view === "session" ? sessionDoc() : null;
    switch (act) {
      case "retry-save": retryDirty(); break;
      case "retry-all": retryAll(); break;
      case "start": {
        const { week, sid } = L.parseKey(el.dataset.key);
        const lightBox = document.getElementById("light-start");
        S.sessions[el.dataset.key] = L.newSessionDoc(week, sid, S.sessions, { date: today(), now: nowIso(), light: !!(lightBox && lightBox.checked) });
        save("sessions/" + el.dataset.key);
        render();
        break;
      }
      case "ready": doc.readiness = Number(el.dataset.n); touch(); render(); break;
      case "step": {
        const s = doc.ex[i].sets[j];
        const f = el.dataset.f, d = Number(el.dataset.d);
        const base = s[f] == null ? 0 : s[f];
        s[f] = Math.max(0, Math.round((base + d) * 10) / 10);
        touch(); render();
        break;
      }
      case "tick": {
        const s = doc.ex[i].sets[j];
        if (!s.done && (s.w == null || s.r == null || s.r <= 0)) { toast("Enter weight and reps first."); break; }
        s.done = !s.done;
        // Ticking a set copies its numbers into later untouched sets.
        if (s.done) for (let k = j + 1; k < doc.ex[i].sets.length; k++) { const n = doc.ex[i].sets[k]; if (!n.done && n.w == null) n.w = s.w; }
        touch();
        if (s.done && !L.isDone(doc)) {
          const lastOfAll = doc.ex.every((e) => e.sets.every((x) => x.done));
          if (!lastOfAll) startTimer(i === 0 ? 150 : 90, doc.ex[i].name);
          else S.timer = null;
        }
        render();
        break;
      }
      case "add-set": {
        const sets = doc.ex[i].sets;
        const lastSet = sets[sets.length - 1] || { w: null, r: null };
        sets.push({ w: lastSet.w, r: lastSet.r, done: false });
        touch(); render();
        break;
      }
      case "drop-set": doc.ex[i].sets.pop(); touch(); render(); break;
      case "finish": {
        doc.status = "done";
        doc.completedAt = nowIso();
        if (!doc.date) doc.date = today();
        S.timer = null;
        touch();
        syncSession(S.key);
        toast(`${label(doc.sid)} saved. Writing it to your sheet.`);
        go("today");
        break;
      }
      case "discard": {
        if (S.confirmDiscard !== el.dataset.key) { S.confirmDiscard = el.dataset.key; render(); break; }
        S.confirmDiscard = null;
        delete S.sessions[el.dataset.key];
        if (db) db.doc("sessions/" + el.dataset.key).delete().catch(() => toast("Couldn't delete online; try again with a connection."));
        delete S.dirty["sessions/" + el.dataset.key];
        backup();
        S.timer = null;
        go("today");
        break;
      }
      case "reopen": doc.status = "in_progress"; doc.completedAt = null; touch(); render(); break;
      case "sync": syncSession(el.dataset.key); break;
      case "timer-add": if (S.timer) { S.timer.end += 30000; S.timer.total += 30; S.timer.buzzed = false; tickTimer(); } break;
      case "timer-skip": S.timer = null; render(); break;
      case "cal-prev": case "cal-next": {
        const m = S.calMonth; const d = new Date(m.y, m.m + (act === "cal-next" ? 1 : -1), 1);
        S.calMonth = { y: d.getFullYear(), m: d.getMonth() }; S.calSel = null; render();
        break;
      }
      case "cal-day": S.calSel = S.calSel === el.dataset.d ? null : el.dataset.d; render(); break;
      case "ci-chip": {
        const c = S.ciDraft; const n = Number(el.dataset.n);
        c[el.dataset.f] = c[el.dataset.f] === n ? null : n;
        if (!c.adjEdited) c.adjustment = L.adjustmentFor(c.week, { readiness: c.readiness, soreness: c.soreness });
        render();
        break;
      }
      case "ci-sore": {
        const c = S.ciDraft; const s = el.dataset.s;
        c.soreness = c.soreness.includes(s) ? c.soreness.filter((x) => x !== s) : c.soreness.concat(s);
        if (!c.adjEdited) c.adjustment = L.adjustmentFor(c.week, { readiness: c.readiness, soreness: c.soreness });
        render();
        break;
      }
      case "ci-save": {
        const c = clone(S.ciDraft);
        delete c.adjEdited;
        const id = "w" + L.pad(c.week);
        c.savedAt = nowIso();
        S.checkins[id] = c;
        save("checkins/" + id);
        S.ciDraft = null;
        syncCheckin(id);
        toast(`Week ${c.week} check-in saved.`);
        break;
      }
      case "ci-sync": syncCheckin(el.dataset.id); break;
      case "sheet-save": {
        const v = (document.getElementById("sheet-link").value || "").trim();
        const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(v) || /^([a-zA-Z0-9_-]{25,})$/.exec(v);
        if (!m) { S.sheetTest = { ok: false, msg: "That doesn't look like a Google Sheets link. Copy it from the browser's address bar." }; render(); break; }
        S.settings = Object.assign({}, S.settings, { spreadsheetId: m[1] });
        save("meta/settings");
        S.sheetTest = { ok: true, msg: "Link saved." };
        render();
        break;
      }
      case "sheet-test": testSheet(); break;
      case "resync": resyncAll(); break;
    }
  });

  app.addEventListener("change", (ev) => {
    const el = ev.target;
    if (S.view === "session" && el.dataset.f) {
      const doc = sessionDoc();
      const s = doc.ex[Number(el.dataset.i)].sets[Number(el.dataset.j)];
      const v = el.value === "" ? null : Math.max(0, Number(el.value));
      s[el.dataset.f] = Number.isFinite(v) ? v : null;
      touch(); scheduleRender();
    } else if (S.view === "session" && el.dataset.note != null) {
      sessionDoc().ex[Number(el.dataset.note)].note = el.value.trim();
      touch();
    } else if (S.view === "session" && el.id === "light-toggle") {
      S.sessions[S.key] = L.applyLight(sessionDoc(), el.checked);
      touch(); render();
    } else if (S.view === "checkin" && el.dataset.ci) {
      const f = el.dataset.ci;
      S.ciDraft[f] = el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value;
      if (f === "adjustment") S.ciDraft.adjEdited = true;
    }
  });

  async function testSheet() {
    S.sheetTest = { ok: true, msg: "Checking…" }; render();
    try {
      const v = valuesOf(await sheetCall("get_values", { spreadsheetId: sheetId(), range: "'Program Overview'!A1" }));
      const title = v[0] && v[0][0];
      S.sheetTest = title ? { ok: true, msg: `Connected: "${title}".` } : { ok: false, msg: "Connected, but the Program Overview tab is empty. Is this the coach's sheet?" };
    } catch (e) {
      S.sheetTest = { ok: false, msg: e && e.code === "tool_error" && /Office file/i.test(e.message || "") ? "This is still an .xlsx file. In Google Sheets use File → Save as Google Sheets, then paste the new link." : sheetErrorText(e) };
    }
    render();
  }

  async function resyncAll() {
    for (const s of L.SEQ) if (L.isDone(S.sessions[s.key])) await syncSession(s.key);
    for (const id of Object.keys(S.checkins).sort()) await syncCheckin(id);
    toast("Resync finished.");
  }

  // ---------- boot ----------
  route();
  if (window.claude && window.claude.use) { connect(); connectMcp(); }
  else { S.dbState = "local"; const local = lsGet(LOCAL_KEY); if (local) { S.sessions = local.sessions || {}; S.checkins = local.checkins || {}; S.settings = local.settings || null; } render(); }
})();
