# Plan 001: Eliminate stored XSS in the note preview (sanitize HTML + add a CSP)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 972d692..HEAD -- client/src/lib/markdown.ts client/src/App.tsx client/src-tauri/tauri.conf.json client/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (the CSP step can break rendering if too strict; the sanitizer step is low-risk)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `972d692`, 2026-06-13

## Why this matters

Bridges is a **team-shared** vault: a note authored by one person renders in
every teammate's desktop app. The preview pane renders Markdown to HTML with
**no sanitization** and injects it via `innerHTML`, and the Tauri webview has
**no Content Security Policy** (`csp: null`). A note containing
`<img src=x onerror="...">` or `<script>` therefore executes arbitrary
JavaScript in every reader's app. Because Tauri app-commands are callable from
the webview's JS (via `window.__TAURI_INTERNALS__.invoke`), that script can call
`config_load` (reads the saved connection tokens), `vault_read`/`vault_write`/
`vault_remove` (read or tamper any note on disk), and more. This is the
single most severe issue in the repo: stored XSS that escalates to local file
read/write and credential theft. Fixing it (sanitize the HTML, and add a CSP as
defense-in-depth) closes that path while keeping the existing wikilink/tag
rendering intact.

## Current state

- `client/src/lib/markdown.ts` — turns Markdown into an HTML string. The
  renderer escapes its *own* wikilink/tag output, but `marked.parse()` passes
  through raw HTML embedded in the note. `marked` v15 has **no** built-in
  sanitizer. Excerpt (lines 93-95):

  ```ts
  export function renderMarkdown(md: string): string {
    return marked.parse(stripFrontmatter(md)) as string;
  }
  ```

  The wikilink/tag renderers emit anchors with `class` and `data-*` attributes
  that the preview's click handler relies on (lines 31-32, 52):

  ```ts
  if (dest) return `<a class="wikilink" data-doc-id="${escapeHtml(dest.id)}">${label}</a>`;
  return `<span class="wikilink wikilink-missing" title="Nota inexistente">${label}</span>`;
  // ...
  return `<a class="tag" data-tag="${name}">#${name}</a>`;
  ```

- `client/src/App.tsx:1058` — injects that HTML string straight into the DOM:

  ```tsx
  <div class="prose-bridges" innerHTML={preview()} onClick={onPreviewClick} />
  ```

  `preview()` is `createMemo(() => { setWikiResolver(...); return renderMarkdown(draft()); })`
  (App.tsx:632-635). `onPreviewClick` (App.tsx:655-669) reads `data-tag` and
  `data-doc-id` off clicked elements via `closest()` — these attributes **must
  survive** sanitization.

- `client/src-tauri/tauri.conf.json:22-24` — no CSP:

  ```json
  "security": {
    "csp": null
  }
  ```

- Dependency manager is **Bun**. The client lockfile is `client/bun.lock`.
  Install with `bun install` (in `client/`). `marked` is at `^15.0.4`.

### Repo conventions to follow

- TypeScript, `strict: true` (`client/tsconfig.json`). No semicolon-free style —
  the codebase uses semicolons. Match the surrounding style in each file.
- Comments in this codebase are in Spanish; keep new comments short and in
  Spanish to match (e.g. existing `// Resolver de wikilinks...`).
- Imports use the `~/` alias for `src/` (see other files), but `markdown.ts`
  uses relative imports (`./links`) — match the file you edit.

## Commands you will need

| Purpose       | Command                                      | Expected on success |
|---------------|----------------------------------------------|---------------------|
| Install deps  | `cd client && bun install`                   | exit 0              |
| Add dep       | `cd client && bun add dompurify @types/dompurify` | exit 0; added to package.json |
| Typecheck     | `cd client && bunx tsc --noEmit`             | exit 0, no errors   |
| Build (web)   | `cd client && bun run build`                 | exit 0, dist/ written |
| Run desktop app (manual verify) | `cd client && bun run tauri dev` | app window opens |

> The client has no test runner yet (see plan 003). For this plan, verification
> of the sanitizer is a small inline assertion you add as a step; verification of
> the CSP is **manual** (run the app). Do not assume a `bun test` exists in
> `client/`.

## Scope

