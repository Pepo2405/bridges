# Plan 003: Stand up a client test runner and characterize the sync state machine (`reconcile.ts`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- client/src/lib/reconcile.ts client/package.json client/vite.config.ts`
> If `reconcile.ts` changed since this plan was written, compare the "Current
> state" excerpts (especially the `classify()` decision table) against the live
> code before writing tests; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (adds tooling + tests; touches no production logic)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

The offline-first sync engine is the most complex and highest-churn code in the
repo, and it has **zero tests**. The pure decision function
`reconcile.ts:classify()` has nine branches (push/pull/merge/create/the four
delete-vs-edit cases/noop) — a wrong branch silently loses data, resurrects
deleted notes, or duplicates them. `threeWayMerge()` wraps `node-diff3` and
decides clean-merge vs. conflict. These are pure and trivially unit-testable, yet
nothing exercises them except the full app at runtime. This plan adds a real test
runner to the client (there is none today) and pins the sync state machine with
characterization tests. It is a prerequisite for safely refactoring `store.ts`
later, and gives every future change a fast feedback loop.

## Current state

- `client/package.json` has **no** test script and no test runner dependency.
  Scripts today:
  ```json
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview", "tauri": "tauri" }
  ```
  `vite-plugin-solid` and `vite` are already devDependencies.
- There is **no** `client/vite.config.ts` checked in for tests; Vite config is
  implicit/handled by the Tauri tooling for dev/build. You will add a Vitest
  config. (Confirm with `ls client/vite.config.*` — if one exists, extend it
  instead of creating a new one; see STOP.)
- `client/src/lib/reconcile.ts` is **pure-importable in plain Node**: its only
  runtime imports are `node-diff3` (an npm package) and `./tauri`
  (`indexLoad`/`indexSave`), and `./api` is a `type`-only import. `tauri.ts`
  performs all `@tauri-apps/api` access via **dynamic** `import()` inside
  functions, gated by `isTauri = "__TAURI_INTERNALS__" in window`. At module load
  in Node, `window` is undefined → `isTauri` is false → no Tauri import fires.
  **Therefore importing `reconcile.ts` in a Node-environment test needs no
  Tauri mocking.**
- The functions under test (`client/src/lib/reconcile.ts`):

  `sha256` (lines 102-108) — async, uses Web Crypto `crypto.subtle`. Available in
  modern Node (≥ 20) and Bun as a global. Returns `sha256:<hex>`.

  `threeWayMerge` (lines 118-125):
  ```ts
  export function threeWayMerge(local, base, remote): { conflict: boolean; result: string } {
    const r = diff3(local.split("\n"), base.split("\n"), remote.split("\n"));
    return { conflict: r.conflict, result: r.result.join("\n") };
  }
  ```

  `classify` (lines 153-187) — the state machine. Its decision table:
  ```
  No base:
    onDisk && remoteLive  -> diskHash===remoteHash ? "pull" : "merge"
    onDisk only           -> "create"
    remoteLive only       -> "pull"
    neither               -> "noop"
  With base:
    localChanged  = onDisk ? diskHash !== base.synced_hash : true
    localDeleted  = !onDisk
    remoteChanged = remoteLive ? remoteLive.version !== base.base_version : true
    remoteGone    = !remoteLive
    !localChanged && !remoteChanged                 -> "noop"
    localDeleted && remoteGone                      -> "pull-delete"
    localDeleted && remoteLive                      -> remoteChanged ? "delete-vs-edit" : "push-delete"
    remoteDeleted && onDisk                         -> localChanged ? "edit-vs-delete" : "pull-delete"
    localChanged && remoteChanged                   -> "merge"
    localChanged                                    -> "push"
    remoteChanged                                   -> "pull"
    else                                            -> "noop"
  ```
  Inputs: `{ onDisk, diskHash, remoteHash, base: IndexEntry | undefined, remote: Doc | undefined }`.
  `remote` may carry `deleted: 1`. `IndexEntry` shape is at lines 19-27;
  `Doc` shape is in `client/src/lib/api.ts:3-13`.

### Repo conventions to follow

