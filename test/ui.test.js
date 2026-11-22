// Headless run of the real app code against a stub DOM, database and
// Google Sheets connector: start a session, log every set, finish, and
// check what gets written to the sheet.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const appListeners = {}, docListeners = {}, winListeners = {};
  const slots = {};
  const el = (id) => slots[id] || (slots[id] = { id, innerHTML: "", value: "", contains: () => true, addEventListener: (t, f) => (appListeners[t] = f) });
  const store = { "meta/settings": { spreadsheetId: "TEST_SHEET" } };
  const db = {
    collection: (c) => ({
      onSnapshot: (next) => {
        setTimeout(() => next({
          metadata: { fromCache: false },
          docChanges: () => Object.entries(store).filter(([p]) => p.startsWith(c + "/")).map(([p, d]) => ({ type: "added", doc: { id: p.split("/")[1], data: () => d } })),
        }), 1);
        return () => {};
      },
    }),
    doc: (p) => ({
      set: async (d) => { store[p] = d; },
      delete: async () => { delete store[p]; },
      onSnapshot: (next) => { setTimeout(() => next({ exists: !!store[p], data: () => store[p], metadata: { fromCache: false } }), 1); return () => {}; },
    }),
  };
  const calls = [];
  const ctx = {
    console, setTimeout, clearTimeout, JSON, Math, Date, Number, String, Object, Array, RegExp, Promise, Error, Set,
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {}, location: { hash: "" },
    document: { getElementById: el, activeElement: null, addEventListener: (t, f) => (docListeners[t] = f) },
    requestAnimationFrame: (f) => setTimeout(f, 0),
    matchMedia: () => ({ matches: true }),
    scrollTo: () => {},
    addEventListener: (t, f) => (winListeners[t] = f),
  };
  const mcp = {
    callTool: async (server, tool, input) => {
      calls.push({ server, tool, input });
      if (tool !== "get_values") return { payload: { content: { status: "success" } } };
      if (/Program Overview/.test(input.range)) return { payload: { values: [["12-WEEK PUSH / PULL / LEGS PROGRAM"]] } };
      // Column A of a block tab, with the uneven week spacing of the real sheet.
      const L = ctx.GymLogic, a = [];
      const put = (r, v) => { while (a.length < r) a.push([]); a[r - 1] = [v]; };
      const starts = { 1: 7, 2: 57, 3: 106, 4: 157 };
      for (const [w, row] of Object.entries(starts)) {
        put(row, "WEEK " + w);
        let k = row + 1;
        for (const s of L.PLAN.SESSIONS) { put(k++, s.title); put(k++, "Exercise"); for (const e of L.prescription(Number(w), s.id)) put(k++, e.name); k++; }
      }
      return { payload: { values: a } };
    },
  };
  ctx.claude = { use: async (n) => (n === "db" ? db : n === "mcp" ? mcp : null) };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ["plan.js", "icons.js", "logic.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), ctx, { filename: f });
  const html = () => slots.app.innerHTML;
  return {
    ctx, store, calls, html,
    click: (dataset) => docListeners.click({ target: { closest: () => ({ dataset }) } }),
    change: (dataset, value) => appListeners.change({ target: { dataset, value, type: "number" } }),
    nav: (h) => { ctx.location.hash = h; winListeners.hashchange(); },
  };
}

