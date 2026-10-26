// The pull request comment: the results of a pull request compared with the history of
// its base branch, judged the way the dashboard judges changes.

import { fromHistory, annotations, normalizeConfig, uncategorized, environmentDiff, STATS } from "./data.js";
import * as S from "./stats.js";
import { addRun, cloneHistory } from "./history.js";

// identifies the comment, which is updated in place
export const MARKER = "<!-- juliagpu-benchmarks -->";

const code = (s) => "`" + s.replace(/`/g, "'").replace(/\|/g, "\\|") + "`";

function formatTime(ns) {
  if (ns == null || isNaN(ns)) return "—";
  const num = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
  if (ns >= 1e9) return num(ns / 1e9) + " s";
  if (ns >= 1e6) return num(ns / 1e6) + " ms";
  if (ns >= 1e3) return num(ns / 1e3) + " µs";
  return num(ns) + " ns";
}

function formatChange(d) {
  if (d == null || isNaN(d)) return "—";
  const pct = (Math.exp(d) - 1) * 100;
  return (pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1) + "%";
}

// The comment comparing `results` (validated, see history.js) of the pull request's
// `run` with `history`. The baseline is the latest measured commit among `ancestors` (the
// merge base and its ancestors, newest first), or else the latest run.
export function report(config, history, results, run, ancestors) {
  config = normalizeConfig(config);
  const warnings = [];
  const lost = uncategorized(Object.keys(results.benchmarks), config);
  if (lost.length)
    warnings.push(
      `> [!WARNING]`,
      `> The names of these benchmarks do not start with a category of the package's benchmark configuration (${config.categories.filter((c) => c.id !== "other").map((c) => code(c.id)).join(", ")}): ${lost.map(code).join(", ")}.`,
      "",
    );
  // the pull request's run takes the place of its commit date among the others, so that
  // the notes that apply to it are those of changes made before it. Its commit is renamed
  // so it cannot replace a run of the same commit on the default branch.
  const merged = cloneHistory(history);
  addRun(merged, { ...run, commit: `pull-request:${run.commit}`, id: "pull-request" }, results.benchmarks);
  const ds = fromHistory(merged, config);
  const annots = annotations(ds);
  const b = ds.runs.findIndex((r) => r.id === "pull-request");
  if (b < 0) throw new Error("The results were measured with an older Julia version than the history");
  const stat = ds.stats[config.stat] ? config.stat : Object.keys(ds.stats).find((s) => STATS[s].unit === "time");
  const values = ds.stats[stat];

  const measured = new Map();
  ds.runs.forEach((r, i) => i !== b && measured.set(r.commit, i));
  let a = -1;
  let distance = 0;
  for (const sha of ancestors) {
    if (measured.has(sha)) {
      a = measured.get(sha);
      break;
    }
    distance++;
  }
  const fallback = a < 0;
  if (fallback) a = b === ds.runs.length - 1 ? b - 1 : ds.runs.length - 1;
  if (a < 0) return [MARKER, "### Benchmark results", "", ...warnings, "There is no history to compare with yet.", ""].join("\n");
  const base = ds.runs[a];

  const rows = [];
  ds.benches.forEach((bench, i) => {
    const s = values[i];
    if (isNaN(s[b])) return;
    const floor = config.categories.find((c) => c.id === bench.category).floor;
    const cmp = S.compareRuns(s, a, b, { boundaries: S.boundariesFor(annots, bench.name), floor });
    rows.push({ ...bench, ...cmp });
  });

  const lines = [MARKER, `### Benchmark results`, "", ...warnings];
  const baseLink = `[${base.short}](${base.url || `${history.repo}/commit/${base.commit}`})`;
  if (fallback)
    lines.push(`Compared with ${baseLink}, the latest commit measured on the default branch: none of the ${ancestors.length} commits up to the merge base of this pull request was measured, so the differences may include changes that are not part of it.`);
  else
    lines.push(`Compared with ${baseLink}${distance ? `, the latest measured ancestor of the merge base (${distance} commit${distance > 1 ? "s" : ""} before it)` : ", the merge base"}.`);
  const diff = environmentDiff(base.env, ds.runs[b].env);
  if (diff.length)
    lines.push(`The environment differs from the baseline's: ${diff.map((d) => `${d.label} ${code(d.from)} → ${code(d.to)}`).join(", ")}.`, "");
  const floors = config.categories.map((c) => `${c.label.toLowerCase()} ${Math.round(c.floor * 100)}%`).join(", ");
  lines.push(`Times are the ${STATS[stat].label.toLowerCase()} of every benchmark. A change is unusual when it exceeds both three times the benchmark's typical change between consecutive runs on the default branch and a minimum per category (${floors}). A single run can still be a fluke, so rerun before drawing conclusions.`, "");

  lines.push("| | Geometric mean | Unusual: slower | Unusual: faster | Compared |", "|:--|--:|--:|--:|--:|");
  for (const c of config.categories) {
    const cs = rows.filter((r) => r.category === c.id && !isNaN(r.d) && !r.boundary);
    if (!cs.length) continue;
    const g = cs.reduce((x, r) => x + r.d, 0) / cs.length;
    lines.push(`| ${c.label} | ${formatChange(g)} | ${cs.filter((r) => r.sign > 0).length} | ${cs.filter((r) => r.sign < 0).length} | ${cs.length} |`);
  }
  lines.push("");

  // one table, a section per category, with the names below their category
  const table = (rs) => {
    const out = ["| Benchmark | Baseline | This PR | Change | |", "|:--|--:|--:|--:|:--|"];
    for (const c of config.categories) {
      const cs = rs.filter((r) => r.category === c.id);
      if (!cs.length) continue;
      out.push(`| **${c.label}** | | | | |`);
      for (const r of cs) {
        const note = r.boundary ? "not comparable" : r.sign > 0 ? "🔴 slower" : r.sign < 0 ? "🟢 faster" : r.sign === null && !isNaN(r.d) ? "noise unknown" : "";
        out.push(`| ${code(r.short)} | ${formatTime(r.va)} | ${formatTime(r.vb)} | ${formatChange(r.d)} | ${note} |`);
      }
    }
    return out;
  };
  const unusual = rows.filter((r) => r.sign).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  if (unusual.length) lines.push(...table(unusual), "");
  else lines.push("No unusual changes.", "");

  const all = [...rows].sort((x, y) => x.name.localeCompare(y.name));
  lines.push("<details><summary>All benchmarks</summary>", "", ...table(all), "", "</details>", "");
  if (config.dashboard) lines.push(`History: ${config.dashboard}`);
  return lines.join("\n") + "\n";
}
