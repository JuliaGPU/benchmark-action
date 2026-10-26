// Run with `node --test perf/test/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHistory, parseHistory, validateResults, addRun, importLegacy, checkHistory, serialize, renamed, renameBenchmarks } from "../lib/history.js";
import { report } from "../lib/report.js";
import { fromHistory } from "../lib/data.js";

const config = { categories: [{ id: "performance", label: "Performance", floor: 0.03 }] };

const run = (commit, day, extra = {}) => ({ id: `job-${commit}`, commit, date: `2026-01-0${day}T00:00:00Z`, source: "juliagpu", env: {}, ...extra });

test("runs are kept in commit order, and adding one twice does nothing", () => {
  const h = emptyHistory("r");
  assert.ok(addRun(h, run("b", 2), { x: { min: 2 } }));
  assert.ok(addRun(h, run("a", 1), { x: { min: 1 }, y: { min: 5, memory: 0 } }));
  assert.ok(!addRun(h, run("a", 1), { x: { min: 1 } }));
  checkHistory(h);
  assert.deepEqual(h.runs.map((r) => r.commit), ["a", "b"]);
  assert.deepEqual(h.benchmarks.x.min, [1, 2]);
  assert.deepEqual(h.benchmarks.y.min, [5, null]);
  assert.deepEqual(h.benchmarks.y.memory, [0, null]);
});

test("results from CI are validated", () => {
  const ok = { version: 2, env: { julia: "1.12.1", "bad key": "x" }, benchmarks: { "array/copyto!": { min: 1, samples: 10 } } };
  const r = validateResults(ok);
  assert.deepEqual(r.env, { julia: "1.12.1" });
  assert.deepEqual({ ...r.benchmarks }, { "array/copyto!": { unit: "ns", min: 1, samples: 10 } });
  assert.throws(() => validateResults({ version: 1, benchmarks: {} }));
  assert.throws(() => validateResults({ version: 2, benchmarks: { x: { min: -1 } } }));
  assert.throws(() => validateResults({ version: 2, benchmarks: { x: { min: "1" } } }));
  assert.throws(() => validateResults({ version: 2, benchmarks: { "a\nb": { min: 1 } } }));
});

function actionData(...entries) {
  return {
    repoUrl: "r",
    entries: {
      s: entries.map(([id, day, value]) => ({
        commit: { id, message: id, timestamp: `2026-01-0${day}T00:00:00Z`, url: id },
        benches: [{ name: "x", value, unit: "ns", extra: "gctime=0\nmemory=16\nallocs=1" }],
      })),
    },
  };
}

test("legacy runs are imported once, and not for commits the new pipeline measured", () => {
  const legacy = [{ stat: "median", until: "2026-01-02T00:00:00Z" }, { stat: "min" }];
  const h = emptyHistory();
  assert.equal(importLegacy(h, actionData(["a", 1, 10], ["b", 2, 9]), { legacy }), 2);
  assert.deepEqual(h.benchmarks.x.median, [10, null]);
  assert.deepEqual(h.benchmarks.x.min, [null, 9]);
  addRun(h, run("c", 3), { x: { min: 8, median: 8.5 } });
  // the action published `c` too, and `d` after it
  assert.equal(importLegacy(h, actionData(["a", 1, 10], ["b", 2, 9], ["c", 3, 8], ["d", 4, 7]), { legacy }), 1);
  checkHistory(h);
  assert.deepEqual(h.runs.map((r) => `${r.commit}:${r.source}`), ["a:github-action-benchmark", "b:github-action-benchmark", "c:juliagpu", "d:github-action-benchmark"]);
  assert.deepEqual(h.benchmarks.x.min, [null, 9, 8, 7]);
});

test("serialized histories round-trip, rounded to 4 digits", () => {
  const h = emptyHistory("r");
  addRun(h, run("a", 1), { x: { min: 1.234567, allocs: 0 } });
  const back = JSON.parse(serialize(h));
  assert.deepEqual(back.benchmarks.x, { unit: "ns", min: [1.235], allocs: [0] });
  assert.deepEqual(back.runs, h.runs);
});

