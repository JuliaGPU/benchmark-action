// Reading, validating and extending the benchmark history of a package (`history.json`,
// described in data.js).

import { fromActionData, legacyStatOf, normalizeConfig, uncategorized } from "./data.js";

// What a run of the benchmark suite reports per benchmark (`benchmarks.json`, see the
// README). Times are in nanoseconds.
export const RESULT_FIELDS = [
  "min", "p25", "median", "p75", "mean", "max", "std",
  "gctime", "memory", "allocs", "samples", "evals",
];
const MAX_BENCHMARKS = 5000;
const NAME = /^[\p{L}\p{N}\p{P}\p{S} ]{1,200}$/u;

// Benchmark names are keys of plain objects, which must not reach the properties every
// object inherits (a benchmark named `constructor`); these maps have no prototype.
const dict = (entries = {}) => Object.assign(Object.create(null), entries);

export function emptyHistory(repo) {
  return { version: 2, repo, runs: [], benchmarks: dict() };
}

export function cloneHistory(history) {
  const copy = structuredClone(history);
  copy.benchmarks = dict(copy.benchmarks);
  return copy;
}

export function parseHistory(text) {
  const history = JSON.parse(text);
  history.benchmarks = dict(history.benchmarks);
  return history;
}

// The results of one run, as uploaded by CI. They come from code under test, so anything
// that does not have the expected shape is rejected.
export function validateResults(results) {
  if (results?.version !== 2) throw new Error("Results must have version 2");
  const names = Object.keys(results.benchmarks || {});
  if (names.length === 0 || names.length > MAX_BENCHMARKS)
    throw new Error(`Results must contain between 1 and ${MAX_BENCHMARKS} benchmarks`);
  const out = dict();
  for (const name of names) {
    if (!NAME.test(name)) throw new Error(`Invalid benchmark name ${JSON.stringify(name.slice(0, 200))}`);
    const b = results.benchmarks[name];
    const clean = { unit: "ns" };
    for (const f of RESULT_FIELDS) {
      const v = b[f];
      if (v == null) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        throw new Error(`Invalid ${f} for ${name}: ${JSON.stringify(v)}`);
      clean[f] = v;
    }
    out[name] = clean;
  }
  const env = {};
  for (const [k, v] of Object.entries(results.env || {})) {
    if (!/^[a-z_]{1,32}$/.test(k)) continue;
    if (typeof v === "string") env[k] = v.slice(0, 200);
    else if (typeof v === "number" && Number.isFinite(v)) env[k] = v;
  }
  // the versions of the packages the run used: {name: version}
  const packages = results.env?.packages;
  if (packages && typeof packages === "object") {
    env.packages = {};
    for (const [name, version] of Object.entries(packages).slice(0, 200))
      if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && typeof version === "string")
        env.packages[name] = version.slice(0, 64);
  }
  return { env, benchmarks: out };
}

// Add one run, keeping the runs ordered by commit date (results can arrive out of order).
// A run whose `id` is already present is not added again. Returns whether it was added.
export function addRun(history, run, benchmarks) {
  if (run.id && history.runs.some((r) => r.id === run.id)) return false;
  let at = history.runs.length;
  const t = Date.parse(run.date);
  while (at > 0 && Date.parse(history.runs[at - 1].date) > t) at--;
  const n = history.runs.length;
  history.runs.splice(at, 0, run);
  for (const b of Object.values(history.benchmarks))
    for (const [key, a] of Object.entries(b)) if (Array.isArray(a)) a.splice(at, 0, null);
  for (const [name, values] of Object.entries(benchmarks)) {
    if (!Object.hasOwn(history.benchmarks, name)) history.benchmarks[name] = { unit: values.unit || "ns" };
    const b = history.benchmarks[name];
    for (const [key, v] of Object.entries(values)) {
      if (key === "unit" || v == null) continue;
      if (!b[key]) b[key] = new Array(n + 1).fill(null);
      b[key][at] = v;
    }
  }
  return true;
}

