# Plan 002: Make change attribution trustworthy (derive author from the authenticated token, not the request body)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- server/src/index.ts server/test/api.test.ts`
> If either file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

The server records who made each change (`documents.updated_by` and the
`changes.author` audit log), and the UI shows it ("· {updated_by} · …"). But the
author is taken from **client-supplied input** — `body.author` for create/update
and the `X-Author` header for delete/restore — not from the authenticated token.
Any authenticated `editor` can therefore attribute their edits or deletions to a
different teammate by sending a different name. This silently defeats the whole
point of the RBAC + history feature: the audit trail is forgeable. The fix is
small: when a request is authenticated, use the token's identity name as the
author and ignore the client-supplied value. When auth is disabled (dev mode,
no token), fall back to the client value as today.

## Current state

- `server/src/index.ts` resolves the caller's identity early (line ~92):
  ```ts
  const auth = checkAuth(req, url);
  if ("denied" in auth) return auth.denied;
  const identity = auth.identity;        // Identity | null  (null when auth is OFF)
  const vault = identity?.vault ?? "default";
  ```
  `Identity` (from `server/src/auth.ts:14`) is `{ name, role, vault, isOwner }`.

- The four write handlers pass a **client-controlled** author:

  Create (`server/src/index.ts:243-251`):
  ```ts
  const doc = createDoc({
    vault,
    path: body.path,
    title: body.title ?? null,
    content: body.content,
    author: body.author ?? null,        // <-- client-controlled
  });
  ```

  Update (`server/src/index.ts:297-305`):
  ```ts
  const doc = updateDoc({
    vault, id, path: body.path, title: body.title ?? null,
    content: body.content, base_version: body.base_version,
    author: body.author ?? null,        // <-- client-controlled
  });
  ```

  Restore (`server/src/index.ts:277`):
  ```ts
  const doc = restoreDoc(vault, decodeURIComponent(restoreMatch[1]), req.headers.get("x-author"));  // <-- client-controlled
  ```

  Delete (`server/src/index.ts:326`):
  ```ts
  const doc = deleteDoc(vault, id, req.headers.get("x-author"));  // <-- client-controlled
  ```

- The DB layer (`server/src/db.ts`) just stores whatever author it is handed —
  no change needed there.

- The client already sends the right name when auth is on: it sets `author` to
  the token's `whoami` name (`client/src/lib/store.ts:665`,
  `permsForRole`/`author` wiring). So after this fix the displayed author is
  unchanged for honest clients; only the *spoofing* path is closed.

### Repo conventions to follow

- Server is Bun + TypeScript, `strict`. Handlers return via the `json(...)`
  helper. Keep the existing error handling (`ConflictError`/`NotFoundError`
  branches) untouched.
- Tests are integration tests that spawn the real server over HTTP
  (`server/test/api.test.ts`); follow that style for any test change.

## Commands you will need

| Purpose   | Command                     | Expected on success            |
|-----------|-----------------------------|--------------------------------|
| Tests     | `cd server && bun test`     | all pass                       |
| Run one   | `cd server && bun test -t "history"` | the history test passes |

## Scope

**In scope** (the only files you should modify):
- `server/src/index.ts` — the four write handlers (create, update, delete, restore).
- `server/test/api.test.ts` — update assertions that depended on body-supplied author, and add a spoofing-prevention test.

**Out of scope** (do NOT touch):
- `server/src/db.ts` — the DB functions take `author` as a parameter; leave them.
- `server/src/auth.ts` — identity resolution is already correct.
- The client (`client/`) — it already sends the token name; no change needed and
  changing it is out of scope for this plan.

## Git workflow

- Branch: `advisor/002-author-attribution`.
- Commit style: Spanish `tipo: descripción`, e.g.
  `fix: derivar el author del token autenticado (evita spoofing del historial)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Derive the author from identity in all four handlers

In `server/src/index.ts`, define a single helper just after `identity`/`vault`
are resolved (around line 94), then use it in create, update, delete, restore.
The rule: **prefer the authenticated identity's name; fall back to the
client-supplied value only when there is no identity** (auth disabled / dev mode).

Add near line 95:
```ts
// Autor de un cambio: si la request está autenticada, manda el nombre del token
// (no se confía en lo que mande el cliente); sin auth, cae al valor del cliente.
const authorFrom = (clientValue: string | null | undefined): string | null =>
  identity?.name ?? clientValue ?? null;