test("log a full session and write it to the sheet", async () => {
  const t = boot();
  await wait(20);
  assert.match(t.html(), /<h1>Push A<\/h1>/);
  assert.match(t.html(), /Start Push A/);

  t.nav("#s-w01-pushA");
  t.click({ act: "start", key: "w01-pushA" });
  assert.match(t.html(), /How ready do you feel/);
  t.click({ act: "ready", n: "7" });
  await wait(5);

  const doc = t.store["sessions/w01-pushA"];
  doc.ex.forEach((e, i) => e.sets.forEach((s, j) => {
    t.change({ f: "w", i, j }, "20");
    t.change({ f: "r", i, j }, "12");
    t.click({ act: "tick", i: String(i), j: String(j) });
  }));
  assert.match(t.html(), /Finish workout<span class="num"[^>]*>14\/14/);

  t.click({ act: "finish", key: "w01-pushA" });
  await wait(30);
  const writes = t.calls.filter((c) => c.tool === "update_values");
  assert.equal(writes[0].server, "Google Sheets");
  assert.equal(writes[0].input.range, "'B1 Arms Shoulders Chest'!E10:I14");
  // Incline Dumbbell Press: 20 lb per dumbbell is written as 40 combined; H (volume formula) untouched.
  assert.equal(JSON.stringify(writes[0].input.values[0]), JSON.stringify([3, 12, 40, null, ""]));
  assert.equal(t.store["sessions/w01-pushA"].sync.status, "ok");
  // Finishing navigates to Today (the stub location doesn't fire hashchange itself).
  assert.equal(t.ctx.location.hash, "today");
  t.nav("#today");
  assert.match(t.html(), /<h1>Pull A<\/h1>/);
});

test("every view renders and the check-in writes its row", async () => {
  const t = boot();
  await wait(20);
  for (const h of ["#plan", "#calendar", "#sheet", "#ci-w01", "#today", "#s-w01-pushA", "#s-w04-legsB"]) {
    t.nav(h);
    assert.match(t.html(), /<main class="wrap">/, h);
    assert.doesNotMatch(t.html(), /undefined|NaN/, h);
  }
  t.nav("#sheet");
  t.click({ act: "sheet-test" });
  await wait(10);
  assert.match(t.html(), /Connected to/);

  t.nav("#ci-w01");
  t.click({ act: "ci-chip", f: "stress", n: "4" });
  t.click({ act: "ci-save" });
  await wait(10);
  const ci = t.calls.filter((c) => /Weekly Check-in/.test(c.input.range || "")).pop();
  assert.equal(ci.input.range, "'Weekly Check-in'!C5:J5");
  assert.equal(ci.input.values[0][3], 4);
});

test("no em or en dashes in anything the app renders", async () => {
  const t = boot();
  await wait(20);
  for (const h of ["#today", "#plan", "#calendar", "#sheet", "#ci-w03", "#s-w02-legsB", "#s-w08-pushA"]) {
    t.nav(h);
    assert.doesNotMatch(t.html().replace(/<svg[\s\S]*?<\/svg>/g, ""), /[—–]/, h);
  }
});

test("log a forgotten session for yesterday", async () => {
  const t = boot();
  await wait(20);
  const L = t.ctx.GymLogic;
  const d = new Date(); d.setDate(d.getDate() - 1);
  const yday = L.localDate(d);

  t.nav("#s-w01-pushA");
  t.click({ act: "start-date", d: yday });
  assert.match(t.html(), /Log Push A for yesterday/);
  t.click({ act: "start", key: "w01-pushA" });
  await wait(5);
  const doc = t.store["sessions/w01-pushA"];
  assert.equal(doc.date, yday);
  assert.match(t.html(), /Yesterday/);

  // Backfilling: ticking a set doesn't start the rest timer.
  t.change({ f: "w", i: 0, j: 0 }, "20");
  t.click({ act: "tick", i: "0", j: "0" });
  assert.doesNotMatch(t.html(), /role="timer"/);

  // Moving a session to another day keeps it out of "trained today".
  t.click({ act: "finish", key: "w01-pushA" });
  await wait(20);
  t.nav("#today");
  assert.doesNotMatch(t.html(), /You trained today/);
});

test("calendar logs the next session on a past day", async () => {
  const t = boot();
  await wait(20);
  const L = t.ctx.GymLogic;
  const d = new Date(); d.setDate(d.getDate() - 3);
  const ds = L.localDate(d);
  t.nav("#calendar");
  t.click({ act: "cal-day", d: ds });
  assert.match(t.html(), /Log Push A/);
  t.click({ act: "log-on", d: ds });
  assert.equal(t.ctx.location.hash, "s-w01-pushA");
  t.nav("#s-w01-pushA");
  t.click({ act: "start", key: "w01-pushA" });
  await wait(5);
  assert.equal(t.store["sessions/w01-pushA"].date, ds);
});
