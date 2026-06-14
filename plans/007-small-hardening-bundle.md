# Plan 007: Small hardening bundle (constant-time token compare, doc'd env vars, esbuild bump, Rust lock-poison recovery)

> **Executor instructions**: Follow this plan step by step. Each step is
> independent — you may do them in any order, but run each step's verification
> before moving on. If anything in "STOP conditions" occurs, stop and report.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- server/src/auth.ts README.md client/package.json client/src-tauri/src/lib.rs`
> Compare the "Current state" excerpts against the live code before editing.

## Status

- **Priority**: P3
- **Effort**: S (four small, independent changes)
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / dx / docs
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

Four low-cost hardening/cleanup items that don't individually warrant a plan but
are worth doing together:

1. **Constant-time bootstrap-token compare** — the env "server owner" token is
   compared with `===`, a non-constant-time comparison. Low practical risk over a
   network, but trivial to make right.
2. **Undocumented operational env vars** — the anti-vaciado circuit breaker is
   tunable via `BRIDGES_DELETE_LIMIT` / `BRIDGES_DELETE_WINDOW`, but the README
   only lists four env vars, so operators can't tune it without reading code.
3. **Dev-time `esbuild` advisory** — `vite → esbuild` flags a HIGH advisory in
   `bun audit` (build-time only, not shipped), fixable with a version bump.
4. **Rust mutex `.lock().unwrap()`** — a panic while holding `WatcherState` /
   `StreamState` would poison the mutex and crash every later access. Recovering
   the poisoned guard is a one-line idiom.

## Current state

1. `server/src/auth.ts` already imports `createHash`. The bootstrap compare
   (line 50) and the `hash` helper (line 26):
   ```ts
   const hash = (t: string) => createHash("sha256").update(t).digest("hex");
   // ...
   if (BOOTSTRAP && token === BOOTSTRAP) return { name: "admin", role: "admin", vault: "default", isOwner: true };
   ```

2. `README.md:113`:
   ```
   Variables de entorno: `PORT`, `BRIDGES_DB`, `BRIDGES_VAULT`, `BRIDGES_TOKEN` (auth simple opcional).
   ```
   But `server/src/guard.ts:8-9` also reads:
   ```ts
   export const DELETE_LIMIT = Number(process.env.BRIDGES_DELETE_LIMIT ?? 10);
   const WINDOW_MS = Number(process.env.BRIDGES_DELETE_WINDOW ?? 60) * 1000;
   ```

3. `client/package.json` — `vite: ^6.0.3` (dev). `bun audit` (run in `client/`)
   reports a HIGH advisory on the transitive `esbuild`. The fix is to update Vite
   so it resolves a patched `esbuild` (≥ 0.25.x).

4. `client/src-tauri/src/lib.rs` — four `.lock().unwrap()` on the two state
   mutexes:
   - line 195: `state.0.lock().unwrap().insert(conn_id, watcher);`
   - line 202: `state.0.lock().unwrap().remove(&conn_id);`
   - line 280: `if let Some(g) = state.0.lock().unwrap().get(&conn_id) {`
   - line 299: `let mut map = state.0.lock().unwrap();`

### Repo conventions

- Server/client TS: strict, semicolons, Spanish comments. Rust: `Result<_,String>`
  commands, Spanish comments.

## Commands you will need

| Purpose          | Command                                  | Expected on success |
|------------------|------------------------------------------|---------------------|
| Server tests     | `cd server && bun test`                  | all pass            |
| Client audit     | `cd client && bun audit`                 | no HIGH/CRITICAL after Step 3 |
| Client build     | `cd client && bun run build`             | exit 0              |
| Rust check       | `cd client/src-tauri && cargo check`     | exit 0              |

## Scope

**In scope**:
- `server/src/auth.ts` (Step 1)
- `README.md` (Step 2)
- `client/package.json` + `client/bun.lock` (Step 3, via update)
- `client/src-tauri/src/lib.rs` (Step 4)

**Out of scope**: everything else. Do not refactor surrounding code.

## Git workflow

- Branch: `advisor/007-hardening`.
- Commit style: Spanish `tipo: descripción`. You may use one commit per step or
  one combined commit, e.g. `chore(seguridad): compare constante de token, env docs, esbuild, lock-poison`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Constant-time bootstrap token comparison

In `server/src/auth.ts`, import `timingSafeEqual` and compare the SHA-256 digests
of the candidate and the bootstrap token (equal length, so no length leak, and
constant-time). Replace line 50's `token === BOOTSTRAP`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// ...
function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb); // ambos 32 bytes
}
// ...
if (BOOTSTRAP && sameSecret(token, BOOTSTRAP))
  return { name: "admin", role: "admin", vault: "default", isOwner: true };
```

Leave the DB-token lookup (`qIdentByHash.get(hash(token))`) as-is — it's an
indexed hash lookup, not a string compare of the secret.

**Verify**: `cd server && bun test` → all pass (the auth/bootstrap tests in
`api.test.ts` still authenticate the `ADMIN`/`BRIDGES_TOKEN` bootstrap token).

### Step 2: Document the circuit-breaker env vars in the README

In `README.md`, update the env-vars line (line ~113) to include all six, with
defaults. Replace:
```
Variables de entorno: `PORT`, `BRIDGES_DB`, `BRIDGES_VAULT`, `BRIDGES_TOKEN` (auth simple opcional).
```
with:
```
Variables de entorno: `PORT` (4321), `BRIDGES_DB`, `BRIDGES_VAULT`, `BRIDGES_TOKEN` (auth simple opcional), `BRIDGES_DELETE_LIMIT` (10) y `BRIDGES_DELETE_WINDOW` (60, en segundos) — umbral/ventana de la guardia anti-vaciado.
```

**Verify**: `grep -n "BRIDGES_DELETE_LIMIT" README.md` → matches; `grep -n
"BRIDGES_DELETE_WINDOW" README.md` → matches. Cross-check the names against the
code: `grep -n "BRIDGES_DELETE" server/src/guard.ts` → same two names.

### Step 3: Resolve the dev `esbuild` advisory

First confirm the advisory: `cd client && bun audit` (note the esbuild advisory).
Then bump Vite so it pulls a patched esbuild:
```
cd client && bun update vite
```
Re-run `cd client && bun audit`. If the HIGH esbuild advisory is gone, done. If it
persists (Vite's pinned esbuild range still old), add an override to
`client/package.json` and reinstall:
```json
"overrides": { "esbuild": ">=0.25.0" }
```
then `cd client && bun install`.

**Verify**:
- `cd client && bun audit` → no HIGH/CRITICAL advisories (esbuild resolved).
- `cd client && bun run build` → exit 0 (the build still works with the new esbuild).
- `cd client && bunx tsc --noEmit` → exit 0.

### Step 4: Recover poisoned mutex locks in Rust

In `client/src-tauri/src/lib.rs`, replace each `.lock().unwrap()` on the state
mutexes with a poison-recovering form so a panic elsewhere can't cascade into a
crash on every later access:

```rust
// antes: state.0.lock().unwrap()
// después:
state.0.lock().unwrap_or_else(|e| e.into_inner())
```

Apply to all four sites (lines 195, 202, 280, 299). `unwrap_or_else(|e|
e.into_inner())` takes ownership of the guarded value even if the lock was
poisoned — appropriate here because the guarded `HashMap` is still structurally
valid (these critical sections only insert/remove/get).

**Verify**: `cd client/src-tauri && cargo check` → exit 0. `grep -n
"lock().unwrap()" client/src-tauri/src/lib.rs` → no matches (all replaced).

## Test plan

- Step 1 is covered by the existing server auth tests (`bun test`) — the bootstrap
  token must still authenticate.
- Steps 2-4 have no unit tests; verification is the grep/audit/`cargo check`
  commands above.
- No new tests required (no behavior change beyond hardening).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd server && bun test` exits 0
- [ ] `grep -n "timingSafeEqual" server/src/auth.ts` matches; `grep -n "token === BOOTSTRAP" server/src/auth.ts` returns nothing
- [ ] `README.md` lists `BRIDGES_DELETE_LIMIT` and `BRIDGES_DELETE_WINDOW`
- [ ] `cd client && bun audit` reports no HIGH/CRITICAL; `cd client && bun run build` exits 0
- [ ] `cd client/src-tauri && cargo check` exits 0; `grep -n "lock().unwrap()" client/src-tauri/src/lib.rs` returns nothing
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `cd server && bun test` fails after Step 1 (the bootstrap auth path broke —
  check that `sameSecret` is called only for the bootstrap branch, not the DB path).
- `bun update vite` forces a Vite major (e.g. 7.x) with breaking changes, or the
  build breaks — report; pin a safe patched version instead.
- `cargo check` fails after Step 4 (the mutex type isn't `std::sync::Mutex`, or
  the closure type doesn't match) — report the error.

## Maintenance notes

- The constant-time compare hashes both inputs; if the token scheme changes,
  `sameSecret` still works (it hashes whatever it's given).
- Keep the README env-var list in sync with `process.env` reads in the server —
  a reviewer can diff `grep -rn "process.env" server/src` against the README.
- `unwrap_or_else(|e| e.into_inner())` is safe here only because the guarded data
  stays consistent across panics. If future critical sections leave the map in a
  half-updated state on panic, revisit.
