/**
 * Lógica de búsqueda compartida entre el server (search.ts, db.ts) y el MCP
 * (localIndex.ts). Fuente ÚNICA: si cambia la tokenización o la derivación de
 * título, cambia acá y se refleja en ambos lados. Módulo PURO (sin bun:sqlite ni
 * imports del server) para que el MCP lo pueda importar tal cual.
 *
 * OJO Docker: este archivo vive en server/src/ a propósito — el Dockerfile del
 * server copia solo `src/`, así que un módulo compartido fuera de acá no estaría
 * en la imagen. El MCP lo importa por path relativo (../../server/src/...).
 */

/** Tokenizer de FTS5: insensible a acentos. Usado en el CREATE VIRTUAL TABLE. */
export const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

/**
 * Convierte texto libre del usuario en una query MATCH segura de FTS5: tokeniza
 * por letras/números (descarta la sintaxis especial), envuelve cada token en
 * comillas y agrega `*` para prefix-match. `op` "AND" (default, implícito) exige
 * todos los términos; "OR" acepta cualquiera. "" si no hay tokens.
 */
export function toMatchQuery(query: string, op: "AND" | "OR" = "AND"): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return "";
  return tokens.map((t) => `"${t}"*`).join(op === "OR" ? " OR " : " ");
}

/**
 * Corre `run` con la query en AND y, si no hay resultados y hay más de un término,
 * reintenta en OR. Con muchos términos el AND suele dar vacío aunque la nota
 * exista; en OR, BM25 ya rankea primero las notas que matchean más términos.
 * Si el AND trae algo, el resultado es idéntico al de siempre.
 */
export function searchAndThenOr<T>(query: string, run: (match: string) => T[]): T[] {
  const and = toMatchQuery(query);
  if (!and) return [];
  const hits = run(and);
  if (hits.length) return hits;
  const or = toMatchQuery(query, "OR");
  return or === and ? hits : run(or);
}

/** Título derivado: primer H1 del contenido, si no el filename sin .md. */
export function deriveTitle(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
