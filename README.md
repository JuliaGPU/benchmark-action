# benchmark-action

Publishes the benchmark results of the JuliaGPU back-ends (CUDA.jl, AMDGPU.jl, Metal.jl):

- for every commit on a package's default branch, it adds the results to the package's
  history, `bench/history.json` on its gh-pages branch, which
  [juliagpu.org/perf](https://juliagpu.org/perf/) shows;
- for a pull request, it comments with a comparison against that history, flagging the
  changes that stand out from each benchmark's usual variation.

It also has the data formats and statistics (`lib/`), which the dashboard loads too, so
the comments and the dashboard judge changes the same way.

## Use

A package runs its benchmarks on Buildkite, and has the job upload `benchmarks.json` (see
below). A workflow that reacts to the commit status Buildkite posts for that job calls this
one, pinned to a commit:

```yaml
on: status
jobs:
  benchmarks:
    if: |
      github.event.context == 'buildkite/cuda-dot-jl/racehorse-benchmarks' &&
      github.event.state == 'success'
    permissions:
      contents: write       # update the history in the gh-pages branch
      pull-requests: write  # comment on pull requests
    uses: JuliaGPU/benchmark-action/.github/workflows/publish.yml@<commit>
    with:
      pipeline: cuda-dot-jl
    secrets:
      BUILDKITE_TOKEN: ${{ secrets.BUILDKITE_TOKEN }}
```

Inputs: `pipeline`, the Buildkite pipeline; `artifact`, the results file
(`benchmarks.json`); `config`, the package's configuration (`perf/benchmark-config.json`,
read from its default branch); `comment`, whether to comment on pull requests (otherwise
the comparison goes to the job summary).

A status workflow runs from the default branch with access to secrets, also for pull
requests from forks. This one never runs code of the benchmarked commit: it downloads the
results through the Buildkite API, checks that they belong to the commit, and validates them
as untrusted data. Only commits that GitHub reports on the default branch enter the history.
The workflow checks out its own tools at the commit it was called at.

## Results: `benchmarks.json`

What a run of the suite uploads; times in nanoseconds:

```json
{"version": 2,
 "env": {"julia": "1.12.1", "gpu": "NVIDIA GeForce RTX 2070", "driver": "595.71.5", ...},
 "benchmarks": {
   "performance/array/copy": {"min": 16200, "p25": 16400, "median": 16900, "p75": 17300,
                              "mean": 17100, "max": 30200, "std": 900, "gctime": 0,
                              "memory": 1856, "allocs": 55, "samples": 10000, "evals": 1}}}
```

Every field is optional. `env` describes the run; the dashboard annotates changes of
`julia`, `gpu`, `driver`, `runtime`, `toolkit` and `os`, and does not compare values across
a change of `gpu`.

## Configuration: `perf/benchmark-config.json`

```json
{"dashboard": "https://juliagpu.org/perf/?pkg=cuda",
 "stat": "min",
 "categories": [{"id": "performance", "label": "Performance", "description": "...", "floor": 0.03},
                {"id": "latency", "label": "Latency", "description": "...", "floor": 0.05}],
 "legacy": [{"stat": "median", "until": "2026-05-18T11:01:55+02:00"}, {"stat": "min"}],
 "notes": [{"commit": "b4256bc18", "date": "2026-05-18T11:01:55+02:00", "kind": "methodology",
            "label": "Median → minimum", "description": "...", "url": "...",
            "benchmarks": ["performance/kernel/launch"], "rebase": true}]}
```

- `categories`: the first part of every benchmark's name is the `id` of its category. The
  workflow fails (after publishing) when a benchmark is in none of them, and refuses older
  data with such benchmarks.
- `floor`: the smallest change, as a fraction, that counts as unusual in that category.
- `stat`: the statistic changes are judged on.
- `legacy`: which statistic github-action-benchmark's single value per benchmark was; the
  first rule whose `until` the commit's date precedes, or that has none, applies.
- `notes`: changes to how the benchmarks are run, shown as lines on the dashboard, placed
  before the run of `commit` or else the first run after `date`. With `rebase`, values on
  either side are never compared (for the `benchmarks` with one of the given prefixes).

## History: `bench/history.json`

```json
{"version": 2, "repo": "https://github.com/JuliaGPU/CUDA.jl",
 "runs": [{"id": "buildkite:<job>", "commit": "...", "date": "...", "subject": "...",
           "author": "...", "url": "...", "build": "...", "measured": "...",
           "source": "juliagpu", "env": {...}}],
 "benchmarks": {"performance/array/copy": {"unit": "ns", "min": [16200, null, ...], ...}}}
```

Runs are ordered by commit date; every statistic has one value per run, `null` when the run
did not record it. While a package still runs github-action-benchmark, the runs it publishes
in `bench/data.js` are brought in, their value filed under the statistic `legacy` names; the
first run creates the history that way.

## Unusual changes

The noise of a benchmark is the typical change between two consecutive runs: 1.4826 × the
median absolute deviation of the log ratios of its previous 40 changes, after the last note
with `rebase`. A change is unusual when it is more than three times that, and more than the
category's `floor`. In the history, it must also stand out from the level of the three runs
before it and hold at the next run, so neither a single slow run nor the return from one is
counted. Relative changes leave out zeros (a benchmark that does not allocate).

## Tools

`tools/publish.mjs` is what the workflow runs (`append`, `comment`, `check`). It can also
`convert` github-action-benchmark data into a history, and `rename` the benchmarks in either
for a package that moves its benchmarks into categories. Do that before the workflow first
runs with the categories: it refuses data with benchmarks in no category.

```sh
node tools/publish.mjs rename --config perf/benchmark-config.json \
  --map '{"integration/": "applications/", "": "performance/"}' bench/data.js
```

Tests: `node --test test/`.
