import { db } from "./db";
import { searchAndThenOr } from "./search-common";

export type SearchHit = {
  id: string;
  path: string;
  title: string | null;
  snippet: string;
};

// Búsqueda full-text con FTS5. Columnas indexadas: title, path, content.
// Ranking BM25 con pesos title=10, path=5, content=1 (un match en el título
// pesa más). snippet() saca el fragmento más relevante de content (col idx 2)
// con elipsis en los bordes (30 tokens: suficiente para que un agente decida si
// abrir la nota sin traerla entera).
const qSearch = db.query<
  { id: string; path: string; title: string | null; snippet: string },
  [string, string]
>(
  `SELECT d.id, d.path, d.title,
          snippet(documents_fts, 2, '', '', '…', 30) AS snippet
   FROM documents_fts
   JOIN documents d ON d.rowid = documents_fts.rowid
   WHERE documents_fts MATCH ?1 AND d.vault = ?2 AND d.deleted = 0
   ORDER BY bm25(documents_fts, 10.0, 5.0, 1.0)
   LIMIT 50`,
);

/** Búsqueda full-text (FTS5/BM25) sobre el índice de un vault. AND de todos los
 *  términos; si no hay resultados, OR (ver searchAndThenOr). */
export function searchDocs(vault: string, query: string): SearchHit[] {
  return searchAndThenOr(query, (match) => qSearch.all(match, vault));
}