test("benchmark names cannot reach inherited properties", () => {
  const names = ["constructor", "toString", "__proto__"];
  const results = validateResults(JSON.parse(`{"version":2,"benchmarks":{${names.map((n) => `"${n}":{"min":1}`).join(",")}}}`));
  const h = emptyHistory();
  addRun(h, run("a", 1), results.benchmarks);
  const back = parseHistory(serialize(h));
  assert.deepEqual(Object.keys(back.benchmarks).sort(), [...names].sort());
  assert.deepEqual(back.benchmarks.constructor.min, [1]);
  assert.equal(typeof Object.prototype.constructor, "function");
});

test("pull request reports include benchmarks named like inherited properties", () => {
  const h = emptyHistory();
  addRun(h, run("a", 1), { x: { min: 1 } });
  const results = validateResults(JSON.parse('{"version":2,"benchmarks":{"__proto__":{"min":2},"x":{"min":1}}}'));
  assert.match(report(config, h, results, pr("2026-01-05T00:00:00Z"), ["a"]), /`__proto__`/);
});

test("a re-run replaces an earlier measurement, whatever order they arrive in", () => {
  const h = emptyHistory();
  addRun(h, run("a", 1, { id: "new", measured: "2026-01-03T00:00:00Z" }), { x: { min: 2 } });
  addRun(h, run("a", 1, { id: "old", measured: "2026-01-02T00:00:00Z" }), { x: { min: 1 } });
  const ds = fromHistory(h, config);
  assert.deepEqual([...ds.stats.min[0]], [2]);
});

test("a legacy re-run published later is imported too", () => {
  const legacy = [{ stat: "min" }];
  const h = emptyHistory();
  importLegacy(h, actionData(["a", 1, 100]), { legacy });
  assert.equal(importLegacy(h, actionData(["a", 1, 100], ["a", 1, 200]), { legacy }), 1);
  const ds = fromHistory(h, config);
  assert.deepEqual([...ds.stats.min[0]], [200]);
});

// a flat history of `n` daily runs of benchmark `x` on the default branch
function flat(n, value = 100) {
  const h = emptyHistory("https://github.com/JuliaGPU/CUDA.jl");
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    addRun(h, { id: `m${i}`, commit: `c${i}`, date: day, source: "juliagpu", env: {} }, { "performance/x": { min: value * (1 + 0.005 * Math.sin(i)) } });
  }
  return h;
}
const pr = (date) => ({ id: "pr", commit: "p", date, source: "juliagpu", env: {} });

test("pull requests are compared with the latest measured ancestor of their merge base", () => {
  const h = flat(30);
  const md = report(config, h, { benchmarks: { "performance/x": { min: 150 } } }, pr("2026-02-15T00:00:00Z"), ["unmeasured", "c20", "c19"]);
  assert.match(md, /\[c20\]/);
  assert.match(md, /1 commit before it/);
  assert.match(md, /`x` \| 100 ns \| 150 ns \| \+49\.\d% \| 🔴 slower/);
  const fallback = report(config, h, { benchmarks: { "performance/x": { min: 100 } } }, pr("2026-02-15T00:00:00Z"), ["unmeasured"]);
  assert.match(fallback, /\[c29\].*none of the 1 commits/);
});

test("pull requests are not compared across a change of GPU", () => {
  const h = flat(30);
  h.runs.forEach((r) => (r.env.gpu = "A"));
  const md = report(config, h, { env: { gpu: "B" }, benchmarks: { "performance/x": { min: 1000 } } }, { ...pr("2026-02-15T00:00:00Z"), env: { gpu: "B" } }, ["c29"]);
  assert.match(md, /`x` .* not comparable/);
  // and they do not count towards the summary
  assert.doesNotMatch(md, /\| Performance \| [−+]/);
});

test("pull requests are not judged by notes about later changes", () => {
  const metal = {
    ...config,
    notes: [{ date: "2026-10-26T14:21:33+01:00", label: "Launch evals pinned", benchmarks: ["performance/kernel/launch"], rebase: true }],
  };
  const h = emptyHistory();
  for (let i = 0; i < 30; i++)
    addRun(h, { id: `m${i}`, commit: `c${i}`, date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), source: "juliagpu", env: {} }, { "performance/kernel/launch": { min: 100 * (1 + 0.005 * Math.sin(i)) } });
  const md = report(metal, h, { benchmarks: { "performance/kernel/launch": { min: 150 } } }, pr("2026-02-15T00:00:00Z"), ["c29"]);
  assert.match(md, /🔴 slower/);
});

