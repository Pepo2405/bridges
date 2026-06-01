import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { writeDoc, removeDoc } from "./vault";
import { migrate } from "./migrate";

const DB_PATH = process.env.FORGE_DB ?? "forge.db";

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Migración al esquema multi-vault (idempotente). Debe correr ANTES de preparar
// los db.query(...) de abajo, porque reconstruye documents/changes/tokens.
migrate(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS vaults (
    slug       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    last_seq   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    vault       TEXT NOT NULL,
    path        TEXT NOT NULL,
    title       TEXT,
    content     TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    seq         INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_by  TEXT,
    updated_at  TEXT NOT NULL,
    UNIQUE (vault, path),
    FOREIGN KEY (vault) REFERENCES vaults(slug)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_vault_seq ON documents(vault, seq);

  CREATE TABLE IF NOT EXISTS changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vault       TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    author      TEXT,
    action      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    content     TEXT,
    FOREIGN KEY (doc_id) REFERENCES documents(id),
    FOREIGN KEY (vault) REFERENCES vaults(slug)
  );

  CREATE INDEX IF NOT EXISTS idx_changes_vault_seq ON changes(vault, seq);
  CREATE INDEX IF NOT EXISTS idx_changes_doc ON changes(doc_id);

  CREATE TABLE IF NOT EXISTS tokens (
    vault       TEXT NOT NULL,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (vault, name),
    FOREIGN KEY (vault) REFERENCES vaults(slug)
  );

  INSERT OR IGNORE INTO vaults (slug, name, last_seq, created_at)
    VALUES ('default', 'default', 0, '${new Date().toISOString()}');
`);

export type Vault = { slug: string; name: string; last_seq: number; created_at: string };

export type Doc = {
  id: string;
  vault: string;
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

/** Ítem de la papelera: doc borrado, sin content (listado liviano). */
export type TrashItem = {
  id: string;
  path: string;
  title: string | null;
  updated_by: string | null;
  updated_at: string;
  seq: number;
};

const qNextSeq = db.query<{ last_seq: number }, [string]>(
  "UPDATE vaults SET last_seq = last_seq + 1 WHERE slug = ? RETURNING last_seq",
);
const DOC_COLS = "id, vault, path, title, content, version, seq, deleted, updated_by, updated_at";
const qDocById = db.query<Doc, [string]>(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`);
const qDocByPath = db.query<Doc, [string, string]>(
  `SELECT ${DOC_COLS} FROM documents WHERE vault = ? AND path = ?`,
);
const qSince = db.query<Doc, [string, number]>(
  `SELECT ${DOC_COLS} FROM documents WHERE vault = ? AND seq > ? ORDER BY seq ASC`,
);
const qHistory = db.query<Change, [string]>(
  "SELECT seq, author, action, created_at FROM changes WHERE doc_id = ? ORDER BY seq DESC LIMIT 100",
);
const qLastSeq = db.query<{ last_seq: number }, [string]>("SELECT last_seq FROM vaults WHERE slug = ?");
const qInsert = db.query(
  `INSERT INTO documents (id, vault, path, title, content, version, seq, deleted, updated_by, updated_at)
   VALUES ($id, $vault, $path, $title, $content, 1, $seq, 0, $author, $now)`,
);
const qUpdate = db.query(
  `UPDATE documents SET path=$path, title=$title, content=$content, version=version+1,
   seq=$seq, deleted=0, updated_by=$author, updated_at=$now WHERE id=$id`,
);
const qSoftDelete = db.query(
  `UPDATE documents SET deleted=1, version=version+1, seq=$seq, updated_by=$author, updated_at=$now WHERE id=$id`,
);
const qChange = db.query(
  `INSERT INTO changes (vault, doc_id, seq, author, action, created_at, content)
   VALUES ($vault, $doc, $seq, $author, $action, $now, $content)`,
);
const qVersion = db.query<{ content: string | null }, [string, number]>(
  "SELECT content FROM changes WHERE doc_id = ? AND seq = ?",
);
const qTrash = db.query<TrashItem, [string]>(
  "SELECT id, path, title, updated_by, updated_at, seq FROM documents WHERE vault = ? AND deleted = 1 ORDER BY seq DESC",
);
const qRestore = db.query(
  `UPDATE documents SET deleted=0, version=version+1, seq=$seq, updated_by=$author, updated_at=$now WHERE id=$id`,
);
const qPurgeChanges = db.query("DELETE FROM changes WHERE doc_id = ?");
const qPurgeDoc = db.query("DELETE FROM documents WHERE id = ?");

const qVaultBySlug = db.query<Vault, [string]>("SELECT slug, name, last_seq, created_at FROM vaults WHERE slug = ?");
const qVaultList = db.query<Vault, []>("SELECT slug, name, last_seq, created_at FROM vaults ORDER BY created_at");
const qVaultInsert = db.query(
  "INSERT INTO vaults (slug, name, last_seq, created_at) VALUES ($slug, $name, 0, $now)",
);

/** Doc por id (global, sin scope). Para chequear pertenencia de vault internamente. */
export function getDoc(id: string): Doc | null {
  return qDocById.get(id) ?? null;
}

export function getDocByPath(vault: string, path: string): Doc | null {
  return qDocByPath.get(vault, path) ?? null;
}

export function getLastSeq(vault: string): number {
  return qLastSeq.get(vault)?.last_seq ?? 0;
}

/** Historial de cambios de un doc (más reciente primero, hasta 100). Vacío si no es del vault. */
export function getHistory(vault: string, id: string): Change[] {
  const doc = getDoc(id);
  if (!doc || doc.vault !== vault) return [];
  return qHistory.all(id);
}

