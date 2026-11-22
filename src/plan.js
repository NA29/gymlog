// The coach's 12-week plan, transcribed from the "GYM" Google Sheet.
// Each block's four weeks share one prescription; weeks 4, 8 and 12 may be
// run lighter (1–2 fewer sets on demanding exercises) at the athlete's call.
(function (root) {
  const SESSIONS = [
    { id: "pushA", label: "Push A", title: "PUSH A" },
    { id: "pullA", label: "Pull A", title: "PULL A" },
    { id: "legsA", label: "Legs A", title: "LEGS A" },
    { id: "pushB", label: "Push B", title: "PUSH B" },
    { id: "pullB", label: "Pull B", title: "PULL B" },
    { id: "legsB", label: "Legs B", title: "LEGS B" },
  ];

  // [name, primary muscle, target sets, rep range]
  const B = (rows) => rows.map(([name, muscle, sets, range]) => ({ name, muscle, sets, range }));

  const BLOCKS = [
    {
      n: 1, weeks: [1, 2, 3, 4], tab: "B1 Arms Shoulders Chest",
      name: "Arms, Shoulders and Chest", short: "Arms / Shoulders / Chest",
      sessions: {
        pushA: B([
          ["Incline Dumbbell Press", "Chest", 3, "8–12"],
          ["Machine Chest Press", "Chest", 3, "8–12"],
          ["Cable Lateral Raise", "Shoulders", 3, "12–20"],
          ["Cable Chest Fly", "Chest", 2, "12–15"],
          ["Rope Triceps Pushdown", "Triceps", 3, "10–15"],
        ]),
        pullA: B([
          ["Chest-Supported Machine Row", "Upper back", 3, "8–12"],
          ["Single-Arm Cable Lat Pulldown", "Lats", 3, "10–12"],
          ["Incline Dumbbell Biceps Curl", "Biceps", 3, "10–12"],
          ["Reverse Cable Fly", "Shoulders", 2, "12–20"],
          ["Bayesian Cable Curl", "Biceps", 3, "10–15"],
        ]),
        legsA: B([
          ["Hack Squat", "Quads", 3, "8–12"],
          ["Dumbbell Romanian Deadlift", "Hamstrings", 3, "8–12"],
          ["Leg Extension", "Quads", 2, "12–15"],
          ["Seated Leg Curl", "Hamstrings", 2, "10–15"],
          ["Standing Calf Raise", "Calves", 3, "10–15"],
        ]),
        pushB: B([
          ["Seated Dumbbell Shoulder Press", "Shoulders", 3, "8–12"],
          ["Low-to-High Cable Fly", "Chest", 3, "10–15"],
          ["Dumbbell Lateral Raise", "Shoulders", 3, "12–20"],
          ["Overhead Cable Triceps Extension", "Triceps", 3, "10–15"],
          ["Cross-Body Cable Triceps Extension", "Triceps", 2, "12–15"],
        ]),
        pullB: B([
          ["Chest-Supported Dumbbell Row", "Upper back", 3, "8–12"],
          ["Neutral-Grip Lat Pulldown", "Lats", 3, "8–12"],
          ["Cable Face Pull", "Shoulders", 2, "12–20"],
          ["Seated Dumbbell Hammer Curl", "Biceps", 3, "10–12"],
          ["Cable Preacher Curl", "Biceps", 2, "12–15"],
        ]),
        legsB: B([
          ["Dumbbell Bulgarian Split Squat", "Quads", 3, "8–12 / leg"],
          ["Machine Hip Thrust", "Glutes", 3, "10–12"],
          ["Lying Leg Curl", "Hamstrings", 3, "10–15"],
          ["Seated Calf Raise", "Calves", 3, "12–20"],
          ["Cable Crunch", "Core", 3, "12–15"],
        ]),
      },
    },
    {
      n: 2, weeks: [5, 6, 7, 8], tab: "B2 Lats and Quads",
      name: "Lats and Quads", short: "Lats / Quads",
      sessions: {
        pushA: B([
          ["Incline Dumbbell Press", "Chest", 3, "8–12"],
          ["Machine Chest Press", "Chest", 2, "10–12"],
          ["Cable Lateral Raise", "Shoulders", 3, "12–20"],
          ["Rope Triceps Pushdown", "Triceps", 3, "10–15"],
          ["Cable Chest Fly", "Chest", 2, "12–15"],
        ]),
        pullA: B([
          ["Chest-Supported Machine Row", "Upper back", 3, "8–12"],
          ["Close-Grip Lat Pulldown", "Lats", 3, "8–12"],
          ["Single-Arm Cable Lat Pulldown", "Lats", 3, "10–12"],
          ["Straight-Arm Cable Pulldown", "Lats", 2, "12–15"],
          ["Incline Dumbbell Biceps Curl", "Biceps", 3, "10–12"],
        ]),
        legsA: B([
          ["Hack Squat", "Quads", 4, "6–10"],
          ["Leg Press (Quad Bias)", "Quads", 3, "10–12"],
          ["Leg Extension", "Quads", 2, "12–15"],
          ["Seated Leg Curl", "Hamstrings", 3, "10–15"],
          ["Standing Calf Raise", "Calves", 3, "10–15"],
        ]),
        pushB: B([
          ["Seated Dumbbell Shoulder Press", "Shoulders", 3, "8–12"],
          ["Standing Cable Chest Press", "Chest", 3, "10–15"],
          ["Dumbbell Lateral Raise", "Shoulders", 2, "12–20"],
          ["Overhead Cable Triceps Extension", "Triceps", 3, "10–15"],
          ["Cable Crunch", "Core", 3, "12–15"],
        ]),
        pullB: B([
          ["Chest-Supported Dumbbell Row", "Upper back", 3, "8–12"],
          ["Wide-Grip Lat Pulldown", "Lats", 3, "8–12"],
          ["Single-Arm Cable Row (Lat Bias)", "Lats", 3, "10–12"],
          ["Cable Pullover", "Lats", 2, "12–15"],
          ["Bayesian Cable Curl", "Biceps", 3, "10–15"],
        ]),
        legsB: B([
          ["Dumbbell Bulgarian Split Squat", "Quads", 3, "8–12 / leg"],
          ["Smith Heel-Elevated Squat", "Quads", 3, "8–12"],
          ["Dumbbell Romanian Deadlift", "Hamstrings", 3, "8–12"],
          ["Machine Hip Thrust", "Glutes", 3, "10–12"],
          ["Cable Crunch", "Core", 2, "12–15"],
        ]),
      },
    },
    {
      n: 3, weeks: [9, 10, 11, 12], tab: "B3 Arms and Hamstrings",
      name: "Arms and Hamstrings", short: "Arms / Hamstrings",
      sessions: {
        pushA: B([
          ["Incline Dumbbell Press", "Chest", 3, "8–12"],
          ["Cable Chest Fly", "Chest", 2, "12–15"],
          ["Seated Dumbbell Shoulder Press", "Shoulders", 2, "8–12"],
          ["Overhead Cable Triceps Extension", "Triceps", 3, "10–15"],
          ["Single-Arm Cable Pushdown", "Triceps", 3, "10–15"],
        ]),
        pullA: B([
          ["Chest-Supported Dumbbell Row", "Upper back", 3, "8–12"],
          ["Neutral-Grip Lat Pulldown", "Lats", 3, "8–12"],
          ["Incline Dumbbell Biceps Curl", "Biceps", 3, "8–12"],
          ["Bayesian Cable Curl", "Biceps", 3, "10–15"],
          ["Reverse Cable Fly", "Shoulders", 2, "12–20"],
        ]),
        legsA: B([
          ["Dumbbell Romanian Deadlift", "Hamstrings", 4, "8–10"],
          ["Seated Leg Curl", "Hamstrings", 3, "10–15"],
          ["Hack Squat", "Quads", 3, "8–12"],
          ["Standing Calf Raise", "Calves", 3, "10–15"],
          ["Cable Crunch", "Core", 3, "12–15"],
        ]),
        pushB: B([
          ["Machine Chest Press", "Chest", 3, "8–12"],
          ["Dumbbell Lateral Raise", "Shoulders", 3, "12–20"],
          ["Smith Machine Close-Grip Press", "Triceps", 3, "8–12"],
          ["Rope Triceps Pushdown", "Triceps", 3, "10–15"],
          ["Cable Y-Raise", "Shoulders", 2, "12–20"],
        ]),
        pullB: B([
          ["Chest-Supported Machine Row", "Upper back", 3, "8–12"],
          ["Single-Arm Cable Lat Pulldown", "Lats", 3, "10–12"],
          ["Machine Preacher Curl", "Biceps", 3, "10–12"],
          ["Cable Hammer Curl", "Biceps", 3, "10–15"],
          ["Cable Face Pull", "Shoulders", 2, "12–20"],
        ]),
        legsB: B([
          ["Dumbbell Reverse Lunge", "Quads", 3, "8–12 / leg"],
          ["Lying Leg Curl", "Hamstrings", 4, "10–15"],
          ["Cable Pull-Through", "Glutes", 3, "10–15"],
          ["Single-Leg Dumbbell Romanian Deadlift", "Hamstrings", 3, "10–12 / leg"],
          ["Seated Calf Raise", "Calves", 3, "12–20"],
        ]),
      },
    },
  ];

  const PLAN = {
    SESSIONS,
    BLOCKS,
    WEEKS: 12,
    LIGHT_WEEKS: [4, 8, 12],
    CHECKIN_TAB: "Weekly Check-in",
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PLAN;
  else root.GymPlan = PLAN;
})(typeof window !== "undefined" ? window : globalThis);
