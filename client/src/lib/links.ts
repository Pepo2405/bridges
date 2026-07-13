import type { Doc } from "./api";

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

/** Alias de un wikilink (lo que va después del |), o el target si no hay alias. */
export function linkAlias(raw: string): string {
  const parts = raw.split("|");
  return (parts[1] ?? parts[0]).split("#")[0].split("^")[0].trim();
}

export type Resolver = (target: string) => Doc | null;

/** Crea un resolver target -> Doc (por path completo o por basename). */
export function createResolver(docs: Doc[]): Resolver {
  const byBasename = new Map<string, Doc>();
  const byPath = new Map<string, Doc>();
  for (const d of docs) {
    byPath.set(d.path.replace(/\.md$/i, "").toLowerCase(), d);
    const bn = basename(d.path);
    if (!byBasename.has(bn)) byBasename.set(bn, d);
  }
  return (target: string) => {
    const key = normalizeTarget(target).toLowerCase();
    return byPath.get(key) ?? byBasename.get(key) ?? null;
  };
}

/** Headings (texto, sin los #) de un contenido markdown, ignorando bloques de código. */
export function parseHeadings(content: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const ln of content.split("\n")) {
    if (/^```/.test(ln)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(ln);
    if (m) out.push(m[1].trim());
  }
  return out;
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

/** Índice de backlinks: para cada docId, qué docs lo enlazan (sin duplicados, sin self). */
export function buildBacklinks(docs: Doc[]): Map<string, Doc[]> {
  const resolve = createResolver(docs);
  const back = new Map<string, Set<string>>();
  const byId = new Map(docs.map((d) => [d.id, d]));

  for (const src of docs) {
    const seen = new Set<string>();
    for (const target of parseWikilinks(src.content)) {
      const dest = resolve(target);
      if (!dest || dest.id === src.id || seen.has(dest.id)) continue;
      seen.add(dest.id);
      if (!back.has(dest.id)) back.set(dest.id, new Set());
      back.get(dest.id)!.add(src.id);
    }
  }

  const result = new Map<string, Doc[]>();
  for (const [destId, srcIds] of back) {
    result.set(
      destId,
      [...srcIds].map((id) => byId.get(id)!).sort((a, b) => a.path.localeCompare(b.path)),
    );
  }
  return result;
}

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
  const re = /^(\s*(?:>\s*)*[-*+]\s+\[)([ xX])(\].*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:>\s*)*```/.test(lines[i])) {
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
