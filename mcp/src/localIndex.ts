/**
 * Índice FTS5 local del vault, construido desde la réplica de `.md` en disco
 * (BRIDGES_VAULT_DIR). Evita el round-trip HTTP al server: la búsqueda pasa de
 * ~290 ms (red) a sub-ms. Funciona offline y sin token.
 *
 * Espeja exactamente el índice del server (bridges-server/src/db.ts + search.ts)
 * para que el ranking local sea idéntico al remoto: mismas columnas
 * (title, path, content), mismo tokenizer (unicode61 remove_diacritics 2),
 * mismos pesos BM25 (10/5/1) y el mismo `deriveTitle` (primer H1 o filename).
 *
 * Frescura: estrategia mtime-sweep. En cada búsqueda se recorre el dir y se
 * reindexa SOLO lo que cambió (mtime distinto), se da de alta lo nuevo y se baja
 * lo borrado. Para ~70 docs el sweep es ~1-2 ms, así que el índice está siempre
 * al día sin watcher. El cliente Tauri ya mantiene los `.md` sincronizados en
 * disco; esto solo refleja ese estado.
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { toMatchQuery, deriveTitle, FTS_TOKENIZER } from "../../server/src/search-common";
import type { SearchHit } from "./bridges";

// Pesos BM25 por columna (title, path, content), idénticos a search.ts del server.
const BM25 = "bm25(fts, 10.0, 5.0, 1.0)";

type Row = { path: string; title: string | null; snippet: string };

let db: Database | null = null;
let qIns: ReturnType<Database["query"]>;
let qDel: ReturnType<Database["query"]>;
let qSearch: ReturnType<Database["query"]>;

// relPath -> rowid estable, y relPath -> mtimeMs visto por última vez.
const rowids = new Map<string, number>();
const mtimes = new Map<string, number>();
let nextRowid = 1;

function init() {
  db = new Database(":memory:");
  // FTS5 standalone (no external-content): el MCP no tiene la tabla `documents`,
  // así que el contenido vive en el propio índice. A esta escala el ~2x de tamaño
  // es irrelevante.
  db.run(
    `CREATE VIRTUAL TABLE fts USING fts5(title, path, content, tokenize="${FTS_TOKENIZER}")`,
  );
  qIns = db.query(`INSERT INTO fts(rowid, title, path, content) VALUES (?, ?, ?, ?)`);
  qDel = db.query(`DELETE FROM fts WHERE rowid = ?`);
  // snippet sobre col idx 2 (content), igual que el server (30 tokens).
  qSearch = db.query(
    `SELECT path, title, snippet(fts, 2, '', '', '…', 30) AS snippet
     FROM fts WHERE fts MATCH ?1 ORDER BY ${BM25} LIMIT ?2`,
  );
}

/** Paths relativos de los .md bajo `dir` (recursivo, ignora ocultos como .obsidian/.git). */
export function walkMd(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p, base));
    else if (e.name.endsWith(".md")) out.push(p.slice(base.length + 1));
  }
  return out;
}

/** Reindexa solo lo cambiado/nuevo y baja lo borrado. ~1-2 ms para ~70 docs. */
function sweep(vaultDir: string) {
  const seen = new Set<string>();
  for (const rel of walkMd(vaultDir)) {
    seen.add(rel);
    const mt = statSync(join(vaultDir, rel)).mtimeMs;
    if (mtimes.get(rel) === mt) continue; // sin cambios
    const content = readFileSync(join(vaultDir, rel), "utf8");
    let rid = rowids.get(rel);
    if (rid != null) qDel.run(rid);
    else {
      rid = nextRowid++;
      rowids.set(rel, rid);
    }
    qIns.run(rid, deriveTitle(content, rel), rel, content);
    mtimes.set(rel, mt);
  }
  for (const rel of [...rowids.keys()]) {
    if (seen.has(rel)) continue; // sigue en disco
    qDel.run(rowids.get(rel)!);
    rowids.delete(rel);
    mtimes.delete(rel);
  }
}

/** Búsqueda full-text contra el índice local, manteniéndolo fresco antes de consultar. */
export function searchLocal(vaultDir: string, query: string, limit: number): SearchHit[] {
  if (!db) init();
  sweep(vaultDir);
  const match = toMatchQuery(query);
  if (!match) return [];
  const rows = qSearch.all(match, limit) as Row[];
  return rows.map((r) => ({
    path: r.path,
    title: r.title,
    snippet: r.snippet,
    localPath: join(vaultDir, r.path),
  }));
}
