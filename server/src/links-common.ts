/**
 * Primitivas de wikilinks ([[...]]) compartidas. Módulo PURO (sin imports). Vive
 * en server/src/ por la restricción del Docker (igual que search-common.ts), para
 * que el MCP lo importe por path relativo (../../server/src/links-common). El
 * server hoy no lo usa; el cliente conserva su client/src/lib/links.ts con la
 * lógica de resolución acoplada a su tipo Doc (id-based).
 */

const WIKILINK = /\[\[([^\]]+)\]\]/g;

/** Nombre de archivo para mostrar (sin carpeta ni .md), respetando mayúsculas. */
export function displayName(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}

/** Clave de matcheo de un nombre: basename en minúsculas. */
export function basename(path: string): string {
  return displayName(path).toLowerCase();
}

/** Normaliza un target de wikilink: saca alias (|), heading (#) y bloque (^). */
export function normalizeTarget(raw: string): string {
  return raw.split("|")[0].split("#")[0].split("^")[0].trim();
}

/** Targets de wikilink (normalizados) que aparecen en un contenido. */
export function parseWikilinks(content: string): string[] {
  const out: string[] = [];
  WIKILINK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK.exec(content))) {
    const t = normalizeTarget(m[1]);
    if (t) out.push(t);
  }
  return out;
}
