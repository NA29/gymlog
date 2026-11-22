// Pure logic for the gym logger: schedule order, progression, coach-format
// summaries and Google Sheet row lookup. No DOM, no network: tested in Node.
(function (root, factory) {
  const PLAN = typeof module !== "undefined" && module.exports ? require("./plan.js") : root.GymPlan;
  const api = factory(PLAN);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GymLogic = api;
})(typeof window !== "undefined" ? window : globalThis, function (PLAN) {
  const pad = (n) => String(n).padStart(2, "0");

  function blockForWeek(week) {
    return PLAN.BLOCKS.find((b) => b.weeks.includes(week));
  }

  function sessionKey(week, sid) {
    return `w${pad(week)}-${sid}`;
  }

  function parseKey(key) {
    const m = /^w(\d\d)-(\w+)$/.exec(key || "");
    return m ? { week: Number(m[1]), sid: m[2] } : null;
  }

  // All 72 sessions in plan order. The plan advances by sessions, not dates.
  function sequence() {
    const out = [];
    for (let week = 1; week <= PLAN.WEEKS; week++) {
      for (const s of PLAN.SESSIONS) out.push({ key: sessionKey(week, s.id), week, sid: s.id, label: s.label });
    }
    return out;
  }
  const SEQ = sequence();
  const ORDER = Object.fromEntries(SEQ.map((s, i) => [s.key, i]));

  function sessionMeta(sid) {
    return PLAN.SESSIONS.find((s) => s.id === sid);
  }

  function isLightWeek(week) {
    return PLAN.LIGHT_WEEKS.includes(week);
  }

  // Lighter week: one fewer set on exercises prescribed 3+ sets.
  function prescription(week, sid, light) {
    const block = blockForWeek(week);
    return block.sessions[sid].map((ex) => ({
      ...ex,
      sets: light && ex.sets >= 3 ? ex.sets - 1 : ex.sets,
      plannedSets: ex.sets,
    }));
  }

  // Coach rules: two-dumbbell lifts log combined weight; one-sided moves log
  // total reps across both sides. The app takes weight per dumbbell and reps
  // per side, and converts when writing to the sheet.
  function exerciseKind(name, range) {
    const single = /single-(arm|leg)/i.test(name);
    return {
      pairedDB: /dumbbell/i.test(name) && !single,
      unilateral: single || /\/\s*leg/i.test(range || ""),
    };
  }

  function repBounds(range) {
    const nums = String(range).match(/\d+/g) || [];
    const lo = Number(nums[0] || 0);
    const hi = Number(nums[1] || nums[0] || 0);
    return { lo, hi };
  }

  const HEAVY = /hack squat|leg press|hip thrust|calf raise|smith|pull-through/i;
  function increment(name) {
    return HEAVY.test(name) ? 10 : 5;
  }

  const roundTo = (x, step) => Math.round(x / step) * step;

  // Sheet summary for one exercise: sets done, average reps per set, weight.
  // Weight is the rep-weighted average so sets × reps × weight equals the
  // real tonnage even when the weight changed between sets.
  function summarize(name, range, sets) {
    const done = (sets || []).filter((s) => s.done && s.r > 0);
    if (!done.length) return null;
    const kind = exerciseKind(name, range);
    const reps = done.reduce((a, s) => a + s.r, 0);
    const tonnage = done.reduce((a, s) => a + s.r * (s.w || 0), 0);
    const repMul = kind.unilateral ? 2 : 1;
    const wMul = kind.pairedDB ? 2 : 1;
    return {
      setsDone: done.length,
      avgReps: Math.round((reps / done.length) * repMul * 10) / 10,
      weight: roundTo((tonnage / reps) * wMul, 0.5),
    };
  }

  function isDone(doc) {
    return !!doc && doc.status === "done";
  }

  function nextSession(sessions) {
    return SEQ.find((s) => !isDone(sessions[s.key])) || null;
  }

  // Most recent completed performance of an exercise before `beforeKey`
  // in plan order (out-of-order sessions still count by their place).
  function lastPerformance(sessions, name, beforeKey) {
    const limit = beforeKey in ORDER ? ORDER[beforeKey] : SEQ.length;
    for (let i = limit - 1; i >= 0; i--) {
      const doc = sessions[SEQ[i].key];
      if (!isDone(doc)) continue;
      const ex = (doc.ex || []).find((e) => e.name === name);
      const sets = ex && (ex.sets || []).filter((s) => s.done && s.r > 0);
      if (sets && sets.length) return { key: SEQ[i].key, week: SEQ[i].week, sets };
    }
    return null;
  }

  // Double progression: build reps to the top of the range on every set,
  // then add a small amount of weight and drop back to the bottom.
  function suggest(ex, last) {
    const { lo, hi } = repBounds(ex.range);
    if (!last) return { weight: null, reps: lo || null, progress: false, last: null };
    const top = Math.max(...last.sets.map((s) => s.w || 0));
    const allTop = last.sets.length >= ex.sets && last.sets.every((s) => s.r >= hi);
    if (allTop) {
      return { weight: top + increment(ex.name), reps: lo, progress: true, last };
    }
    return { weight: top, reps: null, progress: false, last };
  }

  function describeSets(sets) {
    const ws = [...new Set(sets.map((s) => s.w))];
    if (ws.length === 1) return `${sets.map((s) => s.r).join(", ")} reps @ ${fmtNum(ws[0])}`;
    return sets.map((s) => `${s.r}×${fmtNum(s.w)}`).join(", ");
  }

  function fmtNum(x) {
    if (x == null || Number.isNaN(x)) return "–";
    return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10);
  }

  function newSessionDoc(week, sid, sessions, opts = {}) {
    const light = !!opts.light;
    const key = sessionKey(week, sid);
    const ex = prescription(week, sid, light).map((p) => {
      const sug = suggest(p, lastPerformance(sessions, p.name, key));
      const sets = [];
      for (let i = 0; i < p.sets; i++) {
        const prev = sug.last && sug.last.sets[i];
        sets.push({
          w: sug.weight != null ? sug.weight : null,
          r: sug.progress ? sug.reps : prev ? prev.r : sug.reps,
          done: false,
        });
      }
      return { name: p.name, sets, note: "" };
    });
    return {
      week, sid, status: "in_progress", light,
      date: opts.date || null, startedAt: opts.now || null, completedAt: null,
      readiness: null, ex, sync: { status: "never" },
    };
  }

  // Change the light-week option on a session in progress: add or remove the
  // last set of each 3+ set exercise, keeping sets already ticked.
  function applyLight(doc, light) {
    const plan = prescription(doc.week, doc.sid, light);
    const ex = doc.ex.map((e, i) => {
      const want = plan[i] ? plan[i].sets : e.sets.length;
      let sets = e.sets.slice();
      while (sets.length > want && !sets[sets.length - 1].done) sets.pop();
      while (sets.length < want) {
        const lastSet = sets[sets.length - 1] || { w: null, r: null };
        sets.push({ w: lastSet.w, r: lastSet.r, done: false });
      }
      return { ...e, sets };
    });
    return { ...doc, light, ex };
  }

  // ---- Google Sheet layout -------------------------------------------------
  // Block tabs repeat: "WEEK n", then per session a title row ("PUSH A"), a
  // header row ("Exercise"), and one row per exercise. Spacing between weeks
  // is not constant, so rows are found by label, never by fixed offsets.
  const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

  function findSessionRows(colA, week, sessionTitle, names) {
    const cell = (i) => norm(colA[i] && colA[i][0]);
    const weekIdx = colA.findIndex((r) => norm(r && r[0]) === `week ${week}`);
    if (weekIdx < 0) throw new Error(`Couldn't find "WEEK ${week}" in column A.`);
    let i = weekIdx + 1;
    while (i < colA.length && cell(i) !== norm(sessionTitle)) {
      if (/^week \d+$/.test(cell(i))) break;
      i++;
    }
    if (cell(i) !== norm(sessionTitle)) throw new Error(`Couldn't find ${sessionTitle} under WEEK ${week}.`);
    i++;
    if (cell(i) === "exercise") i++;
    const rows = [];
    for (const name of names) {
      if (cell(i) !== norm(name)) {
        throw new Error(`Expected "${name}" in row ${i + 1} (WEEK ${week}, ${sessionTitle}) but found "${(colA[i] && colA[i][0]) || "blank"}".`);
      }
      rows.push(i + 1); // 1-based sheet row
      i++;
    }
    return rows;
  }

  // Values for columns E:I of each exercise row. H holds the coach's volume
  // formula, so it is sent as null, which the Sheets API leaves untouched.
  function sheetRowsForSession(doc) {
    const plan = blockForWeek(doc.week).sessions[doc.sid];
    return doc.ex.map((e, idx) => {
      const p = plan[idx] || { range: "" };
      const s = summarize(e.name, p.range, e.sets);
      return s ? [s.setsDone, s.avgReps, s.weight, null, e.note || ""] : ["", "", "", null, e.note || ""];
    });
  }

  // Contiguous runs of rows, so each run is one range write.
  function rowRuns(rows) {
    const runs = [];
    rows.forEach((r, idx) => {
      const last = runs[runs.length - 1];
      if (last && r === last.end + 1) { last.end = r; last.idx.push(idx); }
      else runs.push({ start: r, end: r, idx: [idx] });
    });
    return runs;
  }

  function checkinRow(week) {
    return 4 + week; // "Weekly Check-in": header on row 4, week 1 on row 5
  }

  // ---- Weekly check-in -----------------------------------------------------
  function weekSessions(sessions, week) {
    return PLAN.SESSIONS.map((s) => sessions[sessionKey(week, s.id)]).filter(Boolean);
  }

  function weekComplete(sessions, week) {
    return PLAN.SESSIONS.every((s) => isDone(sessions[sessionKey(week, s.id)]));
  }

  function bestSet(sets) {
    return sets.reduce((b, s) => (!b || s.w > b.w || (s.w === b.w && s.r > b.r) ? s : b), null);
  }

  // Compare each exercise with its previous performance: heavier, or more
  // total reps at the same top weight, counts as progress.
  function weekProgress(sessions, week) {
    const results = [];
    for (const s of PLAN.SESSIONS) {
      const key = sessionKey(week, s.id);
      const doc = sessions[key];
      if (!isDone(doc)) continue;
      for (const e of doc.ex) {
        const cur = e.sets.filter((x) => x.done && x.r > 0);
        if (!cur.length) continue;
        const prev = lastPerformance(sessions, e.name, key);
        if (!prev) continue;
        const c = bestSet(cur), p = bestSet(prev.sets);
        const cReps = cur.reduce((a, x) => a + x.r, 0), pReps = prev.sets.reduce((a, x) => a + x.r, 0);
        let delta = 0;
        if (c.w > p.w) delta = 1;
        else if (c.w < p.w) delta = -1;
        else if (cReps > pReps) delta = 1;
        else if (cReps < pReps) delta = -1;
        results.push({ name: e.name, delta, from: p, to: c, fromReps: pReps, toReps: cReps });
      }
    }
    return results;
  }

  function checkinDraft(sessions, week, checkins) {
    const docs = weekSessions(sessions, week);
    const rs = docs.map((d) => d.readiness).filter((x) => typeof x === "number");
    const readiness = rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 10) / 10 : null;
    const prog = weekProgress(sessions, week);
    let performance = null;
    if (prog.length) {
      const score = prog.reduce((a, p) => a + p.delta, 0) / prog.length;
      performance = Math.max(1, Math.min(10, Math.round(6 + 4 * score)));
    }
    const wins = prog
      .filter((p) => p.delta > 0)
      .sort((a, b) => (b.to.w - b.from.w) - (a.to.w - a.from.w))
      .slice(0, 4)
      .map((p) => (p.to.w > p.from.w
        ? `${p.name} ${fmtNum(p.from.w)} → ${fmtNum(p.to.w)} lb`
        : `${p.name} ${p.fromReps} → ${p.toReps} total reps`));
    let prevBw = null;
    for (let w = week - 1; w >= 1; w--) {
      const c = checkins[`w${pad(w)}`];
      if (c && c.bodyweight) { prevBw = c.bodyweight; break; }
    }
    return { week, readiness, performance, wins: wins.join("; "), bodyweight: prevBw };
  }

  function adjustmentFor(week, { readiness, soreness }) {
    const next = week + 1;
    const tired = (typeof readiness === "number" && readiness <= 5) || (soreness && soreness.length > 0);
    if (next > PLAN.WEEKS) return "Program complete.";
    if (isLightWeek(next)) {
      return tired
        ? `Week ${next}: run the lighter week, 1–2 fewer sets on demanding exercises.`
        : `Week ${next}: lighter week optional; keep full sets if recovery feels good.`;
    }
    if (tired) return "Keep loads, trim 1 set from accessories until readiness recovers.";
    return "Keep progressing: build reps to the top of each range, then add weight.";
  }

  function checkinSheetRow(c) {
    const join = (a) => (Array.isArray(a) ? a.join(", ") : a || "");
    const soreness = [join(c.soreness), c.note].filter(Boolean).join(" — ");
    return [c.bodyweight ?? "", c.sleep ?? "", c.readiness ?? "", c.stress ?? "", c.performance ?? "", c.wins || "", soreness, c.adjustment || ""];
  }

  // ---- Dates ---------------------------------------------------------------
  function localDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function daysBetween(a, b) {
    const pa = new Date(a + "T12:00:00"), pb = new Date(b + "T12:00:00");
    return Math.round((pb - pa) / 86400000);
  }

  // Coach's week: Push A → Pull A → Legs A → Rest → Push B → Pull B → Legs B.
  // Suggest the rest day the day after a legs session; never block training.
  function todayStatus(sessions, today) {
    const done = SEQ.map((s) => sessions[s.key]).filter((d) => isDone(d) && d.date);
    const trainedToday = done.filter((d) => d.date === today);
    if (trainedToday.length) return { kind: "doneToday", sessions: trainedToday };
    const last = done.sort((a, b) => (a.completedAt || "").localeCompare(b.completedAt || "")).pop();
    if (last && /^legs/.test(last.sid) && daysBetween(last.date, today) === 1) return { kind: "rest", after: last };
    return { kind: "train" };
  }

  return {
    PLAN, SEQ, ORDER, pad, blockForWeek, sessionKey, parseKey, sessionMeta, isLightWeek,
    prescription, exerciseKind, repBounds, increment, summarize, isDone, nextSession,
    lastPerformance, suggest, describeSets, fmtNum, newSessionDoc, applyLight,
    findSessionRows, sheetRowsForSession, rowRuns, checkinRow, weekSessions, weekComplete,
    weekProgress, checkinDraft, adjustmentFor, checkinSheetRow, localDate, daysBetween, todayStatus,
  };
});
