# Plan 005: Store connection tokens in the OS keychain instead of plaintext `bridges.json`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- client/src-tauri/src/lib.rs client/src-tauri/Cargo.toml client/src/lib/store.ts client/src/lib/tauri.ts`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the Rust shell + the connection/boot path; a mistake can lock users out of saved connections until they re-enter a token)
- **Depends on**: none (independent; pairs well after 003 so the boot path has some test coverage)
- **Category**: security
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

Per-connection auth tokens are written to disk **in cleartext** inside the app's
config file (`bridges.json`). Any process running as the same user — or anyone
who reads that file from a backup, sync folder, or compromised account — gets
every vault token, i.e. full read/write (and for admin tokens, delete) access to
the team's vaults. This matches the project's own stated position that the only
worthwhile hardening here is "token to keychain + TLS." This plan moves the
secret out of `bridges.json` into the OS secret store (macOS Keychain, Windows
Credential Manager, Linux Secret Service via the `keyring` crate), leaving only a
non-secret reference in the JSON.

## Current state

- `client/src-tauri/Cargo.toml` dependencies (no keychain crate yet):
  ```toml
  tauri = { version = "2", features = ["tray-icon"] }
  tauri-plugin-dialog = "2"
  tauri-plugin-single-instance = "2"
  tauri-plugin-autostart = "2"
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  notify = "6"
  reqwest = { version = "0.12", features = ["stream"] }
  futures-util = "0.3"
  tokio = { version = "1", features = ["time"] }
  ```
- `client/src-tauri/src/lib.rs` persists the whole app config (including tokens)
  as plaintext (lines 256-275):
  ```rust
  fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
      let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
      Ok(dir.join("bridges.json"))
  }
  #[tauri::command]
  fn config_save(app: AppHandle, data: String) -> Result<(), String> {
      let p = config_file(&app)?;
      if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
      fs::write(&p, data).map_err(|e| e.to_string())
  }
  ```
  All custom commands are registered in `invoke_handler` (lines 410-427).
- The frontend `Connection` type and config flow:
  - `client/src/lib/tauri.ts:120-144` — `Connection = { vault, serverUrl, token?, openedAt }`;
    `configSave`/`configLoad` round-trip the JSON (and `token` with it).
  - `client/src/lib/store.ts:805-815` — `persistConnection` writes the connection
    *with its token* into the config:
    ```ts
    const connections: Connection[] = [{ vault, serverUrl, token, openedAt: ... }, ...others];
    await configSave({ connections, lastVault: vault });
    ```
  - `client/src/lib/store.ts:622-626` — `openSession` reads `opts.token` and calls
    `api.setToken(opts.token ?? null)`.
  - `client/src/lib/store.ts:828-851` — `boot()` opens each saved connection
    passing `c.token`.