**In scope** (the only files you should modify):
- `client/src/lib/markdown.ts` — wrap rendered HTML in a sanitizer.
- `client/src-tauri/tauri.conf.json` — set a CSP.
- `client/package.json` + `client/bun.lock` — new `dompurify` dependency (changed by `bun add`).

**Out of scope** (do NOT touch, even though they look related):
- `client/src/App.tsx` — the `innerHTML` binding stays; it becomes safe once
  `renderMarkdown` returns sanitized HTML. Do not rewrite the preview component.
- The wikilink/tag renderers' output format in `markdown.ts` — keep emitting the
  same `<a class="wikilink" data-doc-id>` / `<a class="tag" data-tag>` markup; only
  add sanitization around the final string.
- The CodeMirror editor (`MarkdownEditor.tsx`) — it does not use `innerHTML`.

## Git workflow

- Branch: `advisor/001-sanitize-preview` (the repo has no enforced branch convention; use this).
- Commit style follows the repo's `tipo: descripción` (Spanish), e.g.
  `fix: sanitizar HTML del preview + CSP (cierra XSS almacenado)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add DOMPurify

```
cd client && bun add dompurify @types/dompurify
```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0. Confirm `dompurify`
appears under `dependencies` in `client/package.json`.

### Step 2: Sanitize the rendered HTML in `markdown.ts`

In `client/src/lib/markdown.ts`, import DOMPurify at the top and sanitize the
output of `renderMarkdown`. The sanitizer must **preserve** `class` and `data-*`
attributes (the preview click handler depends on `data-doc-id` and `data-tag`)
and must **strip** event-handler attributes and `<script>`/`<iframe>` etc.
DOMPurify keeps `class` and `data-*` by default and strips inline event handlers
and scripts by default, so a default-config call is sufficient. Produce this
shape:

```ts
import DOMPurify from "dompurify";
// ...existing imports...

export function renderMarkdown(md: string): string {
  const html = marked.parse(stripFrontmatter(md)) as string;
  // Sanitiza: DOMPurify conserva class y data-* (los usa el click del preview)
  // y elimina <script>, handlers inline (onerror=...), iframes, etc.
  return DOMPurify.sanitize(html);
}
```

Do not change `stripFrontmatter`, the wikilink/tag extensions, `buildTree`,
`parseFrontmatter`, or any other export.

**Verify**:
- `cd client && bunx tsc --noEmit` → exit 0.
- Add a throwaway check (delete it after): create `client/scratch-xss.ts` with:
  ```ts
  import { renderMarkdown } from "./src/lib/markdown";
  const out = renderMarkdown('Hi <img src=x onerror="alert(1)"> [[Foo]] and <script>alert(2)</script>');
  console.log(out);
  if (/onerror|<script/i.test(out)) throw new Error("XSS NOT sanitized");
  console.log("OK: no onerror/script in output");
  ```
  Run `cd client && bunx tsc --noEmit scratch-xss.ts >/dev/null 2>&1; bun run scratch-xss.ts`.
  Expected: prints sanitized HTML and `OK: no onerror/script in output`, and the
  output still contains `class="wikilink` (the `[[Foo]]` wikilink markup
  survives). Then delete `client/scratch-xss.ts`.

> If DOMPurify throws at import because there is no DOM, run the scratch check
> under the build instead: it is fine for the scratch script to fail to *run* in
> pure Node as long as `tsc --noEmit` passes and Step 4's manual app check
> confirms behavior. If `bun run scratch-xss.ts` errors with "document is not
> defined", note it, delete the scratch file, and rely on the Step 4 manual
> verification instead (DOMPurify works in the webview where `document` exists).

### Step 3: Set a Content Security Policy in `tauri.conf.json`

Replace `"csp": null` in `client/src-tauri/tauri.conf.json` with a policy that
blocks inline scripts (so injected `onerror=`/`<script>` cannot run even if a
future sanitizer gap appears) while allowing what the app actually needs:
CodeMirror injects `<style>` tags and the app uses inline `style="…"` attributes,
so `style-src` needs `'unsafe-inline'`; notes may embed images by URL, so
`img-src` allows `data:` and `https:`. Use:

