# Embeds + Callouts + Tareas interactivas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sumar al preview del cliente paridad Obsidian: embeds `![[Nota]]`/`![[Nota#Heading]]`, callouts `> [!tipo]` colapsables, y tareas `- [ ]` interactivas (clic togglea y guarda).

**Architecture:** El render markdown (`client/src/lib/markdown.ts`) pasa de usar el singleton `marked` a **dos instancias `new Marked()`** vía un factory `createRenderer({interactiveTasks, expandEmbeds})`: `mainMd` (nota actual: tareas interactivas con `data-task`, embeds que expanden) y `embedMd` (contenido embebido: tareas `disabled`, embeds anidados → link = cap de profundidad 1). Extensiones nuevas `callout` (block) y `embed` (block). El toggle de tarea y el fold de callout se cablean por delegación en `onPreviewClick` (`App.tsx`), reusando el path de guardado optimista existente. Helpers puros (`extractSection`, `toggleTaskAtIndex`) en `links.ts`.

**Tech Stack:** SolidJS + TypeScript, `marked@15.0.12`, `dompurify@3.4.10`, Vitest (entorno `node`), Tailwind/CSS.

## Global Constraints

- **Solo el preview HTML** (`renderMarkdown`); sin live-preview en el editor CodeMirror.
- **Embeds block-level**: solo `![[...]]` en su propia línea; inline en párrafo degrada a `!`+wikilink.
- **Cap de profundidad de embeds = 1**: embed dentro de embed → link, no se expande (corta ciclos).
- **Toggle de tarea solo sobre la nota actual**: las tareas dentro de embeds van `disabled`, sin `data-task`.
- **Fold de callout efímero**: clase en el DOM, NO se escribe al `.md`.
- **Vitest corre en entorno `node` (sin DOM)**: los tests usan `renderToHtml` (marked puro), NO `renderMarkdown` (que llama `DOMPurify.sanitize`, requiere `window`). La preservación de sanitize está validada (allowlist de DOMPurify incluye `input`/`svg`/`data-*`) y se re-chequea en el smoke manual.
- **No agregar dependencias** ni cambiar la CSP del plan 001 (todo por delegación, sin handlers inline).
- Verificación: `cd client && bun run test` y `bun run typecheck` en verde; smoke manual en `tauri dev`.

---

### Task 1: Helpers puros `extractSection` + `toggleTaskAtIndex`

**Files:**
- Modify: `client/src/lib/links.ts` (agregar dos funciones exportadas al final)
- Test: `client/src/lib/links.test.ts` (agregar dos `describe`)

**Interfaces:**
- Produces:
  - `extractSection(content: string, heading: string): string | null` — markdown de la sección cuyo heading matchea `heading` (incluida su línea) hasta el próximo heading de nivel ≤; ignora code fences; `null` si no existe.
  - `toggleTaskAtIndex(md: string, n: number): string` — flipea `[ ]`↔`[x]` en la n-ésima tarea bullet (orden de documento, salteando fences); `md` sin cambios si `n` fuera de rango.

- [ ] **Step 1: Write the failing tests**

Agregar al final de `client/src/lib/links.test.ts`. Primero, extender el import de la línea 2:

```ts
import { parseHeadings, extractSection, toggleTaskAtIndex } from "~/lib/links";
```

Luego agregar al final del archivo:

```ts
describe("extractSection", () => {
  const md = "# Uno\n\na\n\n## Dos\n\nb\n\n### Tres\n\nc\n\n## Cuatro\n\nd\n";

  it("devuelve desde el heading hasta el próximo de nivel <=", () => {
    expect(extractSection(md, "Dos")).toBe("## Dos\n\nb\n\n### Tres\n\nc\n");
  });

  it("incluye la línea del heading", () => {
    expect(extractSection(md, "Uno")!.startsWith("# Uno")).toBe(true);
  });

  it("null si no existe", () => {
    expect(extractSection(md, "Nope")).toBeNull();
  });

  it("ignora un heading homónimo dentro de un fence", () => {
    const f = "```\n## Dos\n```\n\n## Dos\n\nreal\n";
    expect(extractSection(f, "Dos")).toBe("## Dos\n\nreal\n");
  });
});

