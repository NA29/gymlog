const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/logic.js");

const done = (week, sid, ex, extra = {}) => ({
  week, sid, status: "done", date: "2026-11-20", completedAt: "2026-11-20T18:00:00Z", ex, ...extra,
});
const sets = (n, w, r) => Array.from({ length: n }, () => ({ w, r, done: true }));

test("plan has 72 sessions of five exercises each", () => {
  assert.equal(L.SEQ.length, 72);
  for (const s of L.SEQ) assert.equal(L.prescription(s.week, s.sid).length, 5, s.key);
});

test("next session follows plan order, so a skipped day skips nothing", () => {
  const sessions = { "w01-pushA": done(1, "pushA", []), "w01-pullA": done(1, "pullA", []) };
  assert.equal(L.nextSession(sessions).key, "w01-legsA");
  // Doing Push B out of order leaves Legs A as next.
  sessions["w01-pushB"] = done(1, "pushB", []);
  assert.equal(L.nextSession(sessions).key, "w01-legsA");
});

test("week advances only after all six sessions of the week", () => {
  const sessions = {};
  for (const s of L.PLAN.SESSIONS) sessions[L.sessionKey(1, s.id)] = done(1, s.id, []);
  assert.equal(L.nextSession(sessions).key, "w02-pushA");
  assert.ok(L.weekComplete(sessions, 1));
  assert.ok(!L.weekComplete(sessions, 2));
});

test("in-progress sessions are still next", () => {
  const sessions = { "w01-pushA": { ...done(1, "pushA", []), status: "in_progress" } };
  assert.equal(L.nextSession(sessions).key, "w01-pushA");
});

test("light weeks drop one set from 3+ set exercises only", () => {
  const p = L.prescription(4, "pushA", true);
  assert.deepEqual(p.map((e) => e.sets), [2, 2, 2, 2, 2]);
  assert.deepEqual(L.prescription(4, "pushA", false).map((e) => e.sets), [3, 3, 3, 2, 3]);
  assert.deepEqual(L.PLAN.LIGHT_WEEKS, [4, 8, 12]);
});

test("summary applies the dumbbell and one-sided rules", () => {
  // Paired dumbbells: 22.5 each → 45 combined.
  assert.deepEqual(L.summarize("Incline Dumbbell Press", "8–12", sets(3, 22.5, 10)), { setsDone: 3, avgReps: 10, weight: 45 });
  // One-sided: 10 per side → 20 total reps.
  assert.deepEqual(L.summarize("Single-Arm Cable Lat Pulldown", "10–12", sets(3, 66, 10)), { setsDone: 3, avgReps: 20, weight: 66 });
  // Bulgarian split squat: both rules.
  assert.deepEqual(L.summarize("Dumbbell Bulgarian Split Squat", "8–12 / leg", sets(3, 30, 10)), { setsDone: 3, avgReps: 20, weight: 60 });
  // Single-leg DB RDL holds one dumbbell: one-sided reps, weight as-is.
  assert.deepEqual(L.summarize("Single-Leg Dumbbell Romanian Deadlift", "10–12 / leg", sets(2, 40, 10)), { setsDone: 2, avgReps: 20, weight: 40 });
  // Machines untouched.
  assert.deepEqual(L.summarize("Machine Chest Press", "8–12", sets(3, 165, 9)), { setsDone: 3, avgReps: 9, weight: 165 });
});

test("summary keeps tonnage exact when weight changes between sets", () => {
  const s = [{ w: 100, r: 10, done: true }, { w: 110, r: 8, done: true }, { w: 110, r: 6, done: true }, { w: 120, r: 5, done: false }];
  const out = L.summarize("Hack Squat", "8–12", s);
  assert.equal(out.setsDone, 3);
  assert.equal(out.avgReps, 8);
  // 1000 + 880 + 660 = 2540 lb over 24 reps → 105.8 → 106
  assert.equal(out.weight, 106);
  assert.equal(L.summarize("Hack Squat", "8–12", [{ w: 100, r: 10, done: false }]), null);
});

