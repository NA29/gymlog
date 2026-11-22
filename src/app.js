// Gym logger UI. Data lives in the artifact's database (collections
// `sessions`, `checkins`, `meta`); each finished session and check-in is
// also written to the coach's Google Sheet through the viewer's connector.
(function () {
  const L = window.GymLogic;
  const P = L.PLAN;
  const I = window.GymIcon;
  const SHEETS = "Google Sheets";
  const BACKUP_KEY = "gymlog-unsaved-v1";
  const LOCAL_KEY = "gymlog-local-v1";

  const S = {
    sessions: {}, checkins: {}, settings: null,
    dbState: "loading", // loading | ok | slow | local
    dirty: {}, saveError: null,
    view: "today", key: null, ciWeek: null, ciDraft: null,
    open: {}, // session key -> index of the expanded exercise
    calMonth: null, calSel: null,
    timer: null, toast: null, sheetTest: null, confirm: null,
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
  const rng = (r) => String(r || "").replace(/[–—]/g, "-").replace(/\s*\/\s*leg/, " per leg");
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const fmtDate = (d, opts = { month: "short", day: "numeric" }) => (d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, opts) : "");
  const label = (sid) => L.sessionMeta(sid).label;
  const seqIndex = (key) => L.ORDER[key] + 1;

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
      scheduleRender();
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

  function loadLocal() {
    const local = lsGet(LOCAL_KEY);
    if (local) { S.sessions = local.sessions || {}; S.checkins = local.checkins || {}; S.settings = local.settings || null; }
    S.dbState = "local";
  }

  async function connect() {
    const loadTimer = setTimeout(() => { if (S.dbState === "loading") { S.dbState = "slow"; render(); } }, 10000);
    try { db = await window.claude.use("db"); } catch (e) { db = null; }
    if (!db) { clearTimeout(loadTimer); loadLocal(); render(); return; }
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
    scheduleRender();
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
    switch (e && e.code) {
      case "no_mcp": return "Sheet sync runs when the app is open in claude.ai.";
      case "no_sheet": return "Add your sheet link in the Sheet tab.";
      case "needs_reauth": return "Reconnect Google Sheets in claude.ai Settings, Connectors.";
      case "server_not_connected": return "Connect Google Sheets in claude.ai Settings, Connectors.";
      case "selection_required": return "Choose which Google Sheets account to use when claude.ai asks.";
      case "not_in_manifest": return "Google Sheets is turned off for this app. Turn it on in the artifact's Permissions menu.";
      case "approval_required": return "Allow Google Sheets when claude.ai asks, then retry.";
      case "blocked_by_policy": return "Your organization blocks Google Sheets here.";
      case "server_unavailable": case "upstream_error": return "Google Sheets didn't respond. Your log is saved.";
      case "tool_error": return "Google Sheets refused the write: " + String(e.message || "").slice(0, 160);
      default: return (e && e.message) || "Sheet sync failed. Your log is saved.";
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
    scheduleRender();
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
    scheduleRender();
  }

  async function syncCheckin(id) {
    const c = S.checkins[id];
    if (!c) return;
    c.sync = { status: "syncing" };
    inflight["checkins/" + id] = true;
    scheduleRender();
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
    scheduleRender();
  }

  function syncState(d) {
    const s = d && d.sync;
    if (!s || s.status === "never") return "none";
    if (s.status === "ok" && (d.editedAt || "") > (s.at || "")) return "edited";
    return s.status; // ok | imported | syncing | error
  }
  function unsynced() {
    const s = Object.entries(S.sessions).filter(([, d]) => L.isDone(d) && syncState(d) === "error").map(([k]) => ["s", k]);
    const c = Object.entries(S.checkins).filter(([, d]) => syncState(d) === "error").map(([k]) => ["c", k]);
    return s.concat(c);
  }
  async function retryAll() {
    for (const [kind, k] of unsynced()) { if (kind === "s") await syncSession(k); else await syncCheckin(k); }
  }

  // ---------- rest timer ----------
  function startTimer(seconds, what) {
    S.timer = { end: Date.now() + seconds * 1000, total: seconds, what };
    render();
    tickTimer();
  }
  function tickTimer() {
    clearTimeout(tickTimer.t);
    if (!S.timer) return;
    const left = Math.round((S.timer.end - Date.now()) / 1000);
    if (left <= 0 && !S.timer.buzzed) { S.timer.buzzed = true; try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* not allowed */ } }
    if (left < -90) { S.timer = null; render(); return; }
    renderTimer();
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
    S.confirm = null;
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

  // ---------- shared pieces ----------
  // One notice at most: the most important thing that needs attention.
  function notice() {
    if (S.dbState === "local") return `<div class="notice warn">${I("cloud-slash")}<span class="grow">Open this app on claude.ai to save your logs online. For now they're only kept in this browser.</span></div>`;
    if (S.dbState === "slow") return `<div class="notice warn">${I("cloud-slash")}<span class="grow">Can't reach your saved logs yet. Anything you log stays on this phone until it saves.</span></div>`;
    if (S.saveError) return `<div class="notice warn">${I("cloud-slash")}<span class="grow">Offline. Your sets are kept on this phone and save when you're back online.</span><button class="btn small" data-act="retry-save">Retry</button></div>`;
    const pend = unsynced();
    if (pend.length) return `<div class="notice danger">${I("warning-circle")}<span class="grow">${pend.length === 1 ? "1 entry isn't" : pend.length + " entries aren't"} in your sheet yet.</span><button class="btn small" data-act="retry-all">Retry</button></div>`;
    return "";
  }

  function syncIcon(d) {
    const s = syncState(d);
    if (s === "ok" || s === "imported") return `<span class="status-ok" title="In your sheet">${I("check-circle")}</span>`;
    if (s === "error") return `<span class="status-bad" title="Not in your sheet">${I("warning-circle")}</span>`;
    if (s === "syncing") return `<span class="status-pending" title="Writing to your sheet">${I("arrow-clockwise")}</span>`;
    if (s === "edited") return `<span class="status-pending" title="Edited since last sync">${I("arrow-clockwise")}</span>`;
    return "";
  }

  const ICON_TABS = { today: "barbell", plan: "squares-four", calendar: "calendar-blank", sheet: "table" };
  function tabs() {
    const cur = S.view === "checkin" ? "plan" : S.view;
    const t = (id, txt) => `<a href="#${id}" ${cur === id ? 'aria-current="page"' : ""}>${I(ICON_TABS[id])}${txt}</a>`;
    return `<nav class="bar tabs" aria-label="Sections">${t("today", "Today")}${t("plan", "Plan")}${t("calendar", "Calendar")}${t("sheet", "Sheet")}</nav>`;
  }

  // ---------- Today ----------
  function viewToday() {
    if (S.dbState === "loading") {
      return `<section class="head"><div class="sk" style="height:18px;width:30%"></div><div class="sk" style="height:38px;width:55%"></div></section>
        <div class="sk" style="height:6px"></div><div class="sk" style="height:268px;border-radius:16px"></div><div class="sk" style="height:54px;border-radius:12px"></div>`;
    }
    const next = L.nextSession(S.sessions);
    const parts = [notice()];
    if (!sheetId() && S.dbState !== "local") parts.push(`<a class="notice" href="#sheet">${I("table")}<span class="grow">Connect your Google Sheet to copy finished sessions into the coach's file.</span>${I("caret-right")}</a>`);

    if (!next) {
      parts.push(`<div class="empty"><h1>Plan complete</h1><p class="sub">All 72 sessions are logged and in your sheet.</p></div>`);
      return parts.join("");
    }

    const block = L.blockForWeek(next.week);
    const doc = S.sessions[next.key];
    const ts = L.todayStatus(S.sessions, today());
    const pres = L.prescription(next.week, next.sid, doc ? doc.light : false);

    const strip = P.SESSIONS.map((s) => {
      const k = L.sessionKey(next.week, s.id), d = S.sessions[k];
      const cls = L.isDone(d) ? "done" : k === next.key ? "next" : d ? "active" : "";
      return `<a class="slot ${cls}" href="#s-${k}"><i></i>${s.label}</a>`;
    }).join("");

    let hint = "";
    if (ts.kind === "doneToday") hint = `<p class="hint-line">${I("check-circle")}<span>You trained today (${ts.sessions.map((d) => label(d.sid)).join(", ")}). ${label(next.sid)} is ready when you are.</span></p>`;
    else if (ts.kind === "rest") hint = `<p class="hint-line">${I("moon-stars")}<span>The plan has a rest day after ${label(ts.after.sid)}. Train anyway if you feel recovered.</span></p>`;
    else if (L.isLightWeek(next.week)) hint = `<p class="hint-line">${I("timer")}<span>Week ${next.week} can be a lighter week. You'll get the option when you start.</span></p>`;

    parts.push(`
      <section class="head">
        <p class="kicker">Week ${next.week} of 12</p>
        <h1>${label(next.sid)}</h1>
        <p class="meta">Session ${seqIndex(next.key)} of 72. Block ${block.n}, ${esc(block.name)}.</p>
      </section>
      <nav class="week-strip" aria-label="This week">${strip}</nav>
      ${hint}
      <section>
        <div class="group">${pres.map((e) => `<div class="row"><span class="grow"><span>${esc(e.name)}</span></span><span class="end num">${e.sets} × ${esc(rng(e.range))}</span></div>`).join("")}</div>
        <a class="btn primary block" href="#s-${next.key}">${doc ? "Continue " : "Start "}${label(next.sid)}</a>
      </section>`);

    for (let w = P.WEEKS; w >= 1; w--) {
      if (L.weekComplete(S.sessions, w)) {
        if (!S.checkins["w" + L.pad(w)]) {
          parts.push(`<section><p class="group-label">Weekly check-in</p><a class="group row" href="#ci-w${L.pad(w)}"><span class="grow"><span>Week ${w} is done</span><span class="meta">Takes about 30 seconds. Most of it is filled in from your logs.</span></span>${I("caret-right")}</a></section>`);
        }
        break;
      }
    }

    const recent = L.SEQ.map((s) => [s.key, S.sessions[s.key]]).filter(([, d]) => L.isDone(d))
      .sort((a, b) => (b[1].completedAt || "").localeCompare(a[1].completedAt || "")).slice(0, 4);
    if (recent.length) {
      parts.push(`<section><p class="group-label">Recent</p><div class="group">${recent.map(([k, d]) => `
        <a class="row" href="#s-${k}"><span class="grow"><span>${label(d.sid)}</span><span class="meta">Week ${d.week}${d.date ? ", " + fmtDate(d.date) : ""}</span></span><span class="end">${syncIcon(d)}${I("caret-right")}</span></a>`).join("")}</div></section>`);
    }
    return parts.join("");
  }

  // ---------- Session ----------
  function exSummary(e) {
    const done = e.sets.filter((s) => s.done && s.r > 0);
    if (!done.length) return "";
    const ws = [...new Set(done.map((s) => s.w))];
    const reps = done.map((s) => s.r);
    const sameReps = reps.every((r) => r === reps[0]);
    return `${sameReps ? done.length + " × " + reps[0] : reps.join(", ")} @ ${ws.length === 1 ? num(ws[0]) : num(Math.min(...ws)) + "-" + num(Math.max(...ws))}`;
  }

  function openIndex(doc) {
    if (S.key in S.open) return S.open[S.key];
    if (L.isDone(doc)) return -1;
    const i = doc.ex.findIndex((e) => e.sets.some((s) => !s.done));
    return i;
  }

  function viewSession() {
    const key = S.key;
    const meta = L.parseKey(key);
    const block = L.blockForWeek(meta.week);
    const doc = S.sessions[key];
    const head = `
      <div class="topbar"><a href="#today">${I("caret-left")}Today</a></div>
      <section class="head">
        <p class="kicker">Week ${meta.week}, block ${block.n}</p>
        <h1>${label(meta.sid)}</h1>
        ${doc && doc.date ? `<p class="meta">${fmtDate(doc.date, { weekday: "long", month: "long", day: "numeric" })}${doc.readiness != null ? `. Readiness ${doc.readiness}` : ""}</p>` : ""}
      </section>`;

    if (!doc) {
      const pres = L.prescription(meta.week, meta.sid, false);
      const next = L.nextSession(S.sessions);
      const outOfOrder = next && next.key !== key;
      return head + notice() + `
        ${outOfOrder ? `<p class="hint-line">${I("squares-four")}<span>Out of order: ${label(next.sid)}, week ${next.week} stays next in the plan.</span></p>` : ""}
        <section><div class="group">${pres.map((e) => {
          const last = L.lastPerformance(S.sessions, e.name, key);
          return `<div class="row"><span class="grow"><span>${esc(e.name)}</span>${last ? `<span class="meta num">Last ${esc(L.describeSets(last.sets))}</span>` : ""}</span><span class="end num">${e.sets} × ${esc(rng(e.range))}</span></div>`;
        }).join("")}</div></section>
        ${L.isLightWeek(meta.week) ? `<div class="group row switch-row"><span class="grow"><span>Lighter week</span><span class="meta">One fewer set on exercises with 3 or more</span></span><label class="switch"><input type="checkbox" id="light-start" aria-label="Lighter week"><span></span></label></div>` : ""}`;
    }

    const plan = L.prescription(meta.week, meta.sid, doc.light);
    const open = openIndex(doc);
    const parts = [head, notice()];

    if (L.isDone(doc)) {
      const st = syncState(doc), s = doc.sync || {};
      if (st === "error") parts.push(`<div class="notice danger">${I("warning-circle")}<span class="grow">${esc(s.msg)}</span><button class="btn small" data-act="sync" data-key="${key}">Retry</button></div>`);
      else if (st === "syncing") parts.push(`<div class="notice">${I("arrow-clockwise")}<span class="grow">Writing to your sheet</span></div>`);
      else if (st === "edited" || st === "none") parts.push(`<div class="notice warn">${I("arrow-clockwise")}<span class="grow">Your changes aren't in the sheet yet.</span><button class="btn small" data-act="sync" data-key="${key}">Update sheet</button></div>`);
      else if (st === "imported") parts.push(`<div class="notice done">${I("check-circle")}<span class="grow">Imported from your sheet.</span></div>`);
      else parts.push(`<div class="notice done">${I("check-circle")}<span class="grow">Done and in your sheet.</span></div>`);
    } else {
      if (doc.readiness == null) {
        parts.push(`<section><p class="group-label">How ready do you feel?</p><div class="seg" role="group" aria-label="Readiness from 1 to 10">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button data-act="ready" data-n="${n}" aria-pressed="false">${n}</button>`).join("")}</div></section>`);
      }
      if (L.isLightWeek(meta.week)) {
        parts.push(`<div class="group row switch-row"><span class="grow"><span>Lighter week</span><span class="meta">One fewer set on exercises with 3 or more</span></span><label class="switch"><input type="checkbox" id="light-toggle" ${doc.light ? "checked" : ""} aria-label="Lighter week"><span></span></label></div>`);
      }
    }

    const exHtml = doc.ex.map((e, i) => {
      const p = plan[i] || { name: e.name, range: "", sets: e.sets.length, muscle: "" };
      const kind = L.exerciseKind(e.name, p.range);
      const doneN = e.sets.filter((s) => s.done).length;
      const ring = doneN === e.sets.length && doneN > 0 ? `<span class="ring full">${I("check")}</span>` : `<span class="ring ${doneN ? "part" : ""} num">${doneN}/${e.sets.length}</span>`;
      const isOpen = i === open;
      const sumLine = exSummary(e) || `${p.sets} × ${rng(p.range)}`;
      let body = "";
      if (isOpen) {
        const last = L.lastPerformance(S.sessions, e.name, key);
        const sug = L.suggest(p, last);
        const { hi } = L.repBounds(p.range);
        const advice = last
          ? `<p>Last time: <span class="num">${esc(L.describeSets(last.sets))}</span></p><p class="${sug.progress ? "go" : ""}">${sug.progress ? `You hit ${hi} on every set. Weight goes up to ${num(sug.weight)}.` : `Aim for ${hi} reps on every set, then add weight.`}</p>`
          : `<p>First time. Pick a weight you can control for ${esc(rng(p.range))} reps.</p>`;
        body = `<div class="ex-body">
          <div class="advice">${advice}<p class="meta">${p.muscle}. Rest ${i === 0 ? "2-3 min" : "60-120 s"}.</p></div>
          <div class="sets">
            <div class="set-head"><span>Set</span><span>${kind.pairedDB ? "lb per dumbbell" : "lb"}</span><span>${kind.unilateral ? "Reps per side" : "Reps"}</span><span></span></div>
            ${e.sets.map((s, j) => `
              <div class="set ${s.done ? "done" : ""}">
                <span class="n">${j + 1}</span>
                <input class="field-num" id="w-${i}-${j}" type="number" inputmode="decimal" step="0.5" min="0" placeholder="0" value="${s.w == null ? "" : s.w}" data-i="${i}" data-j="${j}" data-f="w" aria-label="Set ${j + 1} weight">
                <input class="field-num" id="r-${i}-${j}" type="number" inputmode="numeric" step="1" min="0" placeholder="0" value="${s.r == null ? "" : s.r}" data-i="${i}" data-j="${j}" data-f="r" aria-label="Set ${j + 1} reps">
                <button class="tick" data-act="tick" data-i="${i}" data-j="${j}" aria-pressed="${s.done}" aria-label="Set ${j + 1} done">${I("check")}</button>
              </div>`).join("")}
          </div>
          <div class="ex-tools">
            <button class="btn small quiet" data-act="add-set" data-i="${i}">${I("plus")}Add set</button>
            ${e.sets.length > 1 && !e.sets[e.sets.length - 1].done ? `<button class="btn small quiet" data-act="drop-set" data-i="${i}">${I("minus")}Remove set</button>` : ""}
          </div>
          <label class="label"><span>Note</span><input class="text-in" id="note-${i}" data-note="${i}" placeholder="Substitution, machine setting, how it felt" value="${esc(e.note)}"></label>
        </div>`;
      }
      return `<div class="ex ${isOpen ? "open" : ""}" id="ex-${i}">
        <button class="ex-sum" data-act="toggle-ex" data-i="${i}" aria-expanded="${isOpen}">${ring}<span class="grow"><span class="name">${esc(e.name)}</span><span class="meta num">${esc(sumLine)}</span></span><span class="caret">${I("caret-down")}</span></button>
        ${body}
      </div>`;
    }).join("");
    parts.push(`<section>${exHtml}</section>`);

    if (!L.isDone(doc)) {
      parts.push(`<div class="danger-zone"><button class="btn small quiet danger" data-act="discard" data-key="${key}">${S.confirm === "discard" ? "Tap again to discard" : "Discard session"}</button></div>`);
    } else {
      parts.push(`<div class="danger-zone"><button class="btn small quiet" data-act="reopen" data-key="${key}">Mark as not done</button></div>`);
    }
    return parts.join("");
  }

  function sessionBar() {
    const doc = S.sessions[S.key];
    const meta = L.parseKey(S.key);
    if (!doc) return `<div class="bar"><div class="bar-inner"><button class="btn primary block" data-act="start" data-key="${S.key}">Start ${label(meta.sid)}</button></div></div>`;
    if (S.timer) return `<div class="bar"><div class="bar-inner" id="timer-slot"></div></div>`;
    if (L.isDone(doc)) return "";
    const total = doc.ex.reduce((a, e) => a + e.sets.length, 0);
    const ticked = doc.ex.reduce((a, e) => a + e.sets.filter((s) => s.done).length, 0);
    return `<div class="bar"><div class="bar-inner"><button class="btn primary block" data-act="finish" data-key="${S.key}">Finish workout<span class="num" style="opacity:.6;font-weight:500">${ticked}/${total}</span></button></div></div>`;
  }

  // ---------- Plan ----------
  function viewPlan() {
    const next = L.nextSession(S.sessions);
    const blocks = P.BLOCKS.map((block) => {
      const rows = block.weeks.map((w) => {
        const ci = S.checkins["w" + L.pad(w)];
        const due = !ci && L.weekComplete(S.sessions, w);
        let ciHtml = "";
        if (ci) ciHtml = `<a class="ci-ok" href="#ci-w${L.pad(w)}" aria-label="Week ${w} check-in done">${I("check-circle")}</a>`;
        else if (due) ciHtml = `<a href="#ci-w${L.pad(w)}">Check in</a>`;
        else if (L.isLightWeek(w)) ciHtml = `<small>light</small>`;
        const wk = `<div class="wk">W${w}${ciHtml}</div>`;
        const cells = P.SESSIONS.map((s) => {
          const key = L.sessionKey(w, s.id);
          const d = S.sessions[key];
          let cls = "cell", inner = "";
          if (L.isDone(d)) { cls += " done"; inner = d.date ? `${I("check")}<span>${fmtDate(d.date, { month: "numeric", day: "numeric" })}</span>` : I("check"); }
          else if (d) { cls += " active"; inner = "Started"; }
          else if (next && next.key === key) { cls += " next"; inner = "Next"; }
          return `<a class="${cls}" href="#s-${key}" aria-label="${s.label}, week ${w}${L.isDone(d) ? ", done" : ""}">${inner}</a>`;
        }).join("");
        return wk + cells;
      }).join("");
      return `<section><div class="head"><h2>Block ${block.n}</h2><p class="meta">${esc(block.name)}, weeks ${block.weeks[0]}-${block.weeks[3]}</p></div>
        <div class="board"><span></span>${P.SESSIONS.map((s) => `<span class="hd">${s.label}</span>`).join("")}${rows}</div></section>`;
    }).join("");
    const doneCount = L.SEQ.filter((s) => L.isDone(S.sessions[s.key])).length;
    return `${notice()}<section class="head"><h1>Plan</h1><p class="sub">${doneCount} of 72 sessions done. Tap any session to log it, even out of order.</p></section>
      <div class="legend"><span><i class="l-done"></i>Done</span><span><i class="l-next"></i>Next</span><span><i></i>To do</span></div>
      ${blocks}`;
  }

  // ---------- Calendar ----------
  function viewCalendar() {
    const now = new Date();
    const m = S.calMonth || { y: now.getFullYear(), m: now.getMonth() };
    S.calMonth = m;
    const first = new Date(m.y, m.m, 1);
    const days = new Date(m.y, m.m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // weeks start Monday
    const byDate = {};
    for (const [k, d] of Object.entries(S.sessions)) if (d.date) (byDate[d.date] = byDate[d.date] || []).push([k, d]);
    const t = today();
    const cells = ["M", "T", "W", "T", "F", "S", "S"].map((d) => `<span class="dow">${d}</span>`);
    for (let i = 0; i < lead; i++) cells.push(`<span></span>`);
    for (let d = 1; d <= days; d++) {
      const ds = `${m.y}-${L.pad(m.m + 1)}-${L.pad(d)}`;
      const list = byDate[ds] || [];
      const cls = ["day", ds === t ? "today" : "", list.length ? "has" : "", list.length && !list.every(([, x]) => L.isDone(x)) ? "ip" : "", S.calSel === ds ? "sel" : ""].join(" ");
      cells.push(`<button class="${cls}" data-act="cal-day" data-d="${ds}" ${list.length ? "" : "disabled"} aria-label="${fmtDate(ds, { month: "long", day: "numeric" })}${list.length ? ", " + list.map(([, x]) => label(x.sid)).join(", ") : ""}"><span class="d">${d}</span>${list.map(([, x]) => `<span class="tag">${label(x.sid)}</span>`).join("")}</button>`);
    }
    const sel = S.calSel && byDate[S.calSel];
    const monthName = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const trained = Object.keys(byDate).filter((d) => d.startsWith(`${m.y}-${L.pad(m.m + 1)}`)).length;
    return `${notice()}<section class="head">
        <div class="cal-head"><h1>${esc(monthName)}</h1><div style="display:flex"><button class="icon-btn" data-act="cal-prev" aria-label="Previous month">${I("caret-left")}</button><button class="icon-btn" data-act="cal-next" aria-label="Next month">${I("caret-right")}</button></div></div>
        <p class="sub">${trained ? `${trained} training ${trained === 1 ? "day" : "days"} this month` : "No training logged this month"}</p></section>
      <div class="cal">${cells.join("")}</div>
      ${sel ? `<section><p class="group-label">${fmtDate(S.calSel, { weekday: "long", month: "long", day: "numeric" })}</p><div class="group">${sel.map(([k, x]) => `<a class="row" href="#s-${k}"><span class="grow"><span>${label(x.sid)}</span><span class="meta">Week ${x.week}</span></span><span class="end">${syncIcon(x)}${I("caret-right")}</span></a>`).join("")}</div></section>` : ""}`;
  }

  // ---------- Check-in ----------
  const SORE = ["Shoulder", "Elbow", "Wrist", "Lower back", "Hip", "Knee"];
  function ciDraftFor(week) {
    const id = "w" + L.pad(week);
    if (S.ciDraft && S.ciDraft.week === week) return S.ciDraft;
    const existing = S.checkins[id];
    if (existing) { S.ciDraft = clone(existing); S.ciDraft.adjEdited = true; return S.ciDraft; }
    const auto = L.checkinDraft(S.sessions, week, S.checkins);
    S.ciDraft = {
      week, block: L.blockForWeek(week).short, bodyweight: auto.bodyweight, sleep: null,
      readiness: auto.readiness != null ? Math.round(auto.readiness) : null, readinessAvg: auto.readiness,
      stress: null, performance: auto.performance, perfAuto: auto.performance,
      wins: auto.wins, soreness: [], note: "",
      adjustment: L.adjustmentFor(week, { readiness: auto.readiness, soreness: [] }), adjEdited: false,
    };
    return S.ciDraft;
  }

  function viewCheckin() {
    const w = S.ciWeek;
    if (!w || w < 1 || w > P.WEEKS) return `<div class="empty"><h1>Unknown week</h1><a class="btn" href="#plan">Back to plan</a></div>`;
    const c = ciDraftFor(w);
    const saved = S.checkins["w" + L.pad(w)];
    const seg = (field, name) => `<div class="seg" role="group" aria-label="${name} from 1 to 10">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button aria-pressed="${c[field] === n}" data-act="ci-chip" data-f="${field}" data-n="${n}">${n}</button>`).join("")}</div>`;
    let status = "";
    if (saved) {
      const st = syncState(saved);
      if (st === "error") status = `<div class="notice danger">${I("warning-circle")}<span class="grow">${esc(saved.sync.msg)}</span><button class="btn small" data-act="ci-sync" data-id="w${L.pad(w)}">Retry</button></div>`;
      else if (st === "ok") status = `<div class="notice done">${I("check-circle")}<span class="grow">Saved to row ${L.checkinRow(w)} of Weekly Check-in.</span></div>`;
      else if (st === "syncing") status = `<div class="notice">${I("arrow-clockwise")}<span class="grow">Writing to your sheet</span></div>`;
    }
    return `
      <div class="topbar"><a href="#plan">${I("caret-left")}Plan</a></div>
      <section class="head"><p class="kicker">Block ${L.blockForWeek(w).n}</p><h1>Week ${w} check-in</h1></section>
      ${status}
      <div class="grid2">
        <label class="label"><span>Bodyweight, lb</span><input class="text-in num" id="ci-bodyweight" type="number" inputmode="decimal" step="0.1" data-ci="bodyweight" value="${c.bodyweight ?? ""}"></label>
        <label class="label"><span>Sleep, hours a night</span><input class="text-in num" id="ci-sleep" type="number" inputmode="decimal" step="0.1" data-ci="sleep" value="${c.sleep ?? ""}"></label>
      </div>
      <div class="label"><span>Readiness</span>${seg("readiness", "Readiness")}<p class="help">${c.readinessAvg != null ? `Your sessions averaged ${num(c.readinessAvg)}.` : "1 is exhausted, 10 is fully recovered."}</p></div>
      <div class="label"><span>Stress</span>${seg("stress", "Stress")}<p class="help">1 is calm, 10 is overwhelmed.</p></div>
      <div class="label"><span>Performance</span>${seg("performance", "Performance")}<p class="help">${c.perfAuto != null ? `Suggested ${c.perfAuto} from your reps and weights compared with last time.` : "Nothing to compare with yet, so this one is your call."}</p></div>
      <label class="label"><span>Wins</span><textarea class="text-in" id="ci-wins" rows="2" data-ci="wins">${esc(c.wins)}</textarea></label>
      <div class="label"><span>Soreness or issues</span>
        <div class="chips">${SORE.map((s) => `<button class="chip" aria-pressed="${c.soreness.includes(s)}" data-act="ci-sore" data-s="${esc(s)}">${s}</button>`).join("")}</div>
        <input class="text-in" id="ci-note" data-ci="note" aria-label="Other notes" placeholder="Anything else" value="${esc(c.note)}">
      </div>
      <label class="label"><span>Next week</span><textarea class="text-in" id="ci-adjustment" rows="2" data-ci="adjustment">${esc(c.adjustment)}</textarea><p class="help">Based on the coach's lighter-week rule and your readiness.</p></label>
      <button class="btn primary block" data-act="ci-save">${saved ? "Update check-in" : "Save check-in"}</button>`;
  }

  // ---------- Sheet ----------
  function viewSheet() {
    const id = sheetId();
    const t = S.sheetTest;
    const doneSessions = Object.values(S.sessions).filter(L.isDone).length;
    return `${notice()}<section class="head"><h1>Google Sheet</h1><p class="sub">Finished sessions are copied into your copy of the coach's sheet. Its formulas and volume tracker work as before.</p></section>
      <section>
        <label class="label"><span>Sheet link</span><input class="text-in" id="sheet-link" placeholder="https://docs.google.com/spreadsheets/d/..." value="${id ? esc("https://docs.google.com/spreadsheets/d/" + id) : ""}"></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-act="sheet-save">Save</button><button class="btn" data-act="sheet-test" ${id ? "" : "disabled"}>Test connection</button>
          ${id ? `<a class="btn quiet" href="https://docs.google.com/spreadsheets/d/${esc(id)}/edit" target="_blank" rel="noopener">Open sheet${I("arrow-square-out")}</a>` : ""}</div>
        ${t ? `<div class="notice ${t.ok === true ? "done" : t.ok === false ? "danger" : ""}">${I(t.ok === false ? "warning-circle" : t.ok === true ? "check-circle" : "arrow-clockwise")}<span class="grow">${esc(t.msg)}</span></div>` : ""}
        ${!mcp ? `<p class="help">Sync runs when this app is open on claude.ai with Google Sheets connected.</p>` : ""}
      </section>
      <section>
        <p class="group-label">What gets written</p>
        <div class="group"><div class="row"><ul class="plain">
          <li>Sets done, average reps, weight and your note, for each exercise.</li>
          <li>Dumbbell pairs: you log one dumbbell, the sheet gets both added together.</li>
          <li>Single-arm and single-leg moves: you log reps per side, the sheet gets the total.</li>
          <li>If the weight changed between sets, the sheet gets the average that keeps volume exact.</li>
        </ul></div></div>
      </section>
      <section>
        <p class="group-label">Resync</p>
        <div class="group row"><span class="grow"><span>Rewrite everything</span><span class="meta">${doneSessions} sessions and ${Object.keys(S.checkins).length} check-ins. Use after changing the link.</span></span><button class="btn small" data-act="resync" ${id && doneSessions ? "" : "disabled"}>Resync</button></div>
      </section>`;
  }

  // ---------- render ----------
  function render() {
    let body, bottom;
    if (S.view === "session") { body = viewSession(); bottom = sessionBar(); }
    else {
      bottom = tabs();
      if (S.view === "plan") body = viewPlan();
      else if (S.view === "calendar") body = viewCalendar();
      else if (S.view === "checkin") body = viewCheckin();
      else if (S.view === "sheet") body = viewSheet();
      else body = viewToday();
    }
    app.innerHTML = `<main class="wrap">${body}</main>${bottom}<div id="toast-slot"></div>`;
    renderTimer();
    renderToast();
  }

  function renderTimer() {
    const slot = document.getElementById("timer-slot");
    if (!slot || !S.timer) return;
    const left = Math.round((S.timer.end - Date.now()) / 1000);
    const a = Math.abs(left);
    const txt = `${left < 0 ? "+" : ""}${Math.floor(a / 60)}:${L.pad(a % 60)}`;
    const pct = Math.max(0, Math.min(1, 1 - left / S.timer.total));
    slot.innerHTML = `<div class="timer ${left <= 0 ? "over" : ""}" role="timer"><span class="clock">${txt}</span><span class="what">${left <= 0 ? "Rest is over" : "Rest, then " + esc(S.timer.what)}</span><span class="track"><i style="transform:scaleX(${pct})"></i></span></div>
      <button class="btn" data-act="timer-add">+30 s</button><button class="btn primary" data-act="timer-skip">${left <= 0 ? "Done" : "Skip"}</button>`;
  }
  function renderToast() {
    const slot = document.getElementById("toast-slot");
    if (slot) slot.innerHTML = S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : "";
  }

  // ---------- actions ----------
  function sessionDoc() { return S.sessions[S.key]; }
  function touch() { const d = sessionDoc(); if (d) d.editedAt = nowIso(); save("sessions/" + S.key); }
  function scrollToEx(i) {
    requestAnimationFrame(() => { const el = document.getElementById("ex-" + i); if (el && el.scrollIntoView) el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); });
  }

  document.addEventListener("click", (ev) => {
    const el = ev.target.closest && ev.target.closest("[data-act]");
    if (!el || !(app.contains(el))) return;
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
        delete S.open[el.dataset.key];
        save("sessions/" + el.dataset.key);
        render();
        break;
      }
      case "ready": doc.readiness = Number(el.dataset.n); touch(); render(); break;
      case "toggle-ex": S.open[S.key] = openIndex(doc) === i ? -1 : i; render(); if (S.open[S.key] === i) scrollToEx(i); break;
      case "tick": {
        const ex = doc.ex[i], s = ex.sets[j];
        if (!s.done && (s.w == null || s.r == null || s.r <= 0)) { toast("Enter the weight and reps first"); break; }
        s.done = !s.done;
        // Carry the weight forward to later sets that are still empty.
        if (s.done) for (let k = j + 1; k < ex.sets.length; k++) { const n = ex.sets[k]; if (!n.done && n.w == null) n.w = s.w; }
        touch();
        if (s.done && !L.isDone(doc)) {
          const exDone = ex.sets.every((x) => x.done);
          const nextEx = doc.ex.findIndex((e) => e.sets.some((x) => !x.done));
          if (exDone && nextEx >= 0) { S.open[S.key] = nextEx; }
          if (nextEx >= 0) {
            const upNext = exDone ? doc.ex[nextEx].name : `set ${j + 2}`;
            startTimer(i === 0 ? 150 : 90, upNext);
            if (exDone) scrollToEx(nextEx);
          } else { S.timer = null; render(); }
        } else render();
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
        toast(`${label(doc.sid)} saved`);
        go("today");
        break;
      }
      case "discard": {
        if (S.confirm !== "discard") { S.confirm = "discard"; render(); break; }
        S.confirm = null;
        delete S.sessions[el.dataset.key];
        if (db) db.doc("sessions/" + el.dataset.key).delete().catch(() => toast("Couldn't delete it online. Try again with a connection."));
        delete S.dirty["sessions/" + el.dataset.key];
        backup();
        S.timer = null;
        go("today");
        break;
      }
      case "reopen": doc.status = "in_progress"; doc.completedAt = null; delete S.open[S.key]; touch(); render(); break;
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
        toast(`Week ${c.week} check-in saved`);
        break;
      }
      case "ci-sync": syncCheckin(el.dataset.id); break;
      case "sheet-save": {
        const v = (document.getElementById("sheet-link").value || "").trim();
        const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(v) || /^([a-zA-Z0-9_-]{25,})$/.exec(v);
        if (!m) { S.sheetTest = { ok: false, msg: "That isn't a Google Sheets link. Copy it from the address bar while the sheet is open." }; render(); break; }
        S.settings = Object.assign({}, S.settings, { spreadsheetId: m[1] });
        save("meta/settings");
        S.sheetTest = { ok: true, msg: "Link saved" };
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
    S.sheetTest = { ok: null, msg: "Checking the connection" }; render();
    try {
      const v = valuesOf(await sheetCall("get_values", { spreadsheetId: sheetId(), range: "'Program Overview'!A1" }));
      const title = v[0] && v[0][0];
      S.sheetTest = title ? { ok: true, msg: `Connected to "${title}"` } : { ok: false, msg: "Connected, but the Program Overview tab is empty. Is this the coach's sheet?" };
    } catch (e) {
      S.sheetTest = { ok: false, msg: e && e.code === "tool_error" && /Office file/i.test(e.message || "") ? "This is still an .xlsx file. In Google Sheets choose File, Save as Google Sheets, then paste the new link." : sheetErrorText(e) };
    }
    render();
  }

  async function resyncAll() {
    for (const s of L.SEQ) if (L.isDone(S.sessions[s.key])) await syncSession(s.key);
    for (const id of Object.keys(S.checkins).sort()) await syncCheckin(id);
    toast("Resync finished");
  }

  // ---------- boot ----------
  route();
  if (window.claude && window.claude.use) { connect(); connectMcp(); }
  else { loadLocal(); render(); }
})();
