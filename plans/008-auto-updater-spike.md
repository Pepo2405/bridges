# Plan 008 (design/spike): Evaluate and prototype a Tauri auto-updater

> **Executor instructions**: This is a **design/spike** plan, not a
> build-everything plan. The deliverable is a written recommendation
> (`docs/superpowers/specs/auto-updater-design.md`) plus a minimal, reversible
> prototype behind which the open questions are answered. Do NOT ship an
> always-on auto-updater to users in this plan. Run the verification steps and,
> if a STOP condition occurs, stop and report. Update the status row in
> `plans/README.md` when done.

## Status

- **Priority**: P3
- **Effort**: M (spike; full rollout is a follow-up)
- **Risk**: MED (auto-update is a supply-chain-sensitive surface; getting it wrong ships bad/unsigned updates to everyone)
- **Depends on**: code-signing (see "Hard dependency" below) — the updater needs signed update artifacts, so this spike must resolve signing as part of its design
- **Category**: direction
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

Today, updating Bridges means a user manually downloading a new installer and
reinstalling (README "Publicar una versión nueva"; the project's own notes flag
"sin auto-update; actualizar = rebuild + reemplazar" as a known gap). For a tool
that holds a team's documents, a fast patch path matters — especially given the
XSS/security fixes in flight (plans 001/002/005), which you'd want to reach users
without a manual reinstall. Tauri 2 ships a first-party updater plugin, so the
capability is "close." But it has real prerequisites (update signing, artifact
hosting, and this repo is **private**), so this is a spike to decide *whether and
how*, not a blind integration.

## Current state (facts the spike starts from)

- `client/src-tauri/Cargo.toml` — no `tauri-plugin-updater`; current plugins are
  dialog, single-instance, autostart.
- `client/package.json` — no `@tauri-apps/plugin-updater`.
- `client/src-tauri/tauri.conf.json` — no `plugins.updater` block; app is
  distributed **unsigned (ad-hoc)** (README "Sin firmar (ad-hoc)").
- `.github/workflows/release.yml` — builds with `tauri-apps/tauri-action@v0` on
  tag push, across macOS (universal) / Ubuntu / Windows, and publishes a GitHub
  Release. It has placeholder comments for future Apple/Windows code-signing
  secrets (lines 68-71) but no signing configured.