// Bring in the runs of github-action-benchmark data that the history does not have yet,
// filing their values under the statistic the package reported at the time (its `legacy`
// rules). For a package with categories, data with a benchmark in none of them is refused:
// it predates the categories, and has to be renamed first (see `renameBenchmarks`). Used to create a history from that data, and to pick up runs the action keeps
// publishing while both run side by side. Returns the number of runs added.
//
// The action only appends to its data, so the k-th entry of a commit stays the k-th, and
// identifies the run. Later entries of a commit (re-runs) are inserted after earlier ones.
export function importLegacy(history, raw, config) {
  config = normalizeConfig(config);
  const old = fromActionData(raw, { statOf: legacyStatOf(config.legacy) });
  const measured = new Set(history.runs.filter((r) => r.source === "juliagpu").map((r) => r.commit));
  const have = new Set(history.runs.map((r) => r.id));

  // the runs to bring in, with their values: not those of commits the new pipeline
  // measured, which already have everything the action recorded
  const occurrences = new Map();
  const runs = [];
  old.runs.forEach((run, i) => {
    const k = (occurrences.get(run.commit) || 0) + 1;
    occurrences.set(run.commit, k);
    const id = `legacy:${run.commit}:${k}`;
    if (measured.has(run.commit) || have.has(id)) return;
    const values = dict();
    for (const [name, b] of Object.entries(old.benchmarks)) {
      const v = {};
      for (const [key, a] of Object.entries(b)) if (Array.isArray(a) && a[i] != null) v[key] = a[i];
      if (Object.keys(v).length) values[name] = { unit: b.unit, ...v };
    }
    runs.push({ run: { ...run, id }, values });
  });

  if (config.categories.length > 1) {
    const lost = uncategorized([...new Set(runs.flatMap((r) => Object.keys(r.values)))], config);
    if (lost.length)
      throw new Error(`The data has benchmarks in no category, rename them first: ${lost.slice(0, 10).join(", ")}${lost.length > 10 ? ", ..." : ""}`);
  }
  let added = 0;
  for (const { run, values } of runs) if (addRun(history, run, values)) added++;
  if (!history.repo) history.repo = old.repo;
  return added;
}

// Every statistic array has one entry per run.
export function checkHistory(history) {
  if (history.version !== 2) throw new Error("Not a version 2 history");
  const n = history.runs.length;
  for (const [name, b] of Object.entries(history.benchmarks))
    for (const [key, a] of Object.entries(b))
      if (Array.isArray(a) && a.length !== n)
        throw new Error(`${name}.${key} has ${a.length} entries for ${n} runs`);
}

// Compact enough to be served as one file: values rounded to 4 significant digits (well
// below the noise of any benchmark) and one line per array.
export function serialize(history) {
  const round = (v) => (v == null ? null : v === 0 ? 0 : Number(v.toPrecision(4)));
  const lines = [];
  lines.push(`{"version":2,"repo":${JSON.stringify(history.repo || null)},"runs":[`);
  lines.push(history.runs.map((r) => JSON.stringify(r)).join(",\n"));
  lines.push(`],"benchmarks":{`);
  const names = Object.keys(history.benchmarks).sort();
  lines.push(
    names
      .map((name) => {
        const b = history.benchmarks[name];
        const fields = Object.entries(b).map(([k, v]) =>
          Array.isArray(v) ? `${JSON.stringify(k)}:${JSON.stringify(v.map(round))}` : `${JSON.stringify(k)}:${JSON.stringify(v)}`,
        );
        return `${JSON.stringify(name)}:{${fields.join(",")}}`;
      })
      .join(",\n"),
  );
  lines.push("}}\n");
  return lines.join("\n");
}


// The name a benchmark gets when a package moves its benchmarks into categories: names that
// are in a category stay, the others get the replacement of the longest prefix in `map`
// that they start with ("" matches every name). Applying it twice changes nothing.
export function renamed(name, config, map) {
  if (!uncategorized([name], config).length) return name;
  const prefix = Object.keys(map)
    .filter((p) => name.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? name : map[prefix] + name.slice(prefix.length);
}

// Renames the benchmarks in github-action-benchmark data (`{entries}`) or a history, in
// place, refusing to merge two benchmarks into one. Returns how many names changed.
export function renameBenchmarks(data, config, map) {
  const changed = new Set();
  const rename = (name, taken) => {
    const to = renamed(name, config, map);
    if (taken.has(to)) throw new Error(`Renaming ${name} to ${to} would merge two benchmarks`);
    taken.add(to);
    if (to !== name) changed.add(name);
    return to;
  };
  if (data.entries) {
    for (const entries of Object.values(data.entries))
      for (const e of entries) {
        const taken = new Set();
        for (const b of e.benches) b.name = rename(b.name, taken);
      }
  } else {
    const taken = new Set();
    const benchmarks = dict();
    for (const [name, b] of Object.entries(data.benchmarks)) benchmarks[rename(name, taken)] = b;
    data.benchmarks = benchmarks;
  }
  return changed.size;
}
