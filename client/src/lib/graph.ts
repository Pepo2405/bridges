import type { Doc } from "./api";
import { createResolver, parseWikilinks, displayName } from "./links";

export type GraphNode = {
  id: string; // docId, o "phantom:<target>" si no existe
  label: string;
  docId: string | null; // null = enlace no resuelto (fantasma)
  degree: number;
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

/** Construye el grafo de notas conectadas por [[wikilinks]] (estilo Obsidian). */
export function buildGraph(docs: Doc[]): Graph {
  const resolve = createResolver(docs);

  const nodes = new Map<string, GraphNode>();
  const linkSet = new Set<string>();
  const links: GraphLink[] = [];

  const ensureDocNode = (d: Doc): GraphNode => {
    let n = nodes.get(d.id);
    if (!n) {
      n = { id: d.id, label: displayName(d.path), docId: d.id, degree: 0 };
      nodes.set(d.id, n);
    }
    return n;
  };

  const ensurePhantom = (target: string): GraphNode => {
    const id = `phantom:${target.toLowerCase()}`;
    let n = nodes.get(id);
    if (!n) {
      n = { id, label: target, docId: null, degree: 0 };
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
