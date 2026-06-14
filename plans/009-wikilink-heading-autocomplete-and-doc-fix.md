# Plan 009: Fix the stale "CodeMirror editor" backlog entry and add heading-level wikilink autocomplete

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. Step 1 (doc fix) is independently
> shippable; Step 2+ (the enhancement) build on the *existing* autocomplete — do
> not rebuild it. If a STOP condition occurs, stop and report. Update the status
> row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- client/src/components/MarkdownEditor.tsx client/src/App.tsx client/src/lib/links.ts README.md`
> Compare the "Current state" excerpts against the live code before editing.

## Status

- **Priority**: P3
- **Effort**: S (Step 1 alone) / M (with the heading-completion enhancement)
- **Risk**: LOW
- **Depends on**: plans/003 recommended (so `links.ts` helper changes get a test), not required
- **Category**: direction / docs
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

**First, a correction the advisor surfaced:** the README lists "Editor con
CodeMirror (syntax highlight, autocompletado de `[[wikilinks]]`)" under
**"Próximos pasos (backlog)"** — but this is **already implemented**.
`MarkdownEditor.tsx` uses CodeMirror 6 with markdown highlighting and a working
`[[` autocomplete (`wikilinkCompletions`, wired via `autocompletion(...)`),
fed by `linkTargets` from `App.tsx`. So the doc is stale (it lists a shipped
feature as not-done), which misleads anyone reading the roadmap. Step 1 fixes
that.

**Second, the real gap:** the existing completion offers **note names** after
`[[`, but Obsidian-style links also target **headings within a note**
(`[[Note#Some Heading]]`). The link *resolver* already understands `#`
(`links.ts:normalizeTarget` strips `#`/`^`/`|`), but the editor never *suggests*
headings. Step 2+ adds heading completion: after you type `[[Note#`, it offers
that note's headings.

## Current state

- **The autocomplete already exists** — `client/src/components/MarkdownEditor.tsx:13-28`:
  ```ts
  function wikilinkCompletions(targets: () => LinkTarget[]) {
    return (ctx: CompletionContext): CompletionResult | null => {
      const before = ctx.matchBefore(/\[\[[^\]\n]*$/);  // `[[` + lo tipeado, sin cerrar
      if (!before) return null;
      return {
        from: before.from + 2,
        options: targets().map((it) => ({
          label: it.label,
          detail: it.path.includes("/") ? it.path.replace(/\/[^/]+$/, "") : undefined,
          apply: it.label + "]]",
        })),
        validFor: /^[^\]\n]*$/,
      };
    };
  }
  ```
  Wired at line 126:
  ```ts
  autocompletion({ override: [wikilinkCompletions(() => props.linkTargets?.() ?? [])], activateOnTyping: true }),
  ```
  `LinkTarget` is `{ label: string; path: string }` (line 11).

- **The data source** — `client/src/App.tsx:1066`:
  ```tsx
  linkTargets={() => docs().map((d) => ({ label: displayName(d.path), path: d.path }))}
  ```
  `docs()` items are full `Doc`s including `content` (so headings are derivable).

- **Heading parsing already exists for the outline** — `App.tsx:641-652` parses
  `#{1,6}` headings from `draft()`, skipping ``` fenced blocks. That logic is the
  pattern to reuse for a reusable `parseHeadings(content)` helper.

- **The README backlog entry** — `README.md:56` (inside "### Próximos pasos (backlog)"):
  ```
  - Editor con CodeMirror (syntax highlight, autocompletado de `[[wikilinks]]`).
  ```
  The "### Resuelto" section (README ~line 62-67) is where shipped items live.

### Repo conventions

- SolidJS, TS strict, semicolons, Spanish comments. `links.ts` holds pure
  wikilink helpers (`displayName`, `normalizeTarget`, `parseWikilinks`,
  `createResolver`) — a new `parseHeadings` belongs there.

## Commands you will need

| Purpose          | Command                              | Expected |
|------------------|--------------------------------------|----------|
| Client typecheck | `cd client && bunx tsc --noEmit`     | exit 0   |
| Client tests     | `cd client && bun run test`          | all pass (if plan 003 landed) |
| Run app (manual) | `cd client && bun run tauri dev`     | app opens |

## Scope

**In scope**:
- `README.md` (Step 1) — move the CodeMirror/autocomplete line from backlog to "Resuelto".
- `client/src/lib/links.ts` (Step 2) — add a pure `parseHeadings(content): string[]`.
- `client/src/components/MarkdownEditor.tsx` (Step 3) — extend `LinkTarget` and `wikilinkCompletions` to offer headings after `#`.
- `client/src/App.tsx` (Step 3) — include `headings` in the `linkTargets` it provides.
- `client/src/lib/links.test.ts` (Step 4, if plan 003 landed) — test `parseHeadings`.

**Out of scope**:
- Rebuilding the existing `[[` note-name completion — it works; only *extend* it.
- The preview-side wikilink rendering/resolution (already handles `#`).
- Block references (`^block-id`) completion — note-and-heading only.

## Git workflow

- Branch: `advisor/009-wikilink-headings`.
- Commit style: Spanish `tipo: descripción`, e.g.
  `docs: marcar editor CodeMirror como resuelto` and
  `feat(editor): autocompletado de headings en [[nota#...]]`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Fix the stale README (independently shippable)

In `README.md`, remove the line at ~56 from "### Próximos pasos (backlog)":
```
- Editor con CodeMirror (syntax highlight, autocompletado de `[[wikilinks]]`).
```
and add an entry under "### Resuelto" describing it as done, e.g.:
```
- **Editor CodeMirror 6** con resaltado de markdown y **autocompletado de `[[wikilinks]]`** (`MarkdownEditor.tsx`).
```
(Keep the remaining backlog item about *semantic search* — that one is genuinely
not done.)

**Verify**: `grep -n "CodeMirror" README.md` shows it under the Resuelto section,
not the backlog; `grep -n "Editor con CodeMirror" README.md` returns nothing.

> If you are only doing the doc correction, you may stop here — Step 1 is a
> complete, valuable change on its own. Steps 2-4 are the enhancement.

### Step 2: Add a pure `parseHeadings` helper to `links.ts`

Mirror the outline parser from `App.tsx:641-652` (skip fenced code blocks). Add to
`client/src/lib/links.ts`:

```ts
/** Headings (texto, sin los #) de un contenido markdown, ignorando bloques de código. */
export function parseHeadings(content: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const ln of content.split("\n")) {
    if (/^```/.test(ln)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(ln);
    if (m) out.push(m[1].trim());
  }
  return out;
}
```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 3: Offer headings after `#` in the completion

In `client/src/components/MarkdownEditor.tsx`:
- Extend `LinkTarget`: `export type LinkTarget = { label: string; path: string; headings?: string[] };`
- In `wikilinkCompletions`, after matching `before` (the `[[…` text), check whether
  the typed text contains a `#`. If it does, split on the last `#` into
  `notePart` and `headingPart`, find the target whose `label` (case-insensitive)
  equals `notePart`, and return its headings as options with `from` positioned
  right after the `#`. Otherwise keep the current note-name behavior. Sketch:

  ```ts
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^\]\n]*$/);
    if (!before) return null;
    const typed = before.text.slice(2);            // lo que va después de `[[`
    const hashAt = typed.lastIndexOf("#");
    if (hashAt >= 0) {
      const notePart = typed.slice(0, hashAt).trim().toLowerCase();
      const target = targets().find((t) => t.label.toLowerCase() === notePart);
      const headings = target?.headings ?? [];
      return {
        from: before.from + 2 + hashAt + 1,        // justo después del `#`
        options: headings.map((h) => ({ label: h, apply: h + "]]" })),
        validFor: /^[^\]\n]*$/,
      };
    }
    return {
      from: before.from + 2,
      options: targets().map((it) => ({
        label: it.label,
        detail: it.path.includes("/") ? it.path.replace(/\/[^/]+$/, "") : undefined,
        apply: it.label + "]]",
      })),
      validFor: /^[^\]\n]*$/,
    };
  };
  ```

- In `client/src/App.tsx:1066`, supply headings:
  ```tsx
  linkTargets={() => docs().map((d) => ({ label: displayName(d.path), path: d.path, headings: parseHeadings(d.content) }))}
  ```
  Import `parseHeadings` from `~/lib/links` (add to the existing `links` import).

**Verify**: `cd client && bunx tsc --noEmit` → exit 0. Manual (`bun run tauri
dev`): in the editor type `[[` → note names appear (unchanged); pick a note that
has headings, type `#` → that note's headings appear and selecting one inserts
`Note#Heading]]`.

### Step 4: Test `parseHeadings` (if plan 003's Vitest exists)

If `client/src/lib/reconcile.test.ts` / Vitest is present, add
`client/src/lib/links.test.ts` covering: a doc with `#`/`##` headings returns them
in order; headings inside a ``` fenced block are ignored; trailing `#` are
trimmed. Model on `reconcile.test.ts`.

**Verify**: `cd client && bun run test` → all pass.

## Test plan

- Step 1 is a doc change (grep-verified).
- `parseHeadings` is pure → unit-tested in Step 4 (if Vitest exists). If plan 003
  hasn't landed, rely on the Step 3 manual editor check.
- The completion behavior change is verified manually in the editor (Step 3).

## Done criteria

- [ ] README no longer lists CodeMirror/autocomplete as backlog; it's under "Resuelto"
- [ ] `cd client && bunx tsc --noEmit` exits 0
- [ ] `grep -n "parseHeadings" client/src/lib/links.ts client/src/components/MarkdownEditor.tsx client/src/App.tsx` shows it defined and used
- [ ] Manual: `[[` still completes note names; `[[Note#` completes that note's headings
- [ ] If plan 003 landed: `client/src/lib/links.test.ts` exists and `bun run test` passes
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The existing `wikilinkCompletions` has already been changed to support headings
  (someone beat you to it) — then only Step 1 (the doc fix) remains.
- `CompletionContext.matchBefore`/`CompletionResult` API differs from the excerpt
  (CodeMirror autocomplete version drift) — report; adapt to the installed API.
- Supplying `headings` for every doc on every keystroke causes a noticeable
  editor lag on a large vault — report; the fix is to memoize `linkTargets`
  (parse headings once per doc change, not per completion), which is a small
  follow-up.

## Maintenance notes

- `parseHeadings` duplicates the outline logic in `App.tsx:641-652`. Consider
  refactoring the App outline to call `parseHeadings` too (out of scope here, but
  a clean follow-up to avoid a second divergent copy).
- `linkTargets` now parses headings for *all* docs each time it's called; if the
  editor feels slow on big vaults, wrap it in a `createMemo` keyed on `docs()`.
- The README correction is the higher-certainty value here; the heading
  completion is a nice-to-have. A reviewer can approve Step 1 independently.