- TypeScript `strict`. Use the `~/` path alias? `reconcile.ts` is imported by
  `store.ts` as `import * as idx from "./reconcile"`. In tests, import relatively
  (`../reconcile` or `~/lib/reconcile`); the alias `~/*` → `src/*` is configured
  in `tsconfig.json` and must be mirrored in the Vitest config (see Step 2).
- Match existing comment language (Spanish) where you add explanatory comments.

## Commands you will need

| Purpose         | Command                                  | Expected on success |
|-----------------|------------------------------------------|---------------------|
| Add test deps   | `cd client && bun add -d vitest`         | exit 0              |
| Run tests       | `cd client && bun run test`              | all pass (after Step 3) |
| Run once (CI)   | `cd client && bunx vitest run`           | all pass            |
| Typecheck       | `cd client && bunx tsc --noEmit`         | exit 0              |

## Scope

**In scope** (create/modify):
- `client/package.json` — add `vitest` devDep and a `test` script.
- `client/vitest.config.ts` (create) — Vitest config with the `~` alias and the Solid plugin.
- `client/src/lib/reconcile.test.ts` (create) — the tests.

**Out of scope** (do NOT touch):
- `client/src/lib/reconcile.ts` — this plan tests it as-is. If you believe a test
  reveals a bug, **do not fix it here** — record it and STOP (a fix is a separate plan).
- `client/src/lib/store.ts` — store-level integration tests are a deliberate
  follow-up (see "Maintenance notes"); do not attempt them in this plan.
- `client/tsconfig.json`, `client/src-tauri/*`.

## Git workflow

- Branch: `advisor/003-client-tests`.
- Commit style: Spanish `tipo: descripción`, e.g.
  `test: vitest en el cliente + tests de classify()/threeWayMerge`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add Vitest

```
cd client && bun add -d vitest
```

Then add a `test` script to `client/package.json` scripts:
```json
"test": "vitest run"
```
(Use `vitest run` — non-watch — so CI and `bun run test` exit cleanly.)

**Verify**: `cd client && bun run test` → exits with "No test files found" (or
similar) and a clean exit; this confirms the runner is installed and wired.

### Step 2: Add `client/vitest.config.ts`

Create `client/vitest.config.ts`. Use the Node test environment (the reconcile
tests need no DOM) and mirror the `~` → `src` alias so imports resolve. The Solid
plugin is not required for pure-module tests but include it so future component
tests work:

```ts
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { "~": resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0 (config file typechecks
within the project? It may be excluded by tsconfig `include: ["src"]`; if `tsc`
ignores it that's fine). `cd client && bun run test` still reports no test files
(until Step 3).

### Step 3: Write `client/src/lib/reconcile.test.ts`

Create the test file covering every `classify()` branch, plus `threeWayMerge` and
`sha256`. Use Vitest's `describe/it/expect`. Build small helpers for the inputs.
A `Doc` needs at least `{ id, path, content, version, seq, deleted, title:null,
updated_by:null, updated_at:"" }`; an `IndexEntry` needs `{ id, base_version,
base_content, synced_hash, dirty:false, deleted:false, updated_at:"" }`.

Cover at minimum these cases (assert the exact `Decision` string):

No-base group:
- onDisk + remoteLive, identical hashes → `"pull"`
- onDisk + remoteLive, different hashes → `"merge"`
- onDisk only → `"create"`
- remoteLive only → `"pull"`
- neither → `"noop"`

With-base group:
- nothing changed (disk hash === synced_hash, remote version === base_version) → `"noop"`
- local edited only → `"push"`
- remote edited only → `"pull"`
- both edited → `"merge"`
- local deleted (not onDisk), remote unchanged & live → `"push-delete"`
- local deleted, remote also gone/deleted → `"pull-delete"`
- local deleted, remote edited (live, version changed) → `"delete-vs-edit"`
- remote deleted, local unchanged on disk → `"pull-delete"`
- remote deleted, local edited on disk → `"edit-vs-delete"`

`threeWayMerge`:
- non-overlapping edits (local changes line 1, remote changes line 3, common
  base) → `conflict === false` and `result` contains both edits.
- overlapping edits (local and remote change the same line differently) →
  `conflict === true` and `result` contains `<<<<<<<`.

`sha256`:
- same input twice → equal, prefixed `sha256:`; different input → different.

Structural pattern to follow (keep it terse and table-driven where sensible):

```ts
import { describe, it, expect } from "vitest";
import { classify, threeWayMerge, sha256, type IndexEntry, type ClassifyInput } from "~/lib/reconcile";
import type { Doc } from "~/lib/api";

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: "id1", path: "a.md", title: null, content: "c", version: 1, seq: 1,
  deleted: 0, updated_by: null, updated_at: "", ...over,
});
const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  id: "id1", base_version: 1, base_content: "base", synced_hash: "sha256:base",
  dirty: false, deleted: false, updated_at: "", ...over,
});
const input = (over: Partial<ClassifyInput>): ClassifyInput => ({
  onDisk: true, diskHash: null, remoteHash: null, base: undefined, remote: undefined, ...over,
});