describe("toggleTaskAtIndex", () => {
  const md = "- [ ] a\n- [x] b\n\n```\n- [ ] fenced\n```\n\n- [ ] c\n";

  it("flipea [ ]->[x] en el índice dado", () => {
    expect(toggleTaskAtIndex(md, 0)).toContain("- [x] a");
  });

  it("flipea [x]->[ ]", () => {
    expect(toggleTaskAtIndex(md, 1)).toContain("- [ ] b");
  });

  it("saltea tareas en fences (índice 2 = 'c')", () => {
    const out = toggleTaskAtIndex(md, 2);
    expect(out).toContain("- [x] c");
    expect(out).toContain("- [ ] fenced");
  });

  it("fuera de rango no cambia nada", () => {
    expect(toggleTaskAtIndex(md, 9)).toBe(md);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && bun run test src/lib/links.test.ts`
Expected: FAIL — `extractSection is not a function` / `toggleTaskAtIndex is not a function`.

- [ ] **Step 3: Implement the helpers**

Agregar al final de `client/src/lib/links.ts`:

```ts
/** Devuelve el markdown de la sección `heading` (incluida su línea) hasta el próximo
 *  heading de nivel igual o mayor. Ignora code fences. null si no se encuentra. */
export function extractSection(content: string, heading: string): string | null {
  const target = heading.trim().toLowerCase();
  const lines = content.split("\n");
  let inFence = false;
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase() === target) {
        start = i;
        startLevel = m[1].length;
      }
    } else if (m[1].length <= startLevel) {
      return lines.slice(start, i).join("\n");
    }
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}

/** Flipea [ ]<->[x] en la n-ésima tarea bullet del markdown (orden de documento,
 *  salteando code fences). Devuelve md sin cambios si n está fuera de rango. */
export function toggleTaskAtIndex(md: string, n: number): string {
  const lines = md.split("\n");
  let inFence = false;
  let count = 0;
  const re = /^(\s*[-*+]\s+\[)([ xX])(\].*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = re.exec(lines[i]);
    if (!m) continue;
    if (count === n) {
      const checked = m[2] !== " ";
      lines[i] = m[1] + (checked ? " " : "x") + m[3];
      return lines.join("\n");
    }
    count++;
  }
  return md;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && bun run test src/lib/links.test.ts`
Expected: PASS (todos, incluidos los `parseHeadings` previos).

- [ ] **Step 5: Commit**

```bash
cd ~/code/forge && git add client/src/lib/links.ts client/src/lib/links.test.ts
git commit -m "feat(client): extractSection + toggleTaskAtIndex (helpers de embeds/tareas)"
```

---

### Task 2: Renderer de dos instancias + callouts + embeds + tareas

**Files:**
- Modify: `client/src/lib/markdown.ts` (reemplaza las líneas 1–99: imports, resolver, extensiones, render; **conserva** de la línea 100 en adelante: `TreeNode`, `buildTree`, `parseFrontmatter`, `stripFrontmatter`)
- Test: `client/src/lib/markdown.test.ts` (nuevo)

**Interfaces:**
- Consumes (de Task 1): `extractSection` (importado de `./links`).
- Produces:
  - `renderToHtml(md: string): string` — marked puro (sin sanitizar; node-safe), resetea el contador de tareas.
  - `renderMarkdown(md: string): string` — `DOMPurify.sanitize(renderToHtml(md))` (sin cambio de firma; lo usa `App.tsx`).
  - `setWikiResolver(fn: Resolver): void`, `parseFrontmatter`, `buildTree`, `stripFrontmatter` — **sin cambios** (se preservan).
  - HTML producido: tareas de la nota actual → `<input type="checkbox" data-task="N">`; callouts → `<div class="callout callout-TIPO [is-collapsed]" [data-fold] data-callout="TIPO">…`; embeds → `<div class="embed" data-doc-id="ID">…</div>` o `.embed-missing`.

- [ ] **Step 1: Write the failing tests**

Crear `client/src/lib/markdown.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderToHtml, setWikiResolver } from "~/lib/markdown";
import { createResolver } from "~/lib/links";
import type { Doc } from "~/lib/api";

const doc = (id: string, path: string, content: string): Doc => ({ id, path, content }) as Doc;

const docs: Doc[] = [
  doc("id-beta", "Beta.md", "# Beta\n\ntexto beta\n\n## Sub\n\ndetalle\n\n- [ ] tarea embebida\n"),
  doc("id-gamma", "Gamma.md", "gamma con\n\n![[Beta]]\n"),
];

beforeEach(() => setWikiResolver(createResolver(docs)));

describe("callouts", () => {
  it("renderiza tipo, título y data-callout", () => {
    const html = renderToHtml("> [!warning] Ojo\n> cuerpo\n");
    expect(html).toContain('class="callout callout-warning"');
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain("<span>Ojo</span>");
  });

  it("tipo desconocido cae a note", () => {
    expect(renderToHtml("> [!bogus] x\n> y\n")).toContain("callout-note");
  });

  it("[!x]- arranca colapsado con data-fold", () => {
    const html = renderToHtml("> [!info]- t\n> body\n");
    expect(html).toContain("is-collapsed");
    expect(html).toContain('data-fold="collapsed"');
  });

  it("sin marcador de fold no lleva caret ni data-fold", () => {
    const html = renderToHtml("> [!info] t\n> body\n");
    expect(html).not.toContain("callout-caret");
    expect(html).not.toContain("data-fold");
  });

  it("el cuerpo soporta markdown (wikilink)", () => {
    expect(renderToHtml("> [!note] t\n> ver [[Beta]]\n")).toContain('data-doc-id="id-beta"');
  });
});

describe("tareas interactivas", () => {
  it("asigna data-task en orden y salta fences", () => {
    const html = renderToHtml("- [ ] a\n- [x] b\n\n```\n- [ ] fenced\n```\n\n- [ ] c\n");
    expect(html).toContain('data-task="0"');
    expect(html).toContain('data-task="1"');
    expect(html).toContain('data-task="2"');
    expect(html).not.toContain('data-task="3"');
    expect(html).not.toContain("disabled");
  });
});

describe("embeds", () => {
  it("![[Nota]] expande el contenido encajonado y navegable", () => {
    const html = renderToHtml("![[Beta]]\n");
    expect(html).toContain('class="embed"');
    expect(html).toContain('data-doc-id="id-beta"');
    expect(html).toContain("texto beta");
  });

  it("![[Nota#Heading]] muestra solo la sección", () => {
    const html = renderToHtml("![[Beta#Sub]]\n");
    expect(html).toContain("detalle");
    expect(html).not.toContain("texto beta");
  });

  it("tareas dentro de un embed van disabled y sin data-task", () => {
    const html = renderToHtml("![[Beta]]\n");
    expect(html).toContain('<input type="checkbox" disabled');
    expect(html).not.toContain("data-task");
  });

  it("target inexistente muestra embed-missing", () => {
    expect(renderToHtml("![[NoExiste]]\n")).toContain("embed-missing");
  });

  it("embed anidado no se expande (cap de profundidad)", () => {
    const html = renderToHtml("![[Gamma]]\n");
    expect(html).toContain('data-doc-id="id-gamma"');
    expect(html).not.toContain("texto beta");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && bun run test src/lib/markdown.test.ts`
Expected: FAIL — `renderToHtml` no existe todavía (import error).

- [ ] **Step 3: Refactor `markdown.ts` (reemplazar líneas 1–99)**

Reemplazar el bloque desde la línea 1 hasta la 99 (inclusive, la `}` de cierre del `renderMarkdown` viejo) por lo siguiente. **No tocar** de `export type TreeNode` (línea 101) en adelante.

```ts
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { normalizeTarget, linkAlias, displayName, extractSection, type Resolver } from "./links";

// Resolver de wikilinks/embeds inyectable desde la UI (depende de los docs actuales).
let resolver: Resolver = () => null;
export function setWikiResolver(fn: Resolver) {
  resolver = fn;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Índice de tarea en curso durante un render (reseteado en renderToHtml). Solo lo
// incrementa el checkbox de la instancia interactiva (nota actual), no la de embeds.
const renderState = { taskIndex: 0 };

const CALLOUT_TYPES = new Set(["note", "info", "tip", "success", "question", "warning", "danger", "quote"]);

// Iconos inline estilo lucide (stroke=currentColor). Aprox; ajustables en el smoke visual.
const CALLOUT_ICONS: Record<string, string> = {
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  tip: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12c1 1 1 2 1 3h6c0-1 0-2 1-3a7 7 0 0 0-4-12Z"/>',
  success: '<path d="M20 6 9 17l-5-5"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  danger: '<path d="M12 2 2 7v6c0 5 4 8 10 9 6-1 10-4 10-9V7Z"/><path d="M12 9v4M12 16h.01"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5H3v7h4c0 4-2 5-4 5ZM14 21c3 0 7-1 7-8V5h-7v7h4c0 4-2 5-4 5Z"/>',
};
const calloutIcon = (type: string) =>
  `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CALLOUT_ICONS[type] ?? CALLOUT_ICONS.note}</svg>`;
const CALLOUT_CARET =
  '<svg class="callout-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

type RenderOpts = { interactiveTasks: boolean; expandEmbeds: boolean };

// Instancia de embeds: se declara acá para que la principal la referencie en su renderer.
let embedMd: Marked;

function createRenderer(opts: RenderOpts): Marked {
  const md = new Marked({ gfm: true, breaks: false });

  const wikilink: TokenizerAndRendererExtension = {
    name: "wikilink",
    level: "inline",
    start(src) {
      return src.indexOf("[[");
    },
    tokenizer(src) {
      const m = /^\[\[([^\]]+)\]\]/.exec(src);
      if (m) return { type: "wikilink", raw: m[0], text: m[1] };
    },
    renderer(token) {
      const raw = (token as unknown as { text: string }).text;
      const label = escapeHtml(linkAlias(raw));
      const dest = resolver(normalizeTarget(raw));
      if (dest) return `<a class="wikilink" data-doc-id="${escapeHtml(dest.id)}">${label}</a>`;
      return `<span class="wikilink wikilink-missing" title="Nota inexistente">${label}</span>`;
    },
  };

  const tag: TokenizerAndRendererExtension = {
    name: "tag",
    level: "inline",
    start(src) {
      const i = src.indexOf("#");
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^#([A-Za-z][\w/-]*)/.exec(src);
      if (m) return { type: "tag", raw: m[0], text: m[1] };
    },
    renderer(token) {
      const name = escapeHtml((token as unknown as { text: string }).text);
      return `<a class="tag" data-tag="${name}">#${name}</a>`;
    },
  };

  const callout: TokenizerAndRendererExtension = {
    name: "callout",
    level: "block",
    start(src) {
      const m = src.match(/^ *> *\[!/m);
      return m ? m.index : undefined;
    },
    tokenizer(src) {
      const m = /^ *> *\[!(\w+)\]([+-]?)(.*)(?:\n|$)((?: *>.*(?:\n|$))*)/.exec(src);
      if (!m) return;
      const type = m[1].toLowerCase();
      const body = m[4].replace(/^ *> ?/gm, "");
      return {
        type: "callout",
        raw: m[0],
        ctype: CALLOUT_TYPES.has(type) ? type : "note",
        fold: m[2],
        title: m[3].trim(),
        tokens: this.lexer.blockTokens(body),
      } as Tokens.Generic;
    },
    renderer(token) {
      const t = token as unknown as { ctype: string; fold: string; title: string; tokens: Tokens.Generic[] };
      const inner = this.parser.parse(t.tokens);
      const title = escapeHtml(t.title || t.ctype[0].toUpperCase() + t.ctype.slice(1));
      const foldAttr = t.fold ? ` data-fold="${t.fold === "-" ? "collapsed" : "expanded"}"` : "";
      const collapsed = t.fold === "-" ? " is-collapsed" : "";
      const caret = t.fold ? CALLOUT_CARET : "";
      return `<div class="callout callout-${t.ctype}${collapsed}"${foldAttr} data-callout="${t.ctype}"><div class="callout-title">${calloutIcon(t.ctype)}<span>${title}</span>${caret}</div><div class="callout-body">${inner}</div></div>`;
    },
  };

  const embed: TokenizerAndRendererExtension = {
    name: "embed",
    level: "block",
    start(src) {
      const m = src.match(/^!\[\[/m);
      return m ? m.index : undefined;
    },
    tokenizer(src) {
      const m = /^!\[\[([^\]]+)\]\] *(?:\n|$)/.exec(src);
      if (m) return { type: "embed", raw: m[0], text: m[1] };
    },
    renderer(token) {
      const raw = (token as unknown as { text: string }).text;
      const name = normalizeTarget(raw);
      const heading = raw.split("#")[1]?.split("|")[0]?.trim();
      const dest = resolver(name);
      if (!opts.expandEmbeds) {
        // Dentro de un embed: no expandir (cap de profundidad 1) → link navegable.
        if (dest) return `<p><a class="wikilink" data-doc-id="${escapeHtml(dest.id)}">${escapeHtml(name)}</a></p>`;
        return `<p><span class="wikilink wikilink-missing">${escapeHtml(name)}</span></p>`;
      }
      if (!dest) return `<div class="embed embed-missing">No se encontró: ${escapeHtml(name)}</div>`;
      const label = escapeHtml(displayName(dest.path));
      const title = `<div class="embed-title"><a data-doc-id="${escapeHtml(dest.id)}">${label}</a></div>`;
      const body = heading ? extractSection(dest.content, heading) : stripFrontmatter(dest.content);
      if (heading && body === null)
        return `<div class="embed" data-doc-id="${escapeHtml(dest.id)}">${title}<div class="embed-body embed-missing">Sección «${escapeHtml(heading)}» no encontrada</div></div>`;
      return `<div class="embed" data-doc-id="${escapeHtml(dest.id)}">${title}<div class="embed-body">${embedMd.parse(body ?? "")}</div></div>`;
    },
  };

  const checkbox = opts.interactiveTasks
    ? ({ checked }: { checked: boolean }) =>
        `<input type="checkbox" data-task="${renderState.taskIndex++}"${checked ? " checked" : ""}>`
    : ({ checked }: { checked: boolean }) => `<input type="checkbox" disabled${checked ? " checked" : ""}>`;

  md.use({ extensions: [wikilink, tag, callout, embed], renderer: { checkbox } });
  return md;
}

embedMd = createRenderer({ interactiveTasks: false, expandEmbeds: false });
const mainMd = createRenderer({ interactiveTasks: true, expandEmbeds: true });

// Marked puro (sin sanitizar) — usado por renderMarkdown y por los tests (entorno node sin DOM).
export function renderToHtml(md: string): string {
  renderState.taskIndex = 0;
  return mainMd.parse(stripFrontmatter(md)) as string;
}

export function renderMarkdown(md: string): string {
  // DOMPurify conserva class/data-*, input[type=checkbox] y <svg>; elimina <script>, handlers inline, iframes.
  return DOMPurify.sanitize(renderToHtml(md));
}
```

Nota: `stripFrontmatter` está definido más abajo en el archivo (bloque conservado, `export function` → hoisted); referenciarlo antes es válido. `embedMd` (`let`) se asigna antes de crear `mainMd` y solo se usa en tiempo de parseo, cuando ya está asignado.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && bun run test src/lib/markdown.test.ts`
Expected: PASS (todos los `describe`).

- [ ] **Step 5: Typecheck**

Run: `cd client && bun run typecheck`
Expected: sin errores. Si el tipo de `renderer.checkbox` o de `this.lexer`/`this.parser` choca con `@types/marked`, ajustá con un cast puntual (`as` o `this` explícito) — la semántica en runtime está validada.

- [ ] **Step 6: Commit**

```bash
cd ~/code/forge && git add client/src/lib/markdown.ts client/src/lib/markdown.test.ts
git commit -m "feat(client): callouts, embeds y tareas interactivas en el renderer (dos instancias marked)"
```

---

### Task 3: Estilos de callouts, embeds y checkbox

**Files:**
- Modify: `client/src/app.css` (append de un bloque nuevo al final del archivo)

**Interfaces:**
- Consumes (de Task 2): las clases `.callout`, `.callout-TIPO`, `.callout-title`, `.callout-icon`, `.callout-caret`, `.callout-body`, `.is-collapsed`, `[data-fold]`, `.embed`, `.embed-title`, `.embed-body`, `.embed-missing`, y `input[type="checkbox"][data-task]`.

Sin test automatizado (CSS presentacional); se verifica en el smoke visual de la Task 5.

- [ ] **Step 1: Agregar estilos al final de `client/src/app.css`**

```css

/* Callouts estilo Obsidian (> [!tipo]). */
.prose-bridges .callout {
  border: 1px solid hsl(var(--border));
  border-left: 3px solid var(--callout-color, hsl(var(--muted-foreground)));
  border-radius: var(--radius);
  background: var(--callout-bg, hsl(var(--muted) / 0.4));
  padding: 0.6em 0.9em;
  margin: 0.7em 0;
}
.prose-bridges .callout-title {
  display: flex;
  align-items: center;
  gap: 0.5em;
  font-weight: 600;
  color: var(--callout-color, hsl(var(--foreground)));
}
.prose-bridges .callout-icon { width: 1.1em; height: 1.1em; flex: none; }
.prose-bridges .callout-caret {
  width: 1em;
  height: 1em;
  margin-left: auto;
  transition: transform 0.15s;
  transform: rotate(90deg);
}
.prose-bridges .callout[data-fold] .callout-title { cursor: pointer; }
.prose-bridges .callout.is-collapsed .callout-caret { transform: rotate(0deg); }
.prose-bridges .callout.is-collapsed .callout-body { display: none; }
.prose-bridges .callout-body { margin-top: 0.4em; }
.prose-bridges .callout-body > :first-child { margin-top: 0; }
.prose-bridges .callout-body > :last-child { margin-bottom: 0; }
.prose-bridges .callout-note,
.prose-bridges .callout-quote { --callout-color: hsl(var(--muted-foreground)); --callout-bg: hsl(var(--muted-foreground) / 0.08); }
.prose-bridges .callout-info,
.prose-bridges .callout-tip { --callout-color: hsl(199 89% 55%); --callout-bg: hsl(199 89% 55% / 0.08); }
.prose-bridges .callout-success,
.prose-bridges .callout-question { --callout-color: hsl(142 71% 45%); --callout-bg: hsl(142 71% 45% / 0.08); }
.prose-bridges .callout-warning { --callout-color: hsl(38 92% 50%); --callout-bg: hsl(38 92% 50% / 0.1); }
.prose-bridges .callout-danger { --callout-color: hsl(var(--primary)); --callout-bg: hsl(var(--primary) / 0.1); }

/* Embeds (![[Nota]] / ![[Nota#Heading]]). */
.prose-bridges .embed {
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  padding: 0.2em 0.9em;
  margin: 0.7em 0;
  background: hsl(var(--muted) / 0.25);
}
.prose-bridges .embed-title { font-size: 0.8em; color: hsl(var(--muted-foreground)); margin: 0.4em 0; }
.prose-bridges .embed-title a { color: hsl(var(--muted-foreground)); cursor: pointer; }
.prose-bridges .embed-title a:hover { color: hsl(var(--foreground)); text-decoration: none; }
.prose-bridges .embed-missing { color: hsl(var(--muted-foreground)); font-style: italic; }
.prose-bridges .embed-body > :first-child { margin-top: 0; }

/* Checkbox de tareas interactivo. */
.prose-bridges input[type="checkbox"] {
  cursor: pointer;
  accent-color: hsl(var(--primary));
  margin-right: 0.4em;
  vertical-align: middle;
}
.prose-bridges input[type="checkbox"][disabled] { cursor: default; }
.prose-bridges li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1em; }
```

- [ ] **Step 2: Verificar que el build no rompe**

Run: `cd client && bun run build`
Expected: build OK (sin errores de CSS/PostCSS).

- [ ] **Step 3: Commit**

```bash
cd ~/code/forge && git add client/src/app.css
git commit -m "style(client): estilos de callouts, embeds y checkbox de tareas"
```

---

### Task 4: Wiring de interacción en `onPreviewClick`

**Files:**
- Modify: `client/src/App.tsx` (línea 53: extender import de `./links`; líneas 700–715: reemplazar `onPreviewClick`)

**Interfaces:**
- Consumes: `toggleTaskAtIndex` (de Task 1); el DOM que produce Task 2 (`input[data-task]`, `.callout-title`, `.callout[data-fold]`); `draft`/`setDraft`/`setDirty`/`onSave`/`onSearch`/`select` (ya existen en el componente).

Sin test automatizado nuevo: la lógica (`toggleTaskAtIndex`) ya está cubierta en Task 1; esto es delegación de eventos, verificada en el smoke de Task 5.

- [ ] **Step 1: Extender el import de `~/lib/links` (línea 53)**

Reemplazar:

```ts
import { buildBacklinks, createResolver, displayName, parseHeadings } from "~/lib/links";
```

por:

```ts
import { buildBacklinks, createResolver, displayName, parseHeadings, toggleTaskAtIndex } from "~/lib/links";
```

- [ ] **Step 2: Reemplazar `onPreviewClick` (líneas 700–715)**

```ts
  // Click en el preview: tarea -> togglea/guarda; callout colapsable -> fold;
  // #tag -> busca; [[wikilink]] / embed -> navega.
  const onPreviewClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // Tarea interactiva: togglea el source de la nota actual y guarda.
    const cb = target.closest("input[data-task]");
    if (cb) {
      e.preventDefault();
      const n = Number(cb.getAttribute("data-task"));
      setDraft(toggleTaskAtIndex(draft(), n));
      setDirty(true);
      void onSave();
      return;
    }
    // Callout colapsable: togglea el fold (efímero, no se escribe al .md).
    const calloutTitle = target.closest(".callout-title");
    if (calloutTitle) {
      const box = calloutTitle.closest(".callout[data-fold]");
      if (box) {
        box.classList.toggle("is-collapsed");
        return;
      }
    }
    const tagEl = target.closest("[data-tag]");
    if (tagEl) {
      e.preventDefault();
      onSearch("#" + tagEl.getAttribute("data-tag"));
      return;
    }
    const el = target.closest("[data-doc-id]");
    const id = el?.getAttribute("data-doc-id");
    if (id) {
      e.preventDefault();
      select(id);
    }
  };
```

- [ ] **Step 3: Typecheck**

Run: `cd client && bun run typecheck`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
cd ~/code/forge && git add client/src/App.tsx
git commit -m "feat(client): toggle de tareas y fold de callouts en el preview"
```

---

### Task 5: Verificación integral + smoke manual

**Files:** ninguno (verificación).

- [ ] **Step 1: Suite completa + typecheck**

Run: `cd client && bun run test && bun run typecheck`
Expected: todos los tests PASS (links + markdown + los previos de reconcile/editorSync/etc.), typecheck sin errores.

- [ ] **Step 2: Build de producción**

Run: `cd client && bun run build`
Expected: build OK.

- [ ] **Step 3: Smoke manual en la app**

Run: `cd client && bun run tauri dev`

Con un vault que tenga al menos dos notas (p. ej. `Beta.md` con un heading `## Sub` y una tarea `- [ ] x`), crear una nota con:

```md
## Tareas
- [ ] pendiente
- [x] hecha

> [!warning]- Ojo
> cuerpo con [[Beta]]

![[Beta]]

![[Beta#Sub]]

![[NoExiste]]
```

Verificar en **modo preview**:
- [ ] Clic en `- [ ] pendiente` la marca, y al reabrir la nota persiste (se guardó al `.md`).
- [ ] Clic en `- [x] hecha` la desmarca y persiste.
- [ ] El callout `[!warning]-` aparece colapsado; clic en el título lo expande/colapsa; el color/icono corresponden a warning.
- [ ] `![[Beta]]` muestra el contenido de Beta encajonado; su tarea interna se ve pero **no** togglea; el título navega a Beta al click.
- [ ] `![[Beta#Sub]]` muestra **solo** la sección `Sub`.
- [ ] `![[NoExiste]]` muestra la caja "No se encontró".
- [ ] Los checkboxes y los iconos SVG de callout se ven (confirma que `DOMPurify` no los eliminó).

- [ ] **Step 4: Actualizar el README (backlog → resuelto)**

En `README.md`, mover a la sección "Resuelto" (o marcar en "Más allá del MVP") una línea:

```md
- **Embeds `![[Nota]]` / `![[Nota#Heading]]`, callouts `> [!tipo]` colapsables y tareas `- [ ]` interactivas** en el preview (`lib/markdown.ts`: dos instancias de `marked`; toggle de tarea guarda al `.md`).
```

Commit:

```bash
cd ~/code/forge && git add README.md
git commit -m "docs: embeds + callouts + tareas interactivas en el README"
```

## Self-Review

**1. Spec coverage:**
- Embeds nota/sección/missing/nested + block-level → Task 2 (extension `embed`) + Task 1 (`extractSection`). ✓
- Callouts set curado + colapsables → Task 2 (extension `callout`) + Task 3 (CSS). ✓
- Tareas interactivas (render `data-task` + toggle-back + save) → Task 2 (checkbox) + Task 1 (`toggleTaskAtIndex`) + Task 4 (onPreviewClick). ✓
- Dos instancias / cap de profundidad / tareas embebidas disabled → Task 2. ✓
- Fold efímero → Task 4 (toggle de clase) + Task 3 (CSS). ✓
- Tests Vitest (links + markdown) → Task 1 y Task 2. ✓
- Verificación + smoke (sanitize/checkbox/svg) → Task 5. ✓
- Fuera de alcance (live-preview, block refs, imágenes, ordered tasks, inline embeds) → no hay tareas, correcto.

**2. Placeholder scan:** sin TBD/TODO; todo el código está completo y los comandos tienen output esperado.

**3. Type consistency:** `renderToHtml`/`renderMarkdown`/`setWikiResolver` (Task 2) coinciden con el consumo en `App.tsx` (import línea 52 sin cambios) y en los tests. `extractSection`/`toggleTaskAtIndex` (Task 1) coinciden con su uso en Task 2 (import de `./links`) y Task 4 (import en `App.tsx`). Clases CSS (Task 3) coinciden con las emitidas por el renderer (Task 2) y los selectores de `onPreviewClick` (Task 4: `input[data-task]`, `.callout-title`, `.callout[data-fold]`).