```

Then:
- Create: replace `author: body.author ?? null` with `author: authorFrom(body.author)`.
- Update: replace `author: body.author ?? null` with `author: authorFrom(body.author)`.
- Restore: replace `req.headers.get("x-author")` with `authorFrom(req.headers.get("x-author"))`.
- Delete: replace `req.headers.get("x-author")` with `authorFrom(req.headers.get("x-author"))`.

Do not change anything else in those handlers.

**Verify**: `cd server && bun test` — note which tests now fail (Step 2 fixes
the expected one). The only test that should change behavior is the history test
(it asserted the body author). If any *other* test fails, STOP.

### Step 2: Update the history test's author assertion

In `server/test/api.test.ts`, the test `"history registra create + update (más
reciente primero)"` currently posts with `author: "t"` using the `ADMIN` token
(whose identity name is `"admin"`) and asserts:
```ts
expect(history[0].author).toBe("t");
```
With the fix, the authenticated author is the token name. Change that assertion to:
```ts
expect(history[0].author).toBe("admin");
```
Do not change the `author: "t"` in the request body (leaving it proves the body
value is now ignored). Scan the rest of the file for any other assertion of the
form `.author).toBe("t")` or `.updated_by).toBe(...)` tied to an **authenticated**
request and update them the same way (expected name = the token's name: `admin`
for `ADMIN`, the created token's `name` for editor/viewer tokens). The
`"server sin auth"` describe block has no token, so its author behavior is
unchanged (identity is null → falls back to body value).

**Verify**: `cd server && bun test` → all pass.

### Step 3: Add a spoofing-prevention test

In `server/test/api.test.ts`, inside the `describe("server con auth (admin
bootstrap)")` block, add a test that proves a client-supplied author is ignored
when authenticated. Model it on the existing `"history registra create +
update"` test. Shape:

```ts
test("el author del historial sale del token, no del body (no spoofing)", async () => {
  const created = await (
    await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "spoof.md", content: "v1", author: "victima" }),
    })
  ).json();
  const { history } = await (
    await fetch(`${base}/documents/${created.id}/history`, { headers: bearer(ADMIN) })
  ).json();
  expect(history[0].author).toBe("admin");   // el nombre del token, no "victima"
  expect(history[0].author).not.toBe("victima");
  // updated_by del doc también debe ser el del token
  const sync = await (await fetch(`${base}/sync?since=0`, { headers: bearer(ADMIN) })).json();
  const doc = sync.documents.find((d: any) => d.path === "spoof.md");
  expect(doc.updated_by).toBe("admin");
});
```

**Verify**: `cd server && bun test -t "no spoofing"` → passes; `cd server && bun test` → all pass.

## Test plan

- Updated: the existing history-author assertion now expects the token name.
- New: `"el author del historial sale del token, no del body"` — covers the
  exact regression this plan fixes (body author `"victima"` ignored; token name
  `"admin"` recorded in both `changes.author` and `documents.updated_by`).
- Existing `"server sin auth"` tests confirm the no-auth fallback still records
  the client-supplied author (identity is null).
- Verification: `cd server && bun test` → all pass, including the new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd server && bun test` exits 0; the new "no spoofing" test exists and passes
- [ ] `grep -n "body.author ?? null" server/src/index.ts` returns **no** matches
- [ ] `grep -n "authorFrom" server/src/index.ts` returns matches in create, update, delete, and restore handlers
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A test other than the history-author assertion fails after Step 1 (means
  another code path depends on body-supplied author in a way this plan didn't anticipate).
- The `Identity` type no longer has a `name` field, or `identity` is not in scope
  at the handlers (the code drifted).
- You find a handler that needs the author but cannot see `identity` (report it;
  do not thread the identity through unrelated layers without checking).

## Maintenance notes

- If a new write endpoint is added (e.g. bulk operations), it must use
  `authorFrom(...)` too — never read the author straight from the body/header.
- A reviewer should confirm the fallback (`identity?.name ?? clientValue`) is
  intentional: it keeps dev-mode (no-auth) usable while making authenticated
  attribution non-forgeable.
- This does not add cryptographic non-repudiation — a server admin can still
  write any author directly to SQLite. It closes the *client-facing* spoofing
  path, which is the realistic threat for a team tool.
