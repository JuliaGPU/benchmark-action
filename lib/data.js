// Benchmark histories, normalized into one dataset for the statistics and the dashboard.
// Plain ES module without dependencies, used by the publishing tools in Node and by the
// dashboard in the browser.
//
// Two formats are understood:
//
// - `history.json`, written by the publishing workflow (see tools/history.mjs):
//
//     {"version": 2,
//      "runs": [{"id", "commit", "date", "subject", "author", "url", "build", "source",
//                "env": {...}}, ...],
//      "benchmarks": {"<name>": {"unit": "ns", "<stat>": [one value per run, or null]}}}
//
//   with `<stat>` one of the keys of STATS below (other keys, like `samples`, describe the
//   measurement). Runs are ordered by commit date, and a commit can have several runs.
//
// - `data.js`, as written by github-action-benchmark (`window.BENCHMARK_DATA = {...}`),
//   which records one number per benchmark (whichever estimate the package saved) and
//   the BenchmarkTools allocation counters in a free-form `extra` string.

export const STATS = {
  min: { label: "Minimum time", unit: "time" },
  p25: { label: "25th percentile time", unit: "time" },
  median: { label: "Median time", unit: "time" },
  p75: { label: "75th percentile time", unit: "time" },
  mean: { label: "Mean time", unit: "time" },
  max: { label: "Maximum time", unit: "time" },
  time: { label: "Time", unit: "time" },
  gctime: { label: "GC time (median)", unit: "time" },
  memory: { label: "Memory", unit: "bytes" },
  allocs: { label: "Allocations", unit: "count" },
};

const DATA_PREFIX = /^\s*window\.BENCHMARK_DATA\s*=\s*/;

// The script is parsed as JSON, never executed: it can come from anywhere.
export function parseDataJs(text) {
  const json = text.replace(DATA_PREFIX, "").trim().replace(/;$/, "");
  return JSON.parse(json);
}

// Either format, given as text, as a dataset (see `fromHistory`).
export function parseAny(text, config, { suite } = {}) {
  config = normalizeConfig(config);
  const raw = DATA_PREFIX.test(text)
    ? fromActionData(parseDataJs(text), { suite, statOf: legacyStatOf(config.legacy) })
    : JSON.parse(text);
  return fromHistory(raw, config);
}

// A package describes its benchmarks in a configuration file (perf/benchmark-config.json):
//
//   categories  [{id, label, description, floor}]: the first path component of every
//               benchmark's name is the `id` of its category (`performance/array/copy`).
//               `floor` is the smallest change (a fraction) that counts as unusual,
//               however quiet the benchmark
//   stat        the statistic changes are judged on (default `min`)
//   legacy      which statistic the values in github-action-benchmark data were, as
//               `{stat, until}` rules: the first rule whose `until` date the commit
//               precedes (or that has none) applies
//   notes       changes to how the benchmarks are run: [{commit, date, kind, label,
//               description, url, benchmarks, rebase}], see `annotations`
//   dashboard   where the history is shown, linked from pull request comments
//
// Benchmarks of no configured category go to OTHER.
export const OTHER = {
  id: "other",
  label: "Other",
  description: "Benchmarks whose name does not start with one of the configured categories.",
};

// category ids end up in URLs and markup
const CATEGORY_ID = /^[a-z][a-z0-9_-]*$/;

export function normalizeConfig(config = {}) {
  if (config.normalized) return config;
  const categories = (config.categories || []).filter((c) => CATEGORY_ID.test(c.id) && c.id !== OTHER.id);
  return {
    ...config,
    normalized: true,
    categories: [...categories, OTHER].map((c) => ({ floor: 0.03, ...c })),
    stat: config.stat || "min",
    legacy: config.legacy || [],
    notes: config.notes || [],
  };
}

// The category of a benchmark: the first part of its name, when that is a configured
// category and more follows. Otherwise null.
export function categoryOf(name, config) {
  const slash = name.indexOf("/");
  if (slash < 0 || slash === name.length - 1) return null;
  const first = name.slice(0, slash);
  return normalizeConfig(config).categories.some((c) => c.id === first && c.id !== OTHER.id) ? first : null;
}

// The names that are in no configured category.
export function uncategorized(names, config) {
  return names.filter((name) => categoryOf(name, config) === null);
}