test("progression: top of range on every set adds weight, else repeat", () => {
  const ex = { name: "Machine Chest Press", sets: 3, range: "8–12" };
  const hit = L.suggest(ex, { sets: sets(3, 165, 12) });
  assert.equal(hit.progress, true);
  assert.equal(hit.weight, 170);
  assert.equal(hit.reps, 8);
  const miss = L.suggest(ex, { sets: [...sets(2, 165, 12), { w: 165, r: 11, done: true }] });
  assert.equal(miss.progress, false);
  assert.equal(miss.weight, 165);
  assert.equal(L.suggest({ name: "Hack Squat", sets: 3, range: "8–12" }, { sets: sets(3, 180, 12) }).weight, 190);
  assert.equal(L.suggest(ex, null).weight, null);
});

test("new session pre-fills from last time, across blocks", () => {
  const sessions = { "w01-pushA": done(1, "pushA", [{ name: "Incline Dumbbell Press", sets: [{ w: 22.5, r: 12, done: true }, { w: 22.5, r: 10, done: true }, { w: 22.5, r: 9, done: true }] }]) };
  const doc = L.newSessionDoc(2, "pushA", sessions, { date: "2026-11-22" });
  assert.deepEqual(doc.ex[0].sets.map((s) => [s.w, s.r]), [[22.5, 12], [22.5, 10], [22.5, 9]]);
  assert.equal(doc.ex[1].sets[0].w, null);
  assert.equal(doc.ex[1].sets[0].r, 8);
  // Block 2 Push A also opens with Incline Dumbbell Press: still found.
  const b2 = L.newSessionDoc(5, "pushA", sessions);
  assert.equal(b2.ex[0].sets[0].w, 22.5);
});

test("lastPerformance ignores sessions later in the plan", () => {
  const sessions = {
    "w01-pushA": done(1, "pushA", [{ name: "Cable Chest Fly", sets: sets(2, 25, 12) }]),
    "w03-pushA": done(3, "pushA", [{ name: "Cable Chest Fly", sets: sets(2, 30, 12) }]),
  };
  assert.equal(L.lastPerformance(sessions, "Cable Chest Fly", "w02-pushA").sets[0].w, 25);
  assert.equal(L.lastPerformance(sessions, "Cable Chest Fly", "w04-pushA").sets[0].w, 30);
});

test("applyLight keeps ticked sets", () => {
  const doc = L.newSessionDoc(4, "pushA", {});
  doc.ex[0].sets[0].done = true;
  const light = L.applyLight(doc, true);
  assert.equal(light.ex[0].sets.length, 2);
  assert.equal(light.ex[3].sets.length, 2);
  const back = L.applyLight(light, false);
  assert.equal(back.ex[0].sets.length, 3);
  assert.ok(back.ex[0].sets[0].done);
});

// Column A as the Sheets API returns it: trailing blanks become [].
function colA(blocks) {
  const rows = [["BLOCK 1"], ["sub"], [], ["INPUTS"], ["LOGGING"], []];
  for (const [week, gapAfter] of blocks) {
    rows.push([`WEEK ${week}`]);
    for (const s of L.PLAN.SESSIONS) {
      rows.push([s.title]);
      rows.push(["Exercise"]);
      for (const e of L.prescription(week, s.id)) rows.push([e.name]);
      rows.push([]);
    }
    for (let i = 0; i < gapAfter; i++) rows.push([]);
  }
  return rows;
}

test("sheet rows are found by label even with uneven week spacing", () => {
  const a = colA([[1, 1], [2, 0], [3, 3], [4, 1]]);
  const names = L.prescription(1, "pushA").map((e) => e.name);
  assert.deepEqual(L.findSessionRows(a, 1, "PUSH A", names), [10, 11, 12, 13, 14]);
  const legsB = L.prescription(3, "legsB").map((e) => e.name);
  const rows = L.findSessionRows(a, 3, "LEGS B", legsB);
  assert.equal(a[rows[0] - 1][0], legsB[0]);
  assert.equal(rows.length, 5);
});

