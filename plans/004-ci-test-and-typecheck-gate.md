# Plan 004: Add a CI gate that runs tests and typecheck on every push/PR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- .github/workflows server/package.json client/package.json`
> If the workflows or package scripts changed since this plan was written,
> reconcile before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/003-client-test-infra-and-reconcile-tests.md (for the client `test` script; the server/typecheck steps work without it)
- **Category**: dx
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

The repo's only workflow (`release.yml`) just **builds installers on tag push**.
The server has a real integration test suite (`server/test/api.test.ts`) but
**CI never runs it**, and there is no typecheck gate, so type errors and broken
tests can land on `main` and even ship in a release unnoticed. A small
`ci.yml` that runs the server tests, the client tests, and a TypeScript
`--noEmit` typecheck on every push and PR turns the existing-but-invisible safety
net into an actual gate. This is the cheapest high-leverage DX win available.

## Current state

- `.github/workflows/release.yml` — the only workflow. Triggers on `push` tags
  `v*` and `workflow_dispatch`; builds with `tauri-apps/tauri-action`. It does
  **not** run `bun test` or `tsc`.
- Server tests run with `cd server && bun test` (Bun's built-in test runner; the
  suite spawns the server over HTTP on ports 4501-4507).
- Client typecheck: `cd client && bunx tsc --noEmit` (tsconfig has
  `strict: true, noEmit: true`). There is no `typecheck` script yet.
- Client tests: after plan 003, `cd client && bun run test` (Vitest, non-watch).
  If plan 003 has **not** landed yet, the client `test` script will not exist —
  this plan handles that with a guard (see Step 2).
- CI runner uses `oven-sh/setup-bun@v2` (see `release.yml` for the exact action).
- The server suite needs no system libraries (pure Bun). The client tests
  (Vitest/Node) need `bun install` in `client/` for `vitest`. Neither needs the
  Tauri/Linux GTK system deps that `release.yml` installs — keep CI lean and do
  **not** build the Tauri app here.

### Repo conventions to follow

- Workflow comments in `release.yml` are in Spanish; match that tone in the new file.
- Use the same Bun setup action already in `release.yml` (`oven-sh/setup-bun@v2`).

## Commands you will need

| Purpose            | Command                              | Expected on success |
|--------------------|--------------------------------------|---------------------|
| Server tests       | `cd server && bun test`              | all pass            |
| Client typecheck   | `cd client && bunx tsc --noEmit`     | exit 0              |
| Client install     | `cd client && bun install`           | exit 0              |
| Client tests       | `cd client && bun run test`          | all pass (needs plan 003) |
| Validate workflow YAML | `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` | no error |

## Scope

**In scope** (create/modify):
- `.github/workflows/ci.yml` (create) — the test + typecheck gate.
- `client/package.json` (modify) — add a `typecheck` script (small convenience; optional but recommended).

**Out of scope** (do NOT touch):
- `.github/workflows/release.yml` — leave the release pipeline alone.
- Any source files — this plan adds CI only. If `bun test` or `tsc` currently
  fails locally on `main`, that is a pre-existing failure: report it (STOP),
  don't fix code here.

## Git workflow

- Branch: `advisor/004-ci-gate`.
- Commit style: Spanish `tipo: descripción`, e.g.
  `ci: correr tests (server+client) y typecheck en push/PR`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 0: Confirm the suite is green locally first

Run `cd server && bun test` and `cd client && bunx tsc --noEmit`. If plan 003 has
landed, also run `cd client && bun run test`.

**Verify**: all pass. If any fail on a clean `main`, STOP and report — CI should
codify a green baseline, not a red one.

### Step 1: Add a `typecheck` script to the client

In `client/package.json` scripts, add:
```json
"typecheck": "tsc --noEmit"
```

**Verify**: `cd client && bun run typecheck` → exit 0.

### Step 2: Create `.github/workflows/ci.yml`

Create the workflow. It runs on pushes to `main` and on all PRs. Two jobs (server,
client) so failures are isolated. Guard the client `test` step so the workflow
still works if plan 003 hasn't landed (run it only if the script exists).

```yaml
name: CI

# Corre tests y typecheck en cada push a main y en cada PR. No compila la app
# (eso lo hace release.yml en los tags). Es el gate de calidad del repo.

on:
  push:
    branches: [main]
  pull_request: {}

jobs:
  server:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
      - name: Server tests
        run: bun test
        working-directory: ./server

  client:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
      - name: Install deps
        run: bun install
        working-directory: ./client
      - name: Typecheck
        run: bunx tsc --noEmit
        working-directory: ./client
      - name: Client tests
        # Corre solo si existe el script `test` (lo agrega el plan 003).
        run: |
          if bun run --silent test --version >/dev/null 2>&1 || grep -q '"test"' package.json; then
            bun run test
          else
            echo "no client test script yet — skipping"
          fi
        working-directory: ./client
```

**Verify**:
- YAML parses: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → no output, exit 0.
- The commands inside mirror what you ran locally in Step 0 and they pass locally.

### Step 3: (If you can) trigger the workflow

If the operator allows pushing a branch and opening a PR, push and confirm both
jobs go green in the Actions tab. If not, the local verification in Step 0 plus
YAML validity is sufficient for this plan — note in your report that the workflow
hasn't run on GitHub yet.

## Test plan

- This plan adds no unit tests; its "test" is that CI runs the existing suites.
- The guard in the client `test` step is verified by reading it: it runs
  `bun run test` only when a `test` script exists, otherwise prints a skip
  message and succeeds (so the workflow is valid both before and after plan 003).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists and parses as valid YAML
- [ ] `cd server && bun test` passes locally
- [ ] `cd client && bun run typecheck` exits 0
- [ ] `client/package.json` has a `typecheck` script
- [ ] `release.yml` is unchanged (`git diff --stat 972d692..HEAD -- .github/workflows/release.yml` empty)
- [ ] No source files modified (`git status` shows only the workflow + package.json)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `cd server && bun test` or `cd client && bunx tsc --noEmit` fails on a clean
  `main` (pre-existing breakage — report it; do not patch source in this plan).
- The CI ports the server tests use (4501-4507) conflict in the runner
  environment and tests hang/fail only in CI — report; the fix may be to
  randomize ports, which is a separate change.
- `oven-sh/setup-bun@v2` is no longer the action used in `release.yml` (use
  whatever the repo standardized on).

## Maintenance notes

- When plan 003 lands the client `test` script, the guard in Step 2 starts running
  Vitest automatically — no workflow change needed. You may later simplify the
  guard to a plain `bun run test` once 003 is merged.
- If a `lint`/`format` setup is added later, add those as CI steps too.
- Consider making this workflow a required status check on `main` in the repo
  settings (operator action, outside this plan).
- The server suite spawns real servers on fixed ports; if it becomes flaky in CI,
  that's the first thing to revisit.
