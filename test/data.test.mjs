// Run with `node --test perf/test/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtra, fromActionData, fromHistory, classify, annotations, parseAny, normalizeConfig, uncategorized, categoryOf } from "../lib/data.js";

const load = (raw, opts = {}) => fromHistory(fromActionData(raw, opts), { categories });
import * as S from "../lib/stats.js";

const categories = [{ id: "performance" }, { id: "latency" }, { id: "applications" }];

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const series = (...xs) => Float64Array.from(xs.map((x) => (x == null ? NaN : x)));

function entry(id, day, benches, extra) {
  return {
    commit: { id, message: `commit ${id}\n\nbody`, timestamp: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`, url: `u/${id}` },
    benches: Object.entries(benches).map(([name, value]) => ({ name, value, unit: "ns", extra })),
  };
}

test("parseExtra understands the julia tool and the codespeed import", () => {
  assert.deepEqual(parseExtra("gctime=0\nmemory=4240\nallocs=137\nparams={\"evals\":1}"), { gctime: 0, memory: 4240, allocs: 137 });
  assert.deepEqual(parseExtra("Julia 1.10"), { julia: "1.10" });
  assert.deepEqual(parseExtra(undefined), {});
});

test("the first path component is the category", () => {
  const cs = { categories };
  assert.deepEqual(classify("performance/array/reductions/Float32/1d", cs), { category: "performance", group: "array/reductions", short: "array/reductions/Float32/1d" });
  assert.deepEqual(classify("performance/kernel/launch", cs), { category: "performance", group: "kernel", short: "kernel/launch" });
  assert.deepEqual(classify("applications/byval/slices=1", cs), { category: "applications", group: "byval", short: "byval/slices=1" });
  assert.deepEqual(classify("latency/import", cs), { category: "latency", group: "import", short: "import" });
  // anything else is kept whole, in "Other"
  assert.deepEqual(classify("array/copy", cs), { category: "other", group: "array", short: "array/copy" });
  assert.deepEqual(classify("latency", cs), { category: "other", group: "latency", short: "latency" });
  assert.deepEqual(uncategorized(["latency/import", "array/copy"], { categories }), ["array/copy"]);
});

test("data.js: runs sorted by commit time, re-runs keep the latest measurement", () => {
  const raw = {
    entries: {
      suite: [entry("b", 2, { x: 20 }), entry("a", 1, { x: 10, "latency/import": 1e9 }), entry("b", 2, { x: 21 })],
    },
  };
  const ds = load(raw);
  assert.deepEqual(ds.runs.map((r) => r.commit), ["a", "b"]);
  assert.equal(ds.runs[0].subject, "commit a");
  const x = ds.benches.findIndex((b) => b.name === "x");
  assert.deepEqual([...ds.stats.time[x]], [10, 21]);
  assert.equal(ds.benches.find((b) => b.name === "latency/import").category, "latency");
});

test("data.js: interleaved Julia versions follow one version and only move forward", () => {
  const versions = ["1.10", "1.10", "1.11", "1.10", "1.11", "1.11", "1.10", "1.11", "1.11", "1.11"];
  const raw = { entries: { s: versions.map((v, i) => entry(`c${i}`, i + 1, { x: i + 1 }, `Julia ${v}`)) } };
  // the history keeps every run; only the view leaves some out
  assert.equal(fromActionData(raw).runs.length, versions.length);
  const ds = load(raw);
  const kept = ds.runs.map((r) => r.env.julia);
  // once 1.11 is the majority of what follows it is adopted, and 1.10 runs are dropped after
  assert.deepEqual(kept, ["1.10", "1.10", "1.11", "1.11", "1.11", "1.11", "1.11", "1.11"]);
  const changes = annotations({ ...ds, notes: [] });
  assert.deepEqual(changes.map((a) => [a.run, a.label]), [[2, "Julia 1.10 → 1.11"]]);
});

test("data.js: each entry's value is filed under the statistic it reported", () => {
  const raw = {
    entries: { s: [entry("a", 1, { x: 10 }, "gctime=5\nmemory=8\nallocs=1"), entry("b", 2, { x: 7 }, "gctime=1\nmemory=8\nallocs=1")] },
  };
  const h = fromActionData(raw, { statOf: (e) => (e.commit.id === "a" ? "median" : "min") });
  assert.deepEqual(h.benchmarks.x.median, [10, null]);
  assert.deepEqual(h.benchmarks.x.min, [null, 7]);
  // the GC time of the minimum estimate is not the median GC time
  assert.deepEqual(h.benchmarks.x.gctime, [5, null]);
  assert.deepEqual(h.benchmarks.x.memory, [8, 8]);
});

test("history.json: null is missing, every statistic is kept", () => {
  const text = JSON.stringify({
    version: 2,
    runs: [
      { commit: "a", date: "2026-01-01T00:00:00Z", subject: "a" },
      { commit: "b", date: "2026-01-02T00:00:00Z", subject: "b", env: { driver: "1" } },
    ],
    benchmarks: { x: { unit: "ns", min: [1, 2], median: [null, 3], memory: [10, 10] } },
  });
  const ds = parseAny(text, { categories });
  assert.deepEqual(Object.keys(ds.stats).sort(), ["median", "memory", "min"]);
  assert.ok(isNaN(ds.stats.median[0][0]));
  assert.equal(ds.stats.median[0][1], 3);
  assert.equal(ds.runs[1].env.driver, "1");
});

test("notes are placed on their commit, or else on the first run after their date", () => {
  const ds = load({ entries: { s: [1, 2, 3].map((d) => entry(`c${d}`, d, { x: d })) } });
  ds.notes = [
    { commit: "c2", label: "on commit" },
    { commit: "unknown", date: "2026-01-02T12:00:00Z", label: "by date" },
  ];
  assert.deepEqual(annotations(ds).map((a) => [a.label, a.run]), [["on commit", 1], ["by date", 2]]);
});

test("chainIndex does not bring back an old change when a series reappears", () => {
  // `b` doubles while it is not measured; it must not move the index when it comes back
  const a = series(1, 1, 1, 1);
  const b = series(1, null, null, 2);
  const c = series(1, 1, 1, 1);
  const { level } = S.chainIndex([a, b, c], 0, 3);
  close(level[3], 1);
});

test("chainIndex ignores the step of a series across its boundary", () => {
  const a = series(1, 1, 2, 2);
  const b = series(1, 1, 1, 1);
  const plain = S.chainIndex([a, b], 0, 3).level;
  close(plain[3], Math.SQRT2);
  const rebased = S.chainIndex([a, b], 0, 3, { boundaries: [new Set([2]), new Set()] }).level;
  close(rebased[3], 1);
});

test("chainIndex skips runs with too few series", () => {
  const { level } = S.chainIndex([series(1, null, 2), series(1, null, 2), series(1, 1, 2)], 0, 2);
  assert.ok(isNaN(level[1]));
  close(level[2], 2);
});

test("combineIndices weights every index equally", () => {
  const big = S.chainIndex([series(1, 2), series(1, 2), series(1, 2)], 0, 1);
  const small = S.chainIndex([series(1, 1)], 0, 1);
  close(S.combineIndices([big, small]).level[1], Math.SQRT2);
});

// a noisy but flat history, then whatever follows
function history(n, tail) {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(100 * (1 + 0.01 * Math.sin(i * 1.7)));
  return series(...xs, ...tail);
}

test("summarize flags a step that holds, not a single spike", () => {
  const spike = S.summarize(history(30, [150, 100, 100]), 0, 32);
  assert.equal(spike.flagged.length, 0);
  const step = S.summarize(history(30, [150, 150, 151]), 0, 32);
  assert.equal(step.flagged.length, 1);
  assert.equal(step.flagged[0].sign, 1);
  assert.equal(step.flagged[0].to, 30);
  const latest = S.summarize(history(30, [70]), 0, 30);
  assert.equal(latest.flagged.length, 1);
  assert.equal(latest.flagged[0].unconfirmed, true);
  assert.equal(latest.last.sign, -1);
});

test("small changes stay below the floor even when the noise is tiny", () => {
  const s = series(...Array(30).fill(100), 102);
  assert.equal(S.compareRuns(s, 29, 30, { floor: 0.03 }).sign, 0);
  assert.equal(S.compareRuns(s, 29, 30, { floor: 0.01 }).sign, 1);
});

test("the noise starts over after a boundary", () => {
  const noisy = [];
  for (let i = 0; i < 30; i++) noisy.push(100 * (1 + 0.2 * Math.sin(i * 1.7)));
  const quiet = Array(20).fill(50);
  const s = series(...noisy, ...quiet);
  const trans = S.transitions(s, new Set([30]));
  close(S.noiseAt(trans, 49), 0);
  assert.ok(S.noiseAt(trans, 29) > 0.05);
});

test("zero values take no part in relative changes", () => {
  const s = series(0, 0, 0, 0);
  assert.equal(S.transitions(s).length, 0);
  assert.equal(S.compareRuns(s, 0, 3).d, 0);
  assert.equal(S.summarize(s, 0, 3).latest, 0);
  close(S.chainIndex([s, series(1, 1, 2, 2)], 0, 3).level[3], 2);
});

test("compareRuns refuses to judge across a boundary or without history", () => {
  const s = history(30, [50]);
  assert.equal(S.compareRuns(s, 29, 30, { boundaries: new Set([30]) }).boundary, true);
  assert.equal(S.compareRuns(series(1, 2), 0, 1).sign, null);
});

test("configurations get defaults and an Other category", () => {
  const c = normalizeConfig({ categories: [{ id: "latency", floor: 0.05 }] });
  assert.deepEqual(c.categories.map((x) => [x.id, x.floor]), [["latency", 0.05], ["other", 0.03]]);
  assert.equal(c.stat, "min");
});

test("data.js values are filed by the configuration's legacy rules", () => {
  const raw = { entries: { s: [entry("a", 1, { x: 10 }), entry("b", 3, { x: 7 })] } };
  const text = "window.BENCHMARK_DATA = " + JSON.stringify(raw);
  const ds = parseAny(text, { legacy: [{ stat: "median", until: "2026-01-02T00:00:00Z" }, { stat: "min" }] });
  assert.deepEqual([...ds.stats.median[0]].map((v) => (isNaN(v) ? null : v)), [10, null]);
  assert.deepEqual([...ds.stats.min[0]].map((v) => (isNaN(v) ? null : v)), [null, 7]);
});

test("checking and classifying agree on what is in a category", () => {
  for (const name of ["performance", "performance/", "performance/x", "other/x", "x"]) {
    const inCategory = uncategorized([name], { categories }).length === 0;
    assert.equal(inCategory, classify(name, { categories }).category !== "other", name);
    assert.equal(inCategory, categoryOf(name, { categories }) !== null, name);
  }
});

test("category ids that could break out of markup are dropped", () => {
  const c = normalizeConfig({ categories: [{ id: 'x"><img src=x onerror=alert(1)>' }, { id: "latency" }] });
  assert.deepEqual(c.categories.map((x) => x.id), ["latency", "other"]);
});
