import { marked, type TokenizerAndRendererExtension } from "marked";
import { normalizeTarget, linkAlias, type Resolver } from "./links";

marked.setOptions({ gfm: true, breaks: false });

// Resolver de wikilinks inyectable desde la UI (depende de los docs actuales).
let resolver: Resolver = () => null;
export function setWikiResolver(fn: Resolver) {
  resolver = fn;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Extensión [[wikilink]] / [[target|alias]] -> anchor navegable (o span "missing").
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

// #tag inline -> pill clicleable (como Obsidian). Debe empezar con letra para no
// agarrar `#123` ni colores hex (que igual van entre backticks → inline code). Los
// `#` de headings son block-level y no llegan acá; los de `[[a#b]]` los come wikilink.
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

marked.use({ extensions: [wikilink, tag] });

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

export function renderMarkdown(md: string): string {
  return marked.parse(stripFrontmatter(md)) as string;
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