describe("classify - sin base", () => {
  it("disco + remoto idénticos -> pull", () => {
    expect(classify(input({ onDisk: true, diskHash: "sha256:x", remoteHash: "sha256:x", remote: doc() }))).toBe("pull");
  });
  // ... resto de los casos ...
});
```

Note: in the with-base cases, set `diskHash` relative to `base.synced_hash` to
control `localChanged`, and set `remote.version` relative to `base.base_version`
to control `remoteChanged`. For "local edited only": `base = entry({synced_hash:"sha256:base"})`,
`diskHash:"sha256:edited"`, `remote = doc({version:1})`, `remoteHash:"sha256:base"` →
expect `"push"`.

**Verify**: `cd client && bun run test` → all tests pass; the suite reports the
number of `classify` cases you wrote (≥ 14) plus the merge and sha256 tests.

## Test plan

- New file `client/src/lib/reconcile.test.ts` is the deliverable. It covers all
  nine `Decision` values across the no-base and with-base groups, the two
  `threeWayMerge` outcomes, and `sha256` determinism.
- There is no existing client test to model after (this is the first). Model the
  structure on the server's table-driven style in `server/test/api.test.ts`
  (small helpers + focused `test(...)` calls).
- Verification: `cd client && bun run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd client && bun run test` exits 0 with ≥ 17 passing tests
- [ ] `client/package.json` has a `test` script and `vitest` under devDependencies
- [ ] `client/vitest.config.ts` exists
- [ ] `client/src/lib/reconcile.test.ts` exists and imports from `~/lib/reconcile`
- [ ] `cd client && bunx tsc --noEmit` exits 0
- [ ] `client/src/lib/reconcile.ts` is unchanged (`git diff --stat 972d692..HEAD -- client/src/lib/reconcile.ts` shows no production-code change)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A test you wrote according to the decision table in "Current state" **fails** —
  that means either the table drifted or there is a real `classify()` bug. Do NOT
  edit `reconcile.ts` to make the test pass; report the input, the expected
  decision, and the actual decision.
- `crypto.subtle` is undefined in the test runtime (older Node). Report it; the
  fix is to run via `bunx vitest run` (Bun provides Web Crypto) or set
  `environment: "jsdom"` — but check before changing the config.
- A `client/vite.config.ts` already exists (merge configs instead of adding a
  second one).
- Importing `~/lib/reconcile` pulls in `@tauri-apps/api` and crashes (means
  `tauri.ts` gained a top-level static Tauri import since this plan was written).

## Maintenance notes

- **Deliberately deferred**: characterization tests for `store.ts` (the queue,
  `flushQueue`, `mergeConflict`, `applyDocs`, offline `saveDoc`). They are
  higher-effort because they exercise the in-memory Tauri stubs (browser mode)
  and SolidJS `createStore`, and may need `environment: "jsdom"`. Do them as a
  follow-up plan once this runner exists — and definitely before any refactor
  that extracts the sync engine out of `store.ts`.
- When `classify()` gains or changes a branch, update this test file in lockstep;
  it is the executable spec for the decision table.
- Plan 001 (XSS) leaves a follow-up note to add `markdown.test.ts` once this
  runner exists — a good second test file.