test("a pull request at a commit of the default branch does not replace its run", () => {
  const h = flat(30);
  const md = report(config, h, { benchmarks: { "performance/x": { min: 100 } } }, { ...pr("2026-01-30T00:00:00Z"), commit: "c29", measured: "2026-12-01T00:00:00Z" }, ["c29"]);
  assert.match(md, /\[c29\].*the merge base/);
});

test("pull request reports warn about benchmarks outside every category", () => {
  const h = flat(30);
  const md = report(config, h, { benchmarks: { "performance/x": { min: 100 }, "array/copy": { min: 1 } } }, pr("2026-02-15T00:00:00Z"), ["c29"]);
  assert.match(md, /\[!WARNING\][^]*`array\/copy`/);
  assert.match(md, /\*\*Other\*\*/);
});

const categorized = { categories: [{ id: "performance" }, { id: "latency" }, { id: "applications" }] };
const map = { "integration/": "applications/", "gemm/": "applications/gemm/", "": "performance/" };

test("benchmarks are renamed into categories by the longest prefix, once", () => {
  const names = ["array/copy", "latency/import", "integration/byval/slices=1", "gemm/tiled", "applications/histogram"];
  const once = names.map((n) => renamed(n, categorized, map));
  assert.deepEqual(once, ["performance/array/copy", "latency/import", "applications/byval/slices=1", "applications/gemm/tiled", "applications/histogram"]);
  assert.deepEqual(once.map((n) => renamed(n, categorized, map)), once);

  const data = actionData(["a", 1, 10]);
  assert.equal(renameBenchmarks(data, categorized, map), 1);
  assert.equal(data.entries.s[0].benches[0].name, "performance/x");
  const h = emptyHistory();
  addRun(h, run("a", 1), { "integration/v": { min: 1 } });
  renameBenchmarks(h, categorized, map);
  assert.deepEqual(Object.keys(h.benchmarks), ["applications/v"]);
});

test("renaming refuses to merge two benchmarks", () => {
  const data = actionData(["a", 1, 10]);
  data.entries.s[0].benches.push({ name: "performance/x", value: 20, unit: "ns", extra: "" });
  assert.throws(() => renameBenchmarks(data, categorized, map), /merge/);
  const h = emptyHistory();
  addRun(h, run("a", 1), { x: { min: 1 }, "performance/x": { min: 2 } });
  assert.throws(() => renameBenchmarks(h, categorized, map), /merge/);
});

test("data with benchmarks in no category is not imported", () => {
  const h = emptyHistory();
  assert.throws(() => importLegacy(h, actionData(["a", 1, 10]), categorized), /rename them first/);
  assert.equal(h.runs.length, 0);
  const data = actionData(["a", 1, 10]);
  renameBenchmarks(data, categorized, map);
  assert.equal(importLegacy(h, data, categorized), 1);
  // a package without categories has nothing to rename
  assert.equal(importLegacy(emptyHistory(), actionData(["a", 1, 10]), {}), 1);
});

test("a new benchmark in no category does not stop the run that has it from being published", () => {
  // github-action-benchmark published the commit first, with the same new benchmark
  const h = emptyHistory();
  addRun(h, run("b", 2), { "performance/x": { min: 1 }, "oops/new": { min: 2 } });
  const data = actionData(["b", 2, 1]);
  data.entries.s[0].benches.push({ name: "oops/new", value: 2, unit: "ns", extra: "" });
  assert.equal(importLegacy(h, data, categorized), 0);
});

test("first pull request comments still warn about benchmarks outside every category", () => {
  const md = report(config, emptyHistory(), { benchmarks: { "array/copy": { min: 1 } } }, pr("2026-02-15T00:00:00Z"), []);
  assert.match(md, /\[!WARNING\][^]*array\/copy[^]*no history/);
});
