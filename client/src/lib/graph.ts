import type { Doc } from "./api";
import { createResolver, parseWikilinks, displayName } from "./links";

export type GraphNode = {
  id: string; // docId, o "phantom:<target>" si no existe
  label: string;
  docId: string | null; // null = enlace no resuelto (fantasma)
  degree: number;
  refs: number; // backlinks entrantes: cuántas notas distintas la referencian (su "masa")
  group: string | null; // carpeta top-level (para el color); null = fantasma
  // posición/velocidad las completa d3-force
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
};

export type GraphLink = { source: string | GraphNode; target: string | GraphNode };

export type Graph = { nodes: GraphNode[]; links: GraphLink[] };

/** Carpeta top-level de una ruta ("Proyectos/x/y.md" → "Proyectos"; raíz → ""). */
function topFolder(path: string): string {
  const i = path.indexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Construye el grafo de notas conectadas por [[wikilinks]] (estilo Obsidian). */
export function buildGraph(docs: Doc[]): Graph {
  const resolve = createResolver(docs);

  const nodes = new Map<string, GraphNode>();
  const linkSet = new Set<string>();
  const directed = new Set<string>(); // pares from->to ya contados como backlink
  const links: GraphLink[] = [];

  const ensureDocNode = (d: Doc): GraphNode => {
    let n = nodes.get(d.id);
    if (!n) {
      n = { id: d.id, label: displayName(d.path), docId: d.id, degree: 0, refs: 0, group: topFolder(d.path) };
      nodes.set(d.id, n);
    }
    return n;
  };

  const ensurePhantom = (target: string): GraphNode => {
    const id = `phantom:${target.toLowerCase()}`;
    let n = nodes.get(id);
    if (!n) {
      n = { id, label: target, docId: null, degree: 0, refs: 0, group: null };
      nodes.set(id, n);
    }
    return n;
  };

  // Todos los docs son nodos, aunque no tengan enlaces.
  for (const d of docs) ensureDocNode(d);

  for (const d of docs) {
    const from = ensureDocNode(d);
    for (const target of parseWikilinks(d.content)) {
      const dest = resolve(target);
      const to = dest ? ensureDocNode(dest) : ensurePhantom(target);
      if (to.id === from.id) continue;

      // backlink dirigido: cada nota-origen distinta suma 1 a los refs del destino
      const dkey = `${from.id}->${to.id}`;
      if (!directed.has(dkey)) {
        directed.add(dkey);
        to.refs++;
      }

      const pair = from.id < to.id ? `${from.id}|${to.id}` : `${to.id}|${from.id}`;
      if (linkSet.has(pair)) continue;
      linkSet.add(pair);
      links.push({ source: from.id, target: to.id });
      from.degree++;
      to.degree++;
    }
  }

  return { nodes: [...nodes.values()], links };
}