// `extra` is free-form text. The julia tool writes `gctime=..\nmemory=..\nallocs=..\nparams=..`,
// and the codespeed import wrote `Julia 1.10`.
export function parseExtra(extra) {
  if (!extra) return {};
  const s = extra.trim();
  const m = /^Julia (\d+\.\d+(?:\.\d+)?\S*)$/.exec(s);
  if (m) return { julia: m[1] };
  const out = {};
  for (const line of s.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    if (key === "params") continue;
    const v = Number(line.slice(eq + 1));
    if (!isNaN(v)) out[key] = v;
  }
  return out;
}

export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The category of a benchmark (its first path component, if that is a configured one),
// its group (the next path component, or two when there are at least two more below them:
// `performance/array/reductions/Float32/1d` is in `array/reductions`), and its name
// without the category.
export function classify(name, config) {
  const category = categoryOf(name, config);
  const parts = name.split("/").slice(category === null ? 0 : 1);
  return {
    category: category ?? OTHER.id,
    group: parts.length >= 3 ? parts.slice(0, 2).join("/") : parts[0],
    short: parts.join("/"),
  };
}

// Which statistic the entries of a package's github-action-benchmark data reported, from
// its `legacy` list of `{stat, until}`: the first rule whose `until` date the commit
// precedes (or that has none) applies.
export function legacyStatOf(rules = []) {
  return (entry) => {
    const t = Date.parse(entry.commit.timestamp);
    return rules.find((rule) => !rule.until || t < Date.parse(rule.until))?.stat || "time";
  };
}

// github-action-benchmark's data in the history format: every entry becomes a run, and its
// single value is kept as the statistic `statOf(entry)` reported (`time` when unknown).
export function fromActionData(raw, { suite, statOf = () => "time" } = {}) {
  const suites = Object.keys(raw.entries || {});
  if (suites.length === 0) throw new Error("The data file contains no benchmark results");
  const entries = [...raw.entries[suite && raw.entries[suite] ? suite : suites[0]]];
  entries.sort((a, b) => Date.parse(a.commit.timestamp) - Date.parse(b.commit.timestamp));

  const runs = [];
  // no prototype, so that benchmark names cannot collide with inherited properties
  const benchmarks = Object.create(null);
  entries.forEach((e, r) => {
    const c = e.commit;
    const stat = statOf(e);
    let julia = null;
    for (const b of e.benches) {
      const extra = parseExtra(b.extra);
      if (extra.julia) julia = extra.julia;
      if (!Object.hasOwn(benchmarks, b.name)) benchmarks[b.name] = { unit: b.unit };
      const bench = benchmarks[b.name];
      const put = (key, v) => {
        if (v == null) return;
        (bench[key] ||= new Array(entries.length).fill(null))[r] = v;
      };
      put(stat, b.value);
      // BenchmarkTools reports the GC time of the estimate it was asked for, which is only
      // the median GC time we record for the median estimate
      if (stat === "median" || stat === "time") put("gctime", extra.gctime);
      put("memory", extra.memory);
      put("allocs", extra.allocs);
    }
    runs.push({
      commit: c.id,
      date: c.timestamp,
      subject: (c.message || "").split("\n")[0],
      author: c.author?.username || c.author?.name || "",
      url: c.url,
      source: julia ? "codespeed" : "github-action-benchmark",
      env: julia ? { julia } : {},
    });
  });
  return { version: 2, repo: raw.repoUrl, runs, benchmarks };
}

// Which runs to show: one Julia version at a time and the latest run of every commit (by
// when it was `measured`, or else by its position: re-runs are stored after earlier runs).
// The codespeed import interleaved commits measured with different Julia versions; the
// history moves to a newer version once most of the next VERSION_LOOKAHEAD runs use it,
// never goes back, and leaves out runs of other versions. Returns run indices.
const VERSION_LOOKAHEAD = 20;

export function selectRuns(runs) {
  const versions = runs.map((r) => r.env?.julia ?? null);
  const kept = [];
  let julia = null;
  runs.forEach((run, i) => {
    const v = versions[i];
    if (v != null && v !== julia) {
      if (julia != null && compareVersions(v, julia) < 0) return;
      if (julia != null) {
        const ahead = versions.slice(i, i + VERSION_LOOKAHEAD).filter((x) => x != null);
        const newer = ahead.filter((x) => compareVersions(x, v) >= 0).length;
        if (newer * 2 <= ahead.length) return;
      }
      julia = v;
    }
    kept.push(i);
  });
  const time = (i) => Date.parse(runs[i].measured) || 0;
  const latest = new Map();
  for (const i of kept) {
    const j = latest.get(runs[i].commit);
    if (j === undefined || time(i) >= time(j)) latest.set(runs[i].commit, i);
  }
  return kept.filter((i) => latest.get(runs[i].commit) === i);
}