/** Contenido del doc en un cambio (seq). null si no hay snapshot o no es del vault. */
export function getVersion(vault: string, id: string, seq: number): string | null {
  const doc = getDoc(id);
  if (!doc || doc.vault !== vault) return null;
  return qVersion.get(id, seq)?.content ?? null;
}

export function syncSince(vault: string, since: number): { documents: Doc[]; last_seq: number } {
  const documents = qSince.all(vault, since);
  return { documents, last_seq: getLastSeq(vault) };
}

export function getVault(slug: string): Vault | null {
  return qVaultBySlug.get(slug) ?? null;
}

export function listVaults(): Vault[] {
  return qVaultList.all();
}

/** Crea un vault nuevo. Lanza ConflictError si el slug ya existe. */
export function createVault(slug: string, name: string): Vault {
  if (getVault(slug)) throw new ConflictError("vault already exists");
  qVaultInsert.run({ $slug: slug, $name: name, $now: new Date().toISOString() });
  return getVault(slug)!;
}

/** Crea un documento nuevo. Asigna seq, escribe en SQLite y en disco. */
export const createDoc = db.transaction(
  (input: { vault: string; path: string; title?: string | null; content: string; author?: string | null }) => {
    if (getDocByPath(input.vault, input.path)) throw new ConflictError("path already exists");
    const seq = qNextSeq.get(input.vault)!.last_seq;
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = input.title ?? deriveTitle(input.content, input.path);
    qInsert.run({ $id: id, $vault: input.vault, $path: input.path, $title: title, $content: input.content, $seq: seq, $author: input.author ?? null, $now: now });
    qChange.run({ $vault: input.vault, $doc: id, $seq: seq, $author: input.author ?? null, $action: "create", $now: now, $content: input.content });
    writeDoc(input.vault, input.path, input.content);
    return getDoc(id)!;
  },
);

/** Actualiza con versión optimista. Lanza ConflictError si base_version quedó vieja. */
export const updateDoc = db.transaction(
  (input: {
    vault: string;
    id: string;
    path: string;
    title?: string | null;
    content: string;
    base_version: number;
    author?: string | null;
  }) => {
    const current = getDoc(input.id);
    if (!current || current.vault !== input.vault) throw new NotFoundError("doc not found");
    if (current.version !== input.base_version) throw new ConflictError("version mismatch", current);

    // Si cambió el path, validar que el nuevo no choque con otro doc vivo del vault.
    if (input.path !== current.path) {
      const other = getDocByPath(input.vault, input.path);
      if (other && other.id !== input.id) throw new ConflictError("path already exists", other);
    }

    const seq = qNextSeq.get(input.vault)!.last_seq;
    const now = new Date().toISOString();
    const title = input.title ?? deriveTitle(input.content, input.path);
    qUpdate.run({ $id: input.id, $path: input.path, $title: title, $content: input.content, $seq: seq, $author: input.author ?? null, $now: now });
    qChange.run({ $vault: input.vault, $doc: input.id, $seq: seq, $author: input.author ?? null, $action: "update", $now: now, $content: input.content });
    if (input.path !== current.path) removeDoc(input.vault, current.path);
    writeDoc(input.vault, input.path, input.content);
    return getDoc(input.id)!;
  },
);

/** Borrado lógico. Propaga deleted=1 y borra el archivo en disco. */
export const deleteDoc = db.transaction((vault: string, id: string, author?: string | null) => {
  const current = getDoc(id);
  if (!current || current.vault !== vault) throw new NotFoundError("doc not found");
  if (current.deleted) return current;
  const seq = qNextSeq.get(vault)!.last_seq;
  const now = new Date().toISOString();
  qSoftDelete.run({ $id: id, $seq: seq, $author: author ?? null, $now: now });
  qChange.run({ $vault: vault, $doc: id, $seq: seq, $author: author ?? null, $action: "delete", $now: now, $content: null });
  removeDoc(vault, current.path);
  return getDoc(id)!;
});

/** Docs borrados del vault (papelera), más reciente primero. */
export function listTrash(vault: string): TrashItem[] {
  return qTrash.all(vault);
}

/**
 * Restaura un doc borrado: deleted=1→0, bump seq, reescribe el .md en disco.
 * Idempotente si ya está vivo, NotFoundError si no existe o no es del vault. El
 * path nunca colisiona: UNIQUE(vault, path) lo mantiene reservado mientras está
 * borrado (ningún otro doc vivo puede ocuparlo).
 */
export const restoreDoc = db.transaction((vault: string, id: string, author?: string | null) => {
  const current = getDoc(id);
  if (!current || current.vault !== vault) throw new NotFoundError("doc not found");
  if (!current.deleted) return current;
  const seq = qNextSeq.get(vault)!.last_seq;
  const now = new Date().toISOString();
  qRestore.run({ $id: id, $seq: seq, $author: author ?? null, $now: now });
  qChange.run({ $vault: vault, $doc: id, $seq: seq, $author: author ?? null, $action: "restore", $now: now, $content: current.content });
  writeDoc(vault, current.path, current.content);
  return getDoc(id)!;
});

/** Borrado físico de un doc de la papelera (fila + su historial). Sólo si está borrado. */
export const purgeDoc = db.transaction((vault: string, id: string) => {
  const current = getDoc(id);
  if (!current || current.vault !== vault) throw new NotFoundError("doc not found");
  if (!current.deleted) throw new NotFoundError("doc not in trash");
  qPurgeChanges.run(id);
  qPurgeDoc.run(id);
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
