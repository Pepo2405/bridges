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
      // Token custom: marked's Tokens type can't express our `text` field.
      const t = token as unknown as { text: string };
      const raw = t.text;
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
      // Token custom: marked's Tokens type can't express our `text` field.
      const t = token as unknown as { text: string };
      const name = escapeHtml(t.text);
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
      // Token custom: marked's Tokens type can't express our callout fields.
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
      // Token custom: marked's Tokens type can't express our `text` field.
      const t = token as unknown as { text: string };
      const raw = t.text;
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

// Frontmatter YAML al inicio del doc (--- ... ---). Como Obsidian, no se
// renderiza en el preview; marked lo mostraría como basura (hr + heading).
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function stripFrontmatter(md: string): string {
  return md.replace(FRONTMATTER, "");
}

export type Property = { key: string; value: string | string[] };

// Parser mínimo del frontmatter: escalares (`key: val`) y arrays inline
// (`key: [a, b]`). Suficiente para lo que usamos; no es un YAML completo.
export function parseFrontmatter(md: string): Property[] {
  const m = FRONTMATTER.exec(md);
  if (!m) return [];
  const out: Property[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      const items = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      out.push({ key, value: items });
    } else if (val) {
      out.push({ key, value: val.replace(/^["']|["']$/g, "") });
    }
  }
  return out;
}

export type TreeNode = {
  name: string;
  path: string; // full path para archivos; path de carpeta para dirs
  isDir: boolean;
  docId?: string;
  children: TreeNode[];
};

/** Arma un árbol por carpetas a partir de la lista plana de docs. */
export function buildTree(docs: { id: string; path: string }[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };

  for (const doc of docs) {
    const parts = doc.path.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.isDir !== isFile);
      if (!child) {
        child = { name: part, path: acc, isDir: !isFile, docId: isFile ? doc.id : undefined, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }

  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}