// The dataset every view works on:
//
//   runs:    [{commit, short, subject, author, date, url, build, source, env}]
//   benches: [{name, short, category, group, unit}], sorted by name
//   stats:   {stat: [Float64Array per benchmark, one value per run, NaN when missing]}
export function fromHistory(raw, config) {
  config = normalizeConfig(config);
  if (raw.version !== 2) throw new Error(`Unsupported history version ${raw.version}`);
  const keep = selectRuns(raw.runs);
  const runs = keep.map((i) => {
    const r = raw.runs[i];
    return {
      ...r,
      short: r.commit.slice(0, 9),
      subject: r.subject || "",
      date: typeof r.date === "number" ? r.date : Date.parse(r.date),
      env: { ...(r.env || {}) },
    };
  });

  const names = Object.keys(raw.benchmarks).sort();
  const benches = names.map((name) => ({
    name,
    unit: raw.benchmarks[name].unit || "ns",
    ...classify(name, config),
  }));
  const stats = {};
  for (const stat of Object.keys(STATS)) {
    if (!names.some((n) => Array.isArray(raw.benchmarks[n][stat]))) continue;
    stats[stat] = names.map((n) => {
      const src = raw.benchmarks[n][stat] || [];
      const a = new Float64Array(keep.length).fill(NaN);
      keep.forEach((i, r) => {
        const v = src[i];
        if (v != null && v >= 0) a[r] = v;
      });
      return a;
    });
  }
  return { repoUrl: raw.repo, config, notes: config.notes, runs, benches, stats };
}

// The run index a note refers to: the run of its commit, or else the first run at or after
// its date. Returns -1 when the note lies outside the data.
export function noteRun(ds, note) {
  if (note.commit) {
    const i = ds.runs.findIndex((r) => r.commit.startsWith(note.commit));
    if (i >= 0) return i;
  }
  if (note.date) {
    const t = Date.parse(note.date);
    return ds.runs.findIndex((r) => r.date >= t);
  }
  return -1;
}

// The environment fields that are annotated when they change. A different GPU makes the
// numbers before and after incomparable; the other changes may well be what changed them.
const ENV_FIELDS = {
  julia: { label: "Julia", kind: "julia" },
  gpu: { label: "GPU", kind: "environment", rebase: true },
  driver: { label: "Driver", kind: "environment" },
  runtime: { label: "Runtime", kind: "environment" },
  toolkit: { label: "Toolkit", kind: "environment" },
  os: { label: "OS", kind: "environment" },
};

// The differences in the recorded environment of two runs, field by field and then package
// by package, leaving out what either did not record: [{label, from, to}].
export function environmentDiff(a, b) {
  const out = [];
  const labels = { ...Object.fromEntries(Object.entries(ENV_FIELDS).map(([k, f]) => [k, f.label])), cpu: "CPU", threads: "Threads", package: "Package" };
  for (const [key, label] of Object.entries(labels)) {
    const x = a?.[key];
    const y = b?.[key];
    if (x != null && y != null && x !== y) out.push({ label, from: String(x), to: String(y) });
  }
  const pa = a?.packages || {};
  const pb = b?.packages || {};
  for (const name of Object.keys(pb).sort()) {
    if (pa[name] != null && pa[name] !== pb[name]) out.push({ label: name, from: pa[name], to: pb[name] });
  }
  return out;
}

// Annotations for every change in the recorded environment between consecutive runs that
// both recorded it. Package versions are not annotated (they change too often to draw);
// see `environmentDiff`. Unknown values (older runs) never produce a change.
export function environmentChanges(ds) {
  const out = [];
  const last = {};
  ds.runs.forEach((run, r) => {
    for (const [key, f] of Object.entries(ENV_FIELDS)) {
      const v = run.env[key];
      if (v == null) continue;
      if (last[key] != null && last[key] !== v) {
        out.push({
          run: r,
          kind: f.kind,
          label: `${f.label} ${last[key]} → ${v}`,
          description: `${f.label} changed from ${last[key]} to ${v}.`,
          rebase: f.rebase,
          auto: true,
        });
      }
      last[key] = v;
    }
  });
  return out;
}

// All annotations of a dataset: the package's notes placed on their run, plus the recorded
// environment changes, ordered by run.
export function annotations(ds) {
  const notes = (ds.notes || [])
    .map((n) => ({ ...n, run: noteRun(ds, n) }))
    .filter((n) => n.run > 0);
  return [...notes, ...environmentChanges(ds)].sort((a, b) => a.run - b.run);
}
