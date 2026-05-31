import { db } from "./db";

export type SearchHit = {
  id: string;
  path: string;
  title: string | null;
  snippet: string;
};

const qSearch = db.query<
  { id: string; path: string; title: string | null; content: string },
  [string, string, string, string]
>(
  `SELECT id, path, title, content FROM documents
   WHERE vault = ?4 AND deleted = 0 AND (title LIKE ?1 OR path LIKE ?2 OR content LIKE ?3)
   ORDER BY (title LIKE ?1) DESC, path ASC
   LIMIT 50`,
);

/** Búsqueda full-text básica (LIKE case-insensitive) sobre el índice de un vault. */
export function searchDocs(vault: string, query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
  const rows = qSearch.all(like, like, like, vault);
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    snippet: makeSnippet(r.content, q),
  }));
}

function makeSnippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, 120).replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 80);
  return (start > 0 ? "…" : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "…" : "");
}