- The GitHub repo is **private** (README: "El repo es privado: hay que estar
  logueado en GitHub con acceso al repo para descargarlos"). This is the crux: a
  Tauri updater endpoint pointing at GitHub release assets of a private repo
  cannot be fetched anonymously.
- App identifier: `com.pepo.bridges`; productName `Bridges`.

### Two distinct "signings" — don't conflate them

1. **Update signature** (required by the updater): Tauri's updater verifies each
   update with a **minisign** keypair you generate (`TAURI_SIGNING_PRIVATE_KEY` +
   `pubkey` in `tauri.conf.json`). This is independent of OS code-signing and is
   non-negotiable for the updater to work.
2. **OS code-signing / notarization** (Apple Developer ID, Windows cert): separate,
   about Gatekeeper/SmartScreen, tracked elsewhere in the backlog. The updater can
   work *without* OS code-signing, but unsigned updates still trip Gatekeeper on
   install. Note the interaction in the design.

## Commands you will need

| Purpose            | Command                                  | Expected |
|--------------------|------------------------------------------|----------|
| Read Tauri updater docs | (use Context7 / official docs — see toolkit) | — |
| Add JS plugin (prototype) | `cd client && bun add @tauri-apps/plugin-updater` | exit 0 |
| Add Rust plugin (prototype) | `cd client/src-tauri && cargo add tauri-plugin-updater` | exit 0 |
| Generate signing key (prototype) | `cd client && bunx @tauri-apps/cli signer generate -w ~/.tauri/bridges-updater.key` | prints pubkey |
| Rust check         | `cd client/src-tauri && cargo check`     | exit 0 |
| Client typecheck   | `cd client && bunx tsc --noEmit`         | exit 0 |

## Suggested executor toolkit

- Use the **claude-code-guide** or a docs lookup (Context7 `resolve-library-id` →
  `query-docs` for `tauri-apps/plugins-workspace` / Tauri v2 updater) to get the
  *current* updater config schema and the `tauri-action` updater inputs — the API
  has moved between Tauri 2 minor versions; do not rely on memory.

## Scope

**In scope** (this spike):
- `docs/superpowers/specs/auto-updater-design.md` (create) — the recommendation +
  decisions + open questions (the primary deliverable).
- A **reversible prototype** to de-risk the design, isolated so it can be reverted:
  - `client/package.json`, `client/src-tauri/Cargo.toml` — add the updater plugins.
  - `client/src-tauri/src/lib.rs` — register the updater plugin.
  - `client/src-tauri/tauri.conf.json` — `plugins.updater` block with the prototype pubkey + a placeholder endpoint.
  - A "Check for updates" menu item or Settings action wired to the plugin
    (manual trigger only — no silent auto-install).

**Out of scope**:
- Committing any private signing key (NEVER commit the key; it goes in
  `~/.tauri/` and, for CI, a GitHub secret — reference only).
- Turning on automatic/silent updates for all users.
- Production CI changes to `release.yml` (the design *proposes* them; implementing
  them is a follow-up once the design is approved).
- OS code-signing/notarization (separate backlog item).

## Steps

### Step 1: Answer the blocking questions (research, write them down)

Before any code, resolve and document in the design doc:
1. **Artifact hosting for a private repo.** A Tauri updater endpoint must serve a
   `latest.json` + signed artifacts the app can fetch. GitHub release assets of a
   **private** repo require auth. Options to evaluate and pick one:
   - Make releases (or a dedicated updates repo) public while keeping source private.
   - Host `latest.json` + artifacts behind the Bridges server / a small static
     host the team can reach (possibly token-gated, matching the app's existing auth).
   - Use a third-party (e.g. a CDN bucket).
   Document the trade-offs (auth complexity vs. exposure) and recommend one.
2. **Signing key custody.** Where does `TAURI_SIGNING_PRIVATE_KEY` live (CI secret),
   who holds the backup, what's the rotation story if it leaks.
3. **Interaction with OS code-signing.** Will updates still hit Gatekeeper/
   SmartScreen until OS code-signing lands? Note the user-visible impact.

**Verify**: the design doc contains a decision (not just options) for each of the
three, with a one-paragraph rationale.

### Step 2: Prototype the happy path locally (reversible)

To prove the mechanism end-to-end on one platform (the executor's OS):
- Generate a minisign keypair (command above); record the **public** key.
- Add the JS + Rust updater plugins; register the Rust plugin in `lib.rs`
  `tauri::Builder` chain.
- Add a `plugins.updater` block to `tauri.conf.json` with the pubkey and a
  placeholder/local endpoint.
- Wire a manual "Buscar actualizaciones" action (Settings dialog or tray menu)
  that calls the updater's check/download/install and surfaces progress/errors in
  the existing notice UI.
- Build two versions (vN, vN+1), publish vN+1's signed artifact + `latest.json` to
  a **local** file server, and confirm the app running vN detects, downloads,
  verifies the signature, and installs vN+1.

**Verify**: `cd client/src-tauri && cargo check` exits 0; `cd client && bunx tsc
--noEmit` exits 0; and the manual local update round-trip succeeds (vN → vN+1).
Capture what worked / what was fiddly in the design doc.

### Step 3: Write the rollout recommendation

In `docs/superpowers/specs/auto-updater-design.md`, finalize:
- Recommended hosting + signing approach (from Step 1).
- The exact `tauri.conf.json` updater config and the `release.yml` changes needed
  (the `tauri-action` updater inputs / `latest.json` generation, the
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets).
- UX decision: manual "check for updates" first, silent auto-update later (or not).
- A go/no-go recommendation and the follow-up implementation tasks (sized).
- Open questions that remain.

**Verify**: the design doc is complete enough that a follow-up implementation plan
could be written from it without re-researching.

### Step 4: Decide whether to keep or revert the prototype

Based on Step 1's answers (especially the private-repo hosting question), either:
- Keep the prototype wired behind a manual action (if the design is a "go" and the
  config is safe to have in-tree with a placeholder endpoint), **or**
- Revert the code changes (`git checkout` the touched source files) and leave only
  the design doc, if the design says "not yet" (e.g. hosting unresolved).

Document which you did and why.

**Verify**: `git status` reflects the decision; if reverted, only the design doc
remains; if kept, `cargo check` + `tsc --noEmit` pass and the menu action exists.

## Done criteria

- [ ] `docs/superpowers/specs/auto-updater-design.md` exists with decisions for the three blocking questions, the proposed config + CI changes, and a go/no-go
- [ ] The local update round-trip (vN → vN+1, signature verified) was demonstrated and its result recorded in the doc
- [ ] No private signing key is committed (`git status` shows no `.key`/secret; `grep -rn "PRIVATE KEY" client` finds nothing committed)
- [ ] If the prototype is kept: `cargo check` + `bunx tsc --noEmit` pass and a manual "check for updates" action exists; if reverted: only the doc remains
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The private-repo hosting question has no acceptable answer within the spike
  (e.g. the team won't make releases public and there's no host) — document the
  blocker and stop; auto-update is gated on that decision.
- The updater requires OS code-signing to be usable on the target platforms in
  practice (not just in theory) — surface it; it reorders the backlog (sign first).
- Generating/managing the signing key would require committing a secret to make CI
  work — STOP; secrets go in GitHub secrets, never in-tree.

## Maintenance notes

- The minisign **public** key is safe to commit (it's in `tauri.conf.json`); the
  **private** key never is.
- Pair this with the OS code-signing backlog item — shipping signed *updates* to an
  app that itself trips Gatekeeper is a half-measure; sequence them deliberately.
- Whoever implements the follow-up must treat the update endpoint as a
  supply-chain trust root: compromise of the endpoint + signing key = pushing
  arbitrary code to every user. The hosting/custody decisions from Step 1 are the
  load-bearing part of this plan.
