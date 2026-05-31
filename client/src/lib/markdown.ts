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
    const raw = (token as { text: string }).text;
    const label = escapeHtml(linkAlias(raw));
    const dest = resolver(normalizeTarget(raw));
    if (dest) return `<a class="wikilink" data-doc-id="${escapeHtml(dest.id)}">${label}</a>`;
    return `<span class="wikilink wikilink-missing" title="Nota inexistente">${label}</span>`;
  },
};

marked.use({ extensions: [wikilink] });

export function renderMarkdown(md: string): string {
  return marked.parse(md) as string;
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
