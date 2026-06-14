# Plan 006: Single-source the search logic shared between the server and the MCP

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- server/src/search.ts server/src/db.ts mcp/src/localIndex.ts`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (search semantics must stay byte-identical between server and MCP; the server is Dockerized, so the new file's location matters)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

The MCP's local FTS index is meant to mirror the server's search *exactly* so the
ranking a Claude Code agent sees locally matches the server. Today that
correspondence is maintained by **copy-paste**: `toMatchQuery` and `deriveTitle`
and the FTS tokenizer string are duplicated across `server/src/search.ts`,
`server/src/db.ts`, and `mcp/src/localIndex.ts`. A comment in `localIndex.ts`
even admits it must be kept in sync by hand. If anyone changes tokenization or
title derivation on one side and forgets the other, local and remote search
silently diverge — a subtle, hard-to-notice bug. This plan extracts the shared
logic into one module and imports it from all three sites.

## Current state

The duplicated pieces:

- **`toMatchQuery`** — identical in two files:
  - `server/src/search.ts:34-38`:
    ```ts
    function toMatchQuery(query: string): string {
      const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
      if (!tokens?.length) return "";
      return tokens.map((t) => `"${t}"*`).join(" ");
    }
    ```
  - `mcp/src/localIndex.ts:104-108` — byte-identical copy.

- **`deriveTitle`** — identical in two files:
  - `server/src/db.ts:315-320`:
    ```ts
    function deriveTitle(content: string, path: string): string {
      const heading = content.match(/^#\s+(.+)$/m);
      if (heading) return heading[1].trim();
      const base = path.split("/").pop() ?? path;
      return base.replace(/\.md$/i, "");
    }
    ```
  - `mcp/src/localIndex.ts:55-60` — byte-identical copy.

- **FTS tokenizer string** `unicode61 remove_diacritics 2` — repeated:
  - `server/src/db.ts:84` (inside `CREATE VIRTUAL TABLE documents_fts ... tokenize="unicode61 remove_diacritics 2"`).
  - `mcp/src/localIndex.ts:43` (inside `CREATE VIRTUAL TABLE fts ... tokenize="unicode61 remove_diacritics 2"`).

- **BM25 weights** `10.0, 5.0, 1.0` appear inline in `server/src/search.ts:23`
  (`bm25(documents_fts, 10.0, 5.0, 1.0)`) and `mcp/src/localIndex.ts:23`
  (`const BM25 = "bm25(fts, 10.0, 5.0, 1.0)"`). The surrounding table names differ
  (`documents_fts` vs `fts`), so only the weight numbers are shared. **These are
  left inline by this plan** (one literal each, low drift risk) — see Maintenance.

### Hard constraint: the server's Docker build

The server is Dockerized. `server/Dockerfile` builds from the `server/` context
and copies **only** `package.json` and `src/`:
```dockerfile
COPY package.json ./
COPY src ./src
```
Therefore the shared module **must live inside `server/src/`** (or it won't exist
in the container). The MCP is run locally from the repo (`bun run src/index.ts`),
so it can import the shared file via a relative path into `server/src/`. A
repo-root `shared/` directory would NOT be copied into the server image — do not
put it there.

### Repo conventions to follow

- Bun + TypeScript, `strict`, ES modules, semicolons. Spanish comments.
- The shared module must be **pure**: no `bun:sqlite`, no `./db` import, nothing
  server-only — so the MCP can import it without pulling server runtime code.

## Commands you will need

| Purpose          | Command                              | Expected on success |
|------------------|--------------------------------------|---------------------|
| Server tests     | `cd server && bun test`              | all pass            |
| MCP import check | `cd mcp && bun -e "import('./src/localIndex.ts').then(()=>console.log('ok'))"` | prints `ok` |
| Docker file check| `grep -n "search-common" server/Dockerfile` | (expect nothing; it's under src/, already copied) |

## Scope

**In scope** (create/modify):
- `server/src/search-common.ts` (create) — the single source: `toMatchQuery`, `deriveTitle`, `FTS_TOKENIZER`.
- `server/src/search.ts` (modify) — import `toMatchQuery`, `FTS_TOKENIZER` (if used here) from `./search-common`; delete the local copy.
- `server/src/db.ts` (modify) — import `deriveTitle`, `FTS_TOKENIZER` from `./search-common`; delete the local copies; use the constant in the `CREATE VIRTUAL TABLE` string.
- `mcp/src/localIndex.ts` (modify) — import all three from `../../server/src/search-common`; delete the local copies; use the constant in its `CREATE VIRTUAL TABLE`.

**Out of scope** (do NOT touch):
- The BM25 weight literals (kept inline; table names differ).
- The SQL query structure, column order, snippet args — only the duplicated
  helpers and the tokenizer constant move.
- `server/Dockerfile` — no change needed (the new file is under `src/`, already copied).
- Any behavior change to ranking or tokenization.

## Git workflow

- Branch: `advisor/006-dedupe-search`.
- Commit style: Spanish `tipo: descripción`, e.g.
  `refactor: unificar toMatchQuery/deriveTitle/tokenizer (server + mcp)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create `server/src/search-common.ts`

```ts
/**
 * Lógica de búsqueda compartida entre el server (search.ts, db.ts) y el MCP
 * (localIndex.ts). Fuente ÚNICA: si cambia la tokenización o la derivación de
 * título, cambia acá y se refleja en ambos lados. Módulo PURO (sin bun:sqlite ni
 * imports del server) para que el MCP lo pueda importar tal cual.
 *
 * OJO Docker: este archivo vive en server/src/ a propósito — el Dockerfile del
 * server copia solo `src/`, así que un módulo compartido fuera de acá no estaría
 * en la imagen. El MCP lo importa por path relativo (../../server/src/...).
 */

/** Tokenizer de FTS5: insensible a acentos. Usado en el CREATE VIRTUAL TABLE. */
export const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

/**
 * Convierte texto libre del usuario en una query MATCH segura de FTS5: tokeniza
 * por letras/números (descarta la sintaxis especial), envuelve cada token en
 * comillas y agrega `*` para prefix-match. AND implícito. "" si no hay tokens.
 */
export function toMatchQuery(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return "";
  return tokens.map((t) => `"${t}"*`).join(" ");
}

/** Título derivado: primer H1 del contenido, si no el filename sin .md. */
export function deriveTitle(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
```

**Verify**: `cd server && bunx tsc --noEmit` → exit 0 (note: server has no
`typecheck` script; run `tsc` directly. If server has no local TypeScript, use
`cd server && bun build src/search-common.ts --target=bun >/dev/null && echo ok`
to confirm it parses).

### Step 2: Use it in `server/src/search.ts`

- Add `import { toMatchQuery } from "./search-common";` at the top.
- Delete the local `function toMatchQuery(...)` (lines 34-38) and its doc comment.
- Leave `searchDocs` and the prepared `qSearch` (including the inline
  `bm25(documents_fts, 10.0, 5.0, 1.0)`) unchanged.

**Verify**: `cd server && bun test -t "FTS5"` → the search tests pass.

### Step 3: Use it in `server/src/db.ts`

- Add `import { deriveTitle, FTS_TOKENIZER } from "./search-common";` at the top.
- Delete the local `function deriveTitle(...)` (lines 315-320).
- In the `CREATE VIRTUAL TABLE documents_fts ...` exec string (around line 80-85),
  replace the literal `tokenize="unicode61 remove_diacritics 2"` with an
  interpolation: `tokenize="${FTS_TOKENIZER}"`. Keep everything else identical.

**Verify**: `cd server && bun test` → all pass (this exercises create/search/title
derivation end-to-end). Pay attention to the FTS tests (acentos, prefix, ranking).

### Step 4: Use it in `mcp/src/localIndex.ts`

- Add `import { toMatchQuery, deriveTitle, FTS_TOKENIZER } from "../../server/src/search-common";` at the top.
- Delete the local `toMatchQuery` (lines 104-108) and `deriveTitle` (lines 55-60).
- In the `CREATE VIRTUAL TABLE fts ...` string (line 42-44), replace
  `tokenize="unicode61 remove_diacritics 2"` with `tokenize="${FTS_TOKENIZER}"`.
- Leave the `BM25` const and everything else unchanged.

**Verify**: `cd mcp && bun -e "import('./src/localIndex.ts').then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"`
→ prints `ok` (the relative cross-package import resolves and the module loads).

### Step 5: Confirm no copies remain and the server image is intact

- `grep -rn "function toMatchQuery" server mcp` → only ... none (it's an arrow/named export now in search-common; this grep should return **no** matches for the old `function toMatchQuery` declarations).
- `grep -rn "function deriveTitle" server mcp` → no matches.
- `grep -rn "unicode61 remove_diacritics 2" server mcp` → only in `server/src/search-common.ts` (the constant definition).
- Confirm the shared file is inside the Docker-copied dir:
  `test -f server/src/search-common.ts && echo "in server/src — Docker COPY src ./src includes it"`.

**Verify**: all greps return the expected (empty) results; the file is under `server/src/`.

## Test plan

- The server suite (`server/test/api.test.ts`) already covers the shared
  behavior: FTS ranking, prefix match, accent-insensitivity, snippet, title
  derivation (via document titles). Running `cd server && bun test` after the
  refactor is the regression gate — output must be identical (all pass).
- The MCP has no test suite; Step 4's import check + an optional manual search
  against a local vault dir is the verification.
- No new tests are required (behavior is unchanged); this is a pure refactor.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `server/src/search-common.ts` exists and is pure (no `bun:sqlite`/`./db` import: `grep -n "sqlite\|./db" server/src/search-common.ts` returns nothing)
- [ ] `cd server && bun test` exits 0 (all FTS/title tests pass)
- [ ] `cd mcp && bun -e "import('./src/localIndex.ts').then(()=>console.log('ok'))"` prints `ok`
- [ ] `grep -rn "function toMatchQuery\|function deriveTitle" server mcp` returns no matches
- [ ] `grep -rn "unicode61 remove_diacritics 2" server mcp` matches only `server/src/search-common.ts`
- [ ] `server/Dockerfile` unchanged
- [ ] No behavior change (no test modified)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The relative import `../../server/src/search-common` does not resolve from the
  MCP at runtime (e.g. the MCP is meant to be distributed standalone). If so,
  report — the alternative is a parity *test* that asserts the two copies agree,
  rather than physical sharing.
- Any server FTS test changes result (ranking/snippet/title) after the refactor —
  that means the extraction wasn't byte-identical; revert and compare.
- A maintainer convention exists (e.g. a workspaces/monorepo setup is planned)
  that would prefer a different shared-module location — surface it before
  committing to `server/src/`.

## Maintenance notes

- **BM25 weights** (`10.0, 5.0, 1.0`) and the snippet column index (`2`) are still
  duplicated inline because the surrounding `bm25(<table>, …)` differs by table
  name. They're a single literal each; if you change ranking weights, change both
  `server/src/search.ts` and `mcp/src/localIndex.ts`. (A future improvement could
  export `BM25_WEIGHTS` from `search-common` and build the string from it.)
- The cross-package import couples the MCP to `server/src/` layout. If the repo
  ever adopts a workspace/monorepo with a real shared package, move
  `search-common.ts` there and update the three importers.
- A reviewer should confirm the server still builds in Docker (the file is under
  `src/`, so `COPY src ./src` includes it) and that `cd server && bun test` output
  is unchanged.