```json
"security": {
  "csp": "default-src 'self'; img-src 'self' asset: data: https: http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost http://localhost:* http://127.0.0.1:* https:; script-src 'self'"
}
```

Rationale to keep in mind while verifying: `script-src 'self'` (no
`'unsafe-inline'`) is what neutralizes injected inline JS. `connect-src` must
allow the Bridges server origin — the desktop SSE/REST goes through Rust
(`reqwest`), not the webview, but in **browser mode** (`bun run dev`) the webview
does `fetch` the server directly, so http(s) origins are allowed. If your server
runs on a non-localhost host, the user's server URL must be reachable under
`connect-src` — see STOP conditions.

**Verify**: `cd client && bun run build` → exit 0 (the bundler does not validate
CSP, but this confirms the JSON is still valid and the app builds). JSON validity:
`cd client && bunx tsc --noEmit` is unaffected; instead confirm the file parses:
`cd client && node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('valid json')"` → prints `valid json`.

### Step 4: Manual smoke test in the desktop app

Run `cd client && bun run tauri dev`. In the app:
1. Open or create a note and switch to **Vista previa** (preview) mode.
2. Confirm normal Markdown renders (headings, bold, lists).
3. Confirm a `[[wikilink]]` to an existing note renders as a clickable link and
   clicking it navigates (this proves `data-doc-id` survived sanitization).
4. Confirm a `#tag` renders and clicking it runs a search (proves `data-tag` survived).
5. Paste a note body containing `<img src=x onerror="alert('xss')">` and view the
   preview. Expected: **no alert dialog** appears; the broken image (or nothing)
   shows. Open the devtools console (right-click → Inspect if available) and
   confirm no script executed.

**Verify**: all five behaviors hold. If the editor, preview, or app shell fails
to render at all after the CSP change, that is a CSP regression — see STOP.

## Test plan

- No automated test runner exists in `client/` yet (plan 003 adds Vitest). For
  this plan:
  - The Step 2 scratch check is the sanitizer regression check (run, confirm, delete).
  - The Step 4 manual app smoke test is the integration check.
- **Follow-up (note in `plans/README.md`, do not implement here)**: once plan 003
  lands Vitest, add `client/src/lib/markdown.test.ts` asserting
  `renderMarkdown('<img src=x onerror=alert(1)>')` contains no `onerror`/`<script>`
  and that `renderMarkdown('[[Foo]]')` still contains `data-doc-id` or `wikilink`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd client && bunx tsc --noEmit` exits 0
- [ ] `cd client && bun run build` exits 0
- [ ] `grep -n "DOMPurify.sanitize" client/src/lib/markdown.ts` returns a match
- [ ] `grep -n '"csp": null' client/src-tauri/tauri.conf.json` returns **no** matches
- [ ] `dompurify` is listed under `dependencies` in `client/package.json`
- [ ] Manual Step 4 smoke test: wikilinks/tags still clickable AND the `onerror` payload does not execute
- [ ] No files outside the in-scope list are modified (`git status`); `client/scratch-xss.ts` deleted
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The CSP change breaks app rendering (blank window, editor or preview not
  showing, console full of CSP violations). Report which directive is being
  violated (from the devtools console) instead of loosening the whole policy to
  `'unsafe-inline'` on `script-src` — that would re-open the hole.
- Sanitization strips the `data-doc-id`/`data-tag` attributes and wikilink/tag
  clicks stop working — report so we can add an explicit DOMPurify `ADD_ATTR`
  allowlist instead of guessing.
- The code at the "Current state" excerpts doesn't match the live files.
- `marked` is no longer the renderer (e.g. it was swapped for another library).

## Maintenance notes

- If a future change moves Markdown rendering off `marked` or starts rendering
  HTML anywhere else, that new path must also go through `DOMPurify.sanitize`.
  Grep for `innerHTML` before merging any preview-related PR.
- If notes need to embed remote media beyond images (audio/video/iframes), the
  CSP `img-src`/`media-src`/`frame-src` directives must be widened deliberately —
  never widen `script-src`.
- A reviewer should scrutinize: (1) that `script-src` has no `'unsafe-inline'`,
  (2) that the sanitizer wraps the *final* string returned to `innerHTML`, not an
  intermediate value.