- The vault path (`connection.vault`) is a stable, unique key per connection
  (it's the local folder path / connId), suitable as the keychain account name.

### Repo conventions to follow

- Rust commands return `Result<T, String>` and are registered in
  `invoke_handler`. New commands must be added there too. Comments in Spanish.
- Frontend Tauri wrappers live in `client/src/lib/tauri.ts`, each guarded by
  `if (!isTauri)` with an in-memory/localStorage fallback for browser mode.
  New secret commands must have a browser fallback (browser mode has no OS
  keychain — fall back to the existing localStorage-config behavior, i.e. keep the
  token in the JSON only in browser mode).

## Commands you will need

| Purpose            | Command                                  | Expected on success |
|--------------------|------------------------------------------|---------------------|
| Add Rust crate     | `cd client/src-tauri && cargo add keyring@3` | adds to Cargo.toml |
| Rust check         | `cd client/src-tauri && cargo check`     | exit 0              |
| Client typecheck   | `cd client && bunx tsc --noEmit`         | exit 0              |
| Client tests       | `cd client && bun run test`              | all pass (if plan 003 landed) |
| Run desktop app    | `cd client && bun run tauri dev`         | app opens           |

## Scope

**In scope** (create/modify):
- `client/src-tauri/Cargo.toml` — add `keyring`.
- `client/src-tauri/src/lib.rs` — add `secret_set` / `secret_get` / `secret_delete` commands; register them.
- `client/src/lib/tauri.ts` — add `secretSet/secretGet/secretDelete` wrappers (with browser fallback) and stop persisting `token` in the saved config in Tauri mode.
- `client/src/lib/store.ts` — write the token to the keychain in `persistConnection`; read it from the keychain when opening saved connections (`boot`/`openSession`); delete it on `removeConnection`.

**Out of scope** (do NOT touch):
- The server (`server/`) — token storage server-side already uses hashes; unchanged.
- `tauri-plugin-stronghold` or any encryption-at-rest of the whole config — only
  the token moves; the rest of `bridges.json` stays plaintext (it has no secrets).
- The in-session token in memory (`BridgesApi.token`) — unchanged.

## Git workflow

- Branch: `advisor/005-token-keychain`.
- Commit style: Spanish `tipo: descripción`, e.g.
  `feat(seguridad): guardar tokens en el keychain del SO, no en bridges.json`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the `keyring` crate and three Rust commands

`cd client/src-tauri && cargo add keyring@3` (the v3 series uses platform-native
stores by default). In `lib.rs`, add commands that key the secret by the
connection's vault path. Service name constant `"bridges"`.

```rust
use keyring::Entry;

const KEYRING_SERVICE: &str = "bridges";

#[tauri::command]
fn secret_set(account: String, secret: String) -> Result<(), String> {
    let e = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    e.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(account: String) -> Result<Option<String>, String> {
    let e = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    let e = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

Register `secret_set, secret_get, secret_delete` in the `invoke_handler!` list
(lib.rs lines 410-427).

> Note on Linux: `keyring` v3 uses the Secret Service (libsecret) by default,
> which needs a running secret service (GNOME Keyring / KWallet). On a headless
> Linux box there may be none — the frontend fallback (Step 4) must tolerate a
> failing `secret_get`/`secret_set` and degrade gracefully. If `cargo check`
> complains about a missing backend feature for Linux, enable the appropriate
> `keyring` feature (e.g. `sync-secret-service`) per the crate's current docs and
> note what you enabled.

**Verify**: `cd client/src-tauri && cargo check` → exit 0.

### Step 2: Add frontend wrappers in `tauri.ts`

Add to `client/src/lib/tauri.ts`, mirroring the existing wrapper style with a
browser fallback. In **browser mode** there is no keychain; keep the existing
behavior of storing the token in the localStorage-backed config (so iterate-in-
browser still works). Use an in-memory map keyed by account for browser mode:

```ts
const memSecrets = new Map<string, string>();

export async function secretSet(account: string, secret: string): Promise<void> {
  if (!isTauri) { memSecrets.set(account, secret); return; }
  await invoke("secret_set", { account, secret });
}
export async function secretGet(account: string): Promise<string | null> {
  if (!isTauri) return memSecrets.get(account) ?? null;
  return (await invoke<string | null>("secret_get", { account })) ?? null;
}
export async function secretDelete(account: string): Promise<void> {
  if (!isTauri) { memSecrets.delete(account); return; }
  await invoke("secret_delete", { account });
}
```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 3: Stop writing the token into the saved config (Tauri mode)

In `client/src/lib/store.ts` `persistConnection` (lines 805-815): write the token
to the keychain and persist the connection **without** the token field in Tauri
mode. Keep browser mode storing it in the config (its `secretSet` is the in-memory
map, which is lost on reload anyway — acceptable for dev). Shape:

```ts
async function persistConnection(vault: string, serverUrl: string, token?: string) {
  try {
    if (token) await secretSet(vault, token);
    else await secretDelete(vault);
    const cfg = await configLoad();
    const others = cfg.connections.filter((c) => c.vault !== vault);
    // En Tauri el token NO va al JSON: vive en el keychain. En browser, el stub
    // de secretSet es en memoria, así que igualmente guardamos token para iterar.
    const conn: Connection = isTauri
      ? { vault, serverUrl, openedAt: new Date().toISOString() }
      : { vault, serverUrl, token, openedAt: new Date().toISOString() };
    const connections: Connection[] = [conn, ...others];
    await configSave({ connections, lastVault: vault });
    setState("connections", connections);
  } catch (e) {
    console.warn("No se pudo guardar la conexión:", e);
  }
}
```

Import `secretSet`, `secretGet`, `secretDelete`, `isTauri` from `./tauri` at the
top of `store.ts` (check the existing import block — `isTauri` is already
imported; add the three secret functions).

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 4: Read the token from the keychain when opening saved connections

Saved connections no longer carry the token in Tauri mode, so fetch it before
opening. Two call sites:

- `boot()` (store.ts ~835): when mapping `cfg.connections` to `openSession`,
  resolve the token first. Replace the token source with a keychain lookup that
  falls back to any token still present in the connection (migration: old configs
  that still have a plaintext token). Sketch:
  ```ts
  cfg.connections.map(async (c) => {
    const token = c.token ?? (await secretGet(c.vault)) ?? undefined;
    // Migración: si el token venía en el JSON viejo, muévelo al keychain y reescríbelo sin token.
    if (c.token) { await secretSet(c.vault, c.token).catch(() => {}); }
    return openSession({ vault: c.vault, serverUrl: c.serverUrl, token }).catch((e) => { ... });
  })
  ```
  Keep the existing `Promise.allSettled` wrapper and error handling. After a
  successful migration, the next `persistConnection`/`configSave` (e.g. on focus
  change) will rewrite the config without the token; optionally rewrite it
  eagerly after boot. Do the minimal thing that removes the plaintext token going
  forward.

- The dropdown "open saved connection" path in `App.tsx` calls `connect(conn)`
  with `conn.token` — but that flows through `openSession`, and for a migrated
  config `conn.token` is undefined. To cover the case where a session is opened
  from a saved connection that has no inline token, make `openSession` fetch from
  the keychain when `opts.token` is undefined:
  ```ts
  // dentro de openSession, antes de api.setToken:
  const token = opts.token ?? (await secretGet(opts.vault)) ?? undefined;
  api.setToken(token ?? null);
  ```
  and use `token` (not `opts.token`) for `startSessionSync` too.

- `removeConnection` (store.ts ~854): after removing from config, also
  `await secretDelete(vault).catch(() => {})` so the keychain entry doesn't leak.

**Verify**: `cd client && bunx tsc --noEmit` → exit 0; `cd client && bun run test`
(if plan 003 landed) → all pass.

### Step 5: Migration + manual end-to-end check in the app

Run `cd client && bun run tauri dev`. With an existing saved connection that has
a token (or add one via "Agregar vault" with a token):
1. Add/open a connection with a token; confirm it connects (role shows, sync works).
2. Quit and relaunch the app. Confirm it auto-reconnects **without** re-entering
   the token (proves the keychain round-trip).
3. Inspect the on-disk config — it must no longer contain the token. Find it via
   the app config dir (macOS: `~/Library/Application Support/com.pepo.bridges/bridges.json`;
   the identifier is `com.pepo.bridges` from `tauri.conf.json`). Confirm no
   `"token"` field (or it's gone after the first save).
4. Remove the connection in the UI; confirm reconnecting later requires the token
   again (keychain entry deleted).

**Verify**: steps 1-4 hold. Specifically: `grep -i token "<app config dir>/bridges.json"`
returns nothing after a save.

## Test plan

- Rust: no unit test framework is set up for the Tauri crate; rely on `cargo check`
  + the manual Step 5 round-trip. (Adding Rust tests is out of scope.)
- Frontend: if plan 003's Vitest is present, the existing browser-mode stubs make
  it possible to add a small test that `persistConnection` (browser mode) keeps
  working — optional, not required to pass this plan.
- The critical verification is the manual Step 5 end-to-end: token survives a
  restart via keychain and is absent from `bridges.json`.

## Done criteria

Machine-checkable + manual:

- [ ] `cd client/src-tauri && cargo check` exits 0
- [ ] `cd client && bunx tsc --noEmit` exits 0
- [ ] `cd client && bun run test` passes (if plan 003 landed)
- [ ] `grep -n "secret_set\|secret_get\|secret_delete" client/src-tauri/src/lib.rs` shows all three defined AND in the invoke_handler list
- [ ] Manual: after adding a token and restarting, the app reconnects without re-entry, and `bridges.json` contains no `"token"` field
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `keyring` v3 API differs from the excerpts (e.g. `delete_credential` vs
  `delete_password`, or `Entry::new` signature) — adapt to the installed
  version's API, and if unsure, report the compile error rather than guessing.
- On the target OS the keychain access prompts repeatedly or fails (e.g. Linux
  with no Secret Service) — report; the frontend must degrade so the app still
  works (offline / re-enter token) rather than crash the boot path.
- Migration would *lose* a user's token (e.g. keychain write fails but you've
  already stripped the token from the JSON) — the safe order is **write to
  keychain first, confirm success, only then drop the token from the JSON**.
  If you can't guarantee that order, STOP.
- Tokens turn out to be needed in a context where neither the keychain nor the
  in-memory api token is available — report it.

## Maintenance notes

- The keychain account key is the connection's `vault` (local folder path). If
  that key scheme ever changes, add a migration to move existing keychain entries.
- A reviewer must verify the **ordering** invariant: keychain write succeeds
  before the plaintext token is removed from `bridges.json`, so a failed write
  never loses the only copy of the token.
- This addresses at-rest storage only; in transit, tokens still rely on TLS
  (deploy behind HTTPS) — that's a deployment concern, not code.
- Browser mode intentionally keeps the token in the localStorage config (no OS
  keychain in a plain browser); that's a dev convenience, not the shipped path.
