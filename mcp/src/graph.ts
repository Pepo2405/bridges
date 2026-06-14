/**
 * Grafo de wikilinks del vault para el MCP. Reusa las primitivas puras de
 * server/src/links-common (parseWikilinks/normalizeTarget/basename). A diferencia
 * del cliente (que indexa por id estable de doc), acá la identidad es el PATH: el
 * MCP no tiene ids locales. Resolución por path completo (sin .md) o por basename.
 */
import { basename, normalizeTarget, parseWikilinks } from "../../server/src/links-common";

export type DocLite = { path: string; title: string | null; content: string };

type Resolver = (target: string) => DocLite | null;

/** Crea un resolver target -> DocLite (por path completo sin .md, o por basename). */
export function createResolver(docs: DocLite[]): Resolver {
  const byPath = new Map<string, DocLite>();
  const byBasename = new Map<string, DocLite>();
  for (const d of docs) {
    byPath.set(d.path.replace(/\.md$/i, "").toLowerCase(), d);
    const bn = basename(d.path);
    if (!byBasename.has(bn)) byBasename.set(bn, d);
  }
  return (target) => {
    const key = normalizeTarget(target).toLowerCase();
    return byPath.get(key) ?? byBasename.get(key) ?? null;
  };
}

/** Docs que enlazan a `path` (sin self, sin duplicados, ordenados por path). */
export function getBacklinks(docs: DocLite[], path: string): DocLite[] {
  const resolve = createResolver(docs);
  const out: DocLite[] = [];
  const seen = new Set<string>();
  for (const src of docs) {
    if (src.path === path) continue; // sin self
    for (const link of parseWikilinks(src.content)) {
      const dest = resolve(link);
      if (dest && dest.path === path && !seen.has(src.path)) {
        seen.add(src.path);
        out.push(src);
        break;
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Link saliente: el target textual y el doc al que resuelve (null = roto). */
export type OutgoingLink = { target: string; resolved: DocLite | null };

/** Links salientes de la nota en `path` (dedup por target; los no resueltos = rotos). */
export function getOutgoingLinks(docs: DocLite[], path: string): OutgoingLink[] {
  const doc = docs.find((d) => d.path === path);
  if (!doc) return [];
  const resolve = createResolver(docs);
  const out: OutgoingLink[] = [];
  const seen = new Set<string>();
  for (const target of parseWikilinks(doc.content)) {
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ target, resolved: resolve(target) });
  }
  return out;
}
