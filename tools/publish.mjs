#!/usr/bin/env node
// Maintains a package's benchmark history and reports on pull requests; run by the
// publishing workflow (.github/workflows/publish.yml).
//
//   publish.mjs convert --config C --data data.js --out history.json [--repo URL]
//   publish.mjs append  --config C --history history.json --results results.json --run run.json
//                       [--data data.js] [--repo URL]
//   publish.mjs comment --config C --history history.json --results results.json --run run.json
//                       --ancestors ancestors.txt --out comment.md [--data data.js]
//   publish.mjs check   --config C --results results.json
//   publish.mjs rename  --config C --map '{"old/": "category/new/", "": "category/"}' FILE...
//
// `--config` is the package's benchmark configuration (see lib/data.js), optional.
// `run.json` describes the measured commit: {id, commit, date, subject, author, url,
// build, measured}, with `date` the commit's date and `measured` when the benchmarks ran.
// `--data` brings in the runs that github-action-benchmark published and the history does
// not have yet.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDataJs, normalizeConfig, uncategorized } from "../lib/data.js";
import { emptyHistory, parseHistory, validateResults, addRun, importLegacy, checkHistory, serialize, renameBenchmarks } from "../lib/history.js";
import { report } from "../lib/report.js";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const readJSON = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const exists = (f) => f && fs.existsSync(f);

function readConfig(o) {
  return normalizeConfig(exists(o.config) ? readJSON(o.config) : {});
}

function readHistory(o) {
  if (exists(o.history)) return parseHistory(fs.readFileSync(o.history, "utf8"));
  return emptyHistory(o.repo);
}

function importData(o, history, config) {
  if (!exists(o.data)) return 0;
  return importLegacy(history, parseDataJs(fs.readFileSync(o.data, "utf8")), config);
}

function runOf(o, results) {
  const meta = readJSON(o.run);
  for (const key of ["commit", "date"]) if (!meta[key]) throw new Error(`run.json lacks ${key}`);
  return {
    id: String(meta.id || `${meta.commit}:${meta.build || ""}`),
    commit: meta.commit,
    date: meta.date,
    subject: (meta.subject || "").split("\n")[0].slice(0, 300),
    author: meta.author || "",
    url: meta.url,
    build: meta.build,
    measured: meta.measured || undefined,
    source: "juliagpu",
    env: results.env,
  };
}

function convert(o) {
  const history = emptyHistory(o.repo);
  const n = importData(o, history, readConfig(o));
  checkHistory(history);
  fs.writeFileSync(o.out, serialize(history));
  console.log(`Converted ${n} runs into ${o.out}`);
}

function append(o) {
  const config = readConfig(o);
  const history = readHistory(o);
  const results = validateResults(readJSON(o.results));
  const added = addRun(history, runOf(o, results), results.benchmarks);
  const imported = importData(o, history, config);
  checkHistory(history);
  fs.writeFileSync(o.history, serialize(history));
  console.log(`${added ? "Added" : "Already had"} the run; imported ${imported} earlier runs`);
}

function comment(o) {
  const config = readConfig(o);
  const history = readHistory(o);
  importData(o, history, config);
  const results = validateResults(readJSON(o.results));
  const ancestors = exists(o.ancestors)
    ? fs.readFileSync(o.ancestors, "utf8").split(/\s+/).filter(Boolean)
    : [];
  fs.writeFileSync(o.out, report(config, history, results, runOf(o, results), ancestors));
}

// Fails when a benchmark's name does not start with a configured category. The other
// commands accept such results (they show up as "Other"), so the workflow runs this last.
function check(o) {
  const config = exists(o.config) ? readJSON(o.config) : {};
  const lost = uncategorized(Object.keys(validateResults(readJSON(o.results)).benchmarks), config);
  if (!lost.length) return;
  const ids = (config.categories || []).map((c) => c.id).join(", ");
  console.error(`These benchmarks do not start with a configured category (${ids}):\n  ${lost.join("\n  ")}`);
  process.exit(1);
}

// Renames the benchmarks in github-action-benchmark data or histories, once, for a package
// that moves its benchmarks into categories: names in a category stay, the others get the
// replacement of the longest matching prefix in `--map` ("" matches every name).
function rename(o) {
  const config = exists(o.config) ? readJSON(o.config) : {};
  const map = JSON.parse(o.map);
  for (const file of o._.slice(1)) {
    const text = fs.readFileSync(file, "utf8");
    const legacy = /^\s*window\.BENCHMARK_DATA\s*=/.test(text);
    const data = legacy ? parseDataJs(text) : parseHistory(text);
    const n = renameBenchmarks(data, config, map);
    fs.writeFileSync(file, legacy ? `window.BENCHMARK_DATA = ${JSON.stringify(data, null, 2)}` : serialize(data));
    console.log(`Renamed ${n} benchmarks in ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = args(process.argv.slice(2));
  const commands = { convert, append, comment, check, rename };
  const cmd = commands[o._[0]];
  if (!cmd) {
    console.error("usage: publish.mjs convert|append|comment ...");
    process.exit(2);
  }
  cmd(o);
}
