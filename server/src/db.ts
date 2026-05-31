import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { writeDoc, removeDoc } from "./vault";

const DB_PATH = process.env.FORGE_DB ?? "forge.db";

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    title       TEXT,
    content     TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    seq         INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_by  TEXT,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_seq ON documents(seq);

  CREATE TABLE IF NOT EXISTS changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    author      TEXT,
    action      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (doc_id) REFERENCES documents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);

  INSERT OR IGNORE INTO meta (id, last_seq) VALUES (1, 0);
`);

// Migración: snapshot del contenido por cambio (para diff/restaurar). En DBs
// viejas la columna no existe; ADD COLUMN es barato. Ignoramos si ya está.
try {
  db.exec("ALTER TABLE changes ADD COLUMN content TEXT");
} catch {
  /* la columna ya existe */
}

export type Doc = {
  id: string;
  path: string;
  title: string | null;
  content: string;
  version: number;
  seq: number;
  deleted: number;
  updated_by: string | null;
  updated_at: string;
};

export type Change = { seq: number; author: string | null; action: string; created_at: string };

const qNextSeq = db.query<{ last_seq: number }, []>(
  "UPDATE meta SET last_seq = last_seq + 1 WHERE id = 1 RETURNING last_seq",
);
const DOC_COLS = "id, path, title, content, version, seq, deleted, updated_by, updated_at";
const qDocById = db.query<Doc, [string]>(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`);
const qDocByPath = db.query<Doc, [string]>(`SELECT ${DOC_COLS} FROM documents WHERE path = ?`);
const qSince = db.query<Doc, [number]>(`SELECT ${DOC_COLS} FROM documents WHERE seq > ? ORDER BY seq ASC`);
const qHistory = db.query<Change, [string]>(
  "SELECT seq, author, action, created_at FROM changes WHERE doc_id = ? ORDER BY seq DESC LIMIT 100",
);
const qLastSeq = db.query<{ last_seq: number }, []>("SELECT last_seq FROM meta WHERE id = 1");
const qInsert = db.query(
  `INSERT INTO documents (id, path, title, content, version, seq, deleted, updated_by, updated_at)
   VALUES ($id, $path, $title, $content, 1, $seq, 0, $author, $now)`,
);
const qUpdate = db.query(
  `UPDATE documents SET path=$path, title=$title, content=$content, version=version+1,
   seq=$seq, deleted=0, updated_by=$author, updated_at=$now WHERE id=$id`,
);
const qSoftDelete = db.query(
  `UPDATE documents SET deleted=1, version=version+1, seq=$seq, updated_by=$author, updated_at=$now WHERE id=$id`,
);
const qChange = db.query(
  `INSERT INTO changes (doc_id, seq, author, action, created_at, content)
   VALUES ($doc, $seq, $author, $action, $now, $content)`,
);
const qVersion = db.query<{ content: string | null }, [string, number]>(
  "SELECT content FROM changes WHERE doc_id = ? AND seq = ?",
);

export function getDoc(id: string): Doc | null {
  return qDocById.get(id) ?? null;
}

export function getDocByPath(path: string): Doc | null {
  return qDocByPath.get(path) ?? null;
}

export function getLastSeq(): number {
  return qLastSeq.get()!.last_seq;
}

/** Historial de cambios de un doc (más reciente primero, hasta 100). */
export function getHistory(id: string): Change[] {
  return qHistory.all(id);
}

/** Contenido del doc tal como quedó en un cambio (seq). null si no se guardó snapshot. */
export function getVersion(id: string, seq: number): string | null {
  return qVersion.get(id, seq)?.content ?? null;
}

export function syncSince(since: number): { documents: Doc[]; last_seq: number } {
  const documents = qSince.all(since);
  return { documents, last_seq: getLastSeq() };
}

/** Crea un documento nuevo. Asigna seq, escribe en SQLite y en disco. */
export const createDoc = db.transaction(
  (input: { path: string; title?: string | null; content: string; author?: string | null }) => {
    if (getDocByPath(input.path)) throw new ConflictError("path already exists");
    const seq = qNextSeq.get()!.last_seq;
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = input.title ?? deriveTitle(input.content, input.path);
    qInsert.run({ $id: id, $path: input.path, $title: title, $content: input.content, $seq: seq, $author: input.author ?? null, $now: now });
    qChange.run({ $doc: id, $seq: seq, $author: input.author ?? null, $action: "create", $now: now, $content: input.content });
    writeDoc(input.path, input.content);
    return getDoc(id)!;
  },
);

/** Actualiza con versión optimista. Lanza ConflictError si base_version quedó vieja. */
export const updateDoc = db.transaction(
  (input: {
    id: string;
    path: string;
    title?: string | null;
    content: string;
    base_version: number;
    author?: string | null;
  }) => {
    const current = getDoc(input.id);
    if (!current) throw new NotFoundError("doc not found");
    if (current.version !== input.base_version) throw new ConflictError("version mismatch", current);

    // Si cambió el path, validar que el nuevo no choque con otro doc vivo.
    if (input.path !== current.path) {
      const other = getDocByPath(input.path);
      if (other && other.id !== input.id) throw new ConflictError("path already exists", other);
    }

    const seq = qNextSeq.get()!.last_seq;
    const now = new Date().toISOString();
    const title = input.title ?? deriveTitle(input.content, input.path);
    qUpdate.run({ $id: input.id, $path: input.path, $title: title, $content: input.content, $seq: seq, $author: input.author ?? null, $now: now });
    qChange.run({ $doc: input.id, $seq: seq, $author: input.author ?? null, $action: "update", $now: now, $content: input.content });
    if (input.path !== current.path) removeDoc(current.path);
    writeDoc(input.path, input.content);
    return getDoc(input.id)!;
  },
);

/** Borrado lógico. Propaga deleted=1 y borra el archivo en disco. */
export const deleteDoc = db.transaction((id: string, author?: string | null) => {
  const current = getDoc(id);
  if (!current) throw new NotFoundError("doc not found");
  if (current.deleted) return current;
  const seq = qNextSeq.get()!.last_seq;
  const now = new Date().toISOString();
  qSoftDelete.run({ $id: id, $seq: seq, $author: author ?? null, $now: now });
  qChange.run({ $doc: id, $seq: seq, $author: author ?? null, $action: "delete", $now: now, $content: null });
  removeDoc(current.path);
  return getDoc(id)!;
});

function deriveTitle(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export class ConflictError extends Error {
  constructor(message: string, public server?: Doc) {
    super(message);
  }
}
export class NotFoundError extends Error {}