test("sheet lookup refuses to write when the layout doesn't match", () => {
  const a = colA([[1, 1]]);
  assert.throws(() => L.findSessionRows(a, 2, "PUSH A", ["x"]), /WEEK 2/);
  assert.throws(() => L.findSessionRows(a, 1, "PUSH A", ["Wrong Exercise"]), /Expected "Wrong Exercise"/);
});

test("matches the real sheet: Week 1 Push A on rows 10–14, Week 4 on 160–164", () => {
  // Rows observed in the user's sheet: WEEK 1 at row 7, WEEK 3 at 106, WEEK 4 at 157.
  const a = [];
  const put = (row, v) => { while (a.length < row) a.push([]); a[row - 1] = [v]; };
  const w = (row, week) => {
    put(row, `WEEK ${week}`);
    let r = row + 1;
    for (const s of L.PLAN.SESSIONS) {
      put(r++, s.title); put(r++, "Exercise");
      for (const e of L.prescription(week, s.id)) put(r++, e.name);
      r++;
    }
  };
  w(7, 1); w(57, 2); w(106, 3); w(157, 4);
  const names = L.prescription(1, "pushA").map((e) => e.name);
  assert.deepEqual(L.findSessionRows(a, 1, "PUSH A", names), [10, 11, 12, 13, 14]);
  assert.deepEqual(L.findSessionRows(a, 4, "PUSH A", names), [160, 161, 162, 163, 164]);
});

test("sheet values leave the volume formula column alone", () => {
  const doc = L.newSessionDoc(1, "pushA", {});
  doc.ex[0].sets = sets(3, 22.5, 10);
  doc.ex[0].note = "Bench was taken";
  const rows = L.sheetRowsForSession(doc);
  assert.deepEqual(rows[0], [3, 10, 45, null, "Bench was taken"]);
  assert.deepEqual(rows[1], ["", "", "", null, ""]);
  assert.deepEqual(L.rowRuns([10, 11, 12, 14]).map((r) => [r.start, r.end]), [[10, 12], [14, 14]]);
});

test("check-in draft: readiness average, performance, wins, bodyweight", () => {
  const mk = (week, w, r, readiness) => {
    const out = {};
    for (const s of L.PLAN.SESSIONS) {
      out[L.sessionKey(week, s.id)] = done(week, s.id, L.prescription(week, s.id).map((e) => ({ name: e.name, sets: sets(e.sets, w, r) })), { readiness });
    }
    return out;
  };
  const sessions = { ...mk(1, 50, 10, 6), ...mk(2, 55, 10, 8) };
  const draft = L.checkinDraft(sessions, 2, { w01: { bodyweight: 182 } });
  assert.equal(draft.readiness, 8);
  assert.equal(draft.performance, 10);
  assert.ok(draft.wins.includes("50 to 55 lb"));
  assert.equal(draft.bodyweight, 182);
  const first = L.checkinDraft(sessions, 1, {});
  assert.equal(first.performance, null);
});

test("next-week adjustment follows the coach's lighter-week rule", () => {
  assert.match(L.adjustmentFor(3, { readiness: 4 }), /Week 4: run the lighter week/);
  assert.match(L.adjustmentFor(3, { readiness: 8 }), /optional/);
  assert.match(L.adjustmentFor(1, { readiness: 8 }), /Keep progressing/);
  assert.match(L.adjustmentFor(1, { soreness: ["Shoulder"] }), /trim 1 set/);
  assert.equal(L.adjustmentFor(12, {}), "Program complete.");
  assert.equal(L.checkinRow(1), 5);
  assert.equal(L.checkinRow(12), 16);
});

test("rest day is suggested the day after legs, never forced", () => {
  const sessions = { "w01-legsA": done(1, "legsA", [], { date: "2026-11-21" }) };
  assert.equal(L.todayStatus(sessions, "2026-11-22").kind, "rest");
  assert.equal(L.todayStatus(sessions, "2026-11-23").kind, "train");
  assert.equal(L.todayStatus(sessions, "2026-11-21").kind, "doneToday");
  assert.equal(L.nextSession(sessions).key, "w01-pushA");
});
