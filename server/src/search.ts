import { db } from "./db";

export type SearchHit = {
  id: string;
  path: string;
  title: string | null;
  snippet: string;
};

// Búsqueda full-text con FTS5. Columnas indexadas: title, path, content.
// Ranking BM25 con pesos title=10, path=5, content=1 (un match en el título
// pesa más). snippet() saca el fragmento más relevante de content (col idx 2)
// con elipsis en los bordes.
const qSearch = db.query<
  { id: string; path: string; title: string | null; snippet: string },
  [string, string]
>(
  `SELECT d.id, d.path, d.title,
          snippet(documents_fts, 2, '', '', '…', 12) AS snippet
   FROM documents_fts
   JOIN documents d ON d.rowid = documents_fts.rowid
   WHERE documents_fts MATCH ?1 AND d.vault = ?2 AND d.deleted = 0
   ORDER BY bm25(documents_fts, 10.0, 5.0, 1.0)
   LIMIT 50`,
);

/**
 * Convierte el texto libre del usuario en una query MATCH segura de FTS5.
 * Tokeniza por letras/números (descarta la sintaxis especial de FTS5: comillas,
 * `*`, `:`, `AND/OR/NOT`, etc.), envuelve cada token en comillas y le agrega `*`
 * para prefix-match (búsqueda mientras se tipea). AND implícito entre tokens.
 * Devuelve "" si no quedan tokens.
 */
function toMatchQuery(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return "";
  return tokens.map((t) => `"${t}"*`).join(" ");
}

/** Búsqueda full-text (FTS5/BM25) sobre el índice de un vault. */
export function searchDocs(vault: string, query: string): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  return qSearch.all(match, vault);
}
