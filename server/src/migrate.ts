/**
 * Migración idempotente al esquema multi-vault. Se invoca al tope de db.ts,
 * antes de preparar los `db.query(...)`. SQLite no cambia UNIQUE/PK con ALTER,
 * así que `documents`, `changes` y `tokens` se reconstruyen (nueva tabla →
 * copiar con vault='default' → drop → rename). Todo lo viejo cae al vault
 * `default`; el FORGE_TOKEN sigue siendo admin de `default`.
 *
 * DB primero (transaccional/reversible), disco después (idempotente por sí solo).
 */
import type { Database } from "bun:sqlite";
import { copyFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR } from "./vault";

const DB_PATH = process.env.FORGE_DB ?? "forge.db";

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** ¿Hace falta migrar? No si la DB es virgen, ni si ya tiene el esquema nuevo. */
function needsMigration(db: Database): boolean {
  if (!tableExists(db, "documents")) return false; // DB virgen: db.ts crea el esquema nuevo
  const hasVaults = tableExists(db, "vaults");
  const docHasVault = columns(db, "documents").includes("vault");
  return !(hasVaults && docHasVault);
}

export function migrate(db: Database): void {
  if (!needsMigration(db)) return;

  // --- Backup del .db antes de tocar nada ---
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    copyFileSync(DB_PATH, `${DB_PATH}.bak-pre-multivault-${ts}`);
  } catch (e) {
    console.warn(`[migrate] no se pudo respaldar ${DB_PATH}: ${e}`);
  }

  const lastSeq =
    (db.query("SELECT last_seq FROM meta WHERE id = 1").get() as { last_seq: number } | null)?.last_seq ?? 0;
  const changesHasContent = tableExists(db, "changes") && columns(db, "changes").includes("content");
  const tokensOld = tableExists(db, "tokens") && !columns(db, "tokens").includes("vault");

  db.exec("PRAGMA foreign_keys = OFF;");
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        slug       TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        last_seq   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO vaults (slug, name, last_seq, created_at)
        VALUES ('default', 'default', 0, '${new Date().toISOString()}');
    `);
    db.query("UPDATE vaults SET last_seq = ? WHERE slug = 'default'").run(lastSeq);

    // --- documents ---
    db.exec(`
      CREATE TABLE documents_new (
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
      INSERT INTO documents_new (id, vault, path, title, content, version, seq, deleted, updated_by, updated_at)
        SELECT id, 'default', path, title, content, version, seq, deleted, updated_by, updated_at FROM documents;
      DROP TABLE documents;
      ALTER TABLE documents_new RENAME TO documents;
      CREATE INDEX IF NOT EXISTS idx_documents_vault_seq ON documents(vault, seq);
    `);

    // --- changes (con o sin la columna content) ---
    const selChanges = changesHasContent
      ? "SELECT id, 'default', doc_id, seq, author, action, created_at, content FROM changes"
      : "SELECT id, 'default', doc_id, seq, author, action, created_at, NULL FROM changes";
    db.exec(`
      CREATE TABLE changes_new (
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
      INSERT INTO changes_new (id, vault, doc_id, seq, author, action, created_at, content) ${selChanges};
      DROP TABLE changes;
      ALTER TABLE changes_new RENAME TO changes;
      CREATE INDEX IF NOT EXISTS idx_changes_vault_seq ON changes(vault, seq);
      CREATE INDEX IF NOT EXISTS idx_changes_doc ON changes(doc_id);
    `);

    // --- tokens (si existía con el esquema viejo) ---
    if (tokensOld) {
      db.exec(`
        CREATE TABLE tokens_new (
          vault       TEXT NOT NULL,
          name        TEXT NOT NULL,
          token_hash  TEXT NOT NULL UNIQUE,
          role        TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          PRIMARY KEY (vault, name),
          FOREIGN KEY (vault) REFERENCES vaults(slug)
        );
        INSERT INTO tokens_new (vault, name, token_hash, role, created_at)
          SELECT 'default', name, token_hash, role, created_at FROM tokens;
        DROP TABLE tokens;
        ALTER TABLE tokens_new RENAME TO tokens;
      `);
    }

    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error(`foreign_key_check falló: ${JSON.stringify(violations)}`);
  });
  run();
  db.exec("PRAGMA foreign_keys = ON;");

  // --- Disco: mover los hijos de VAULT_DIR (excepto default/ y *.bak) a default/ ---
  migrateDisk();

  console.log(`[migrate] esquema multi-vault aplicado (vault 'default', last_seq=${lastSeq}).`);
}

function migrateDisk(): void {
  if (!existsSync(VAULT_DIR)) return;
  const defaultDir = join(VAULT_DIR, "default");
  const entries = readdirSync(VAULT_DIR, { withFileTypes: true });
  // Si solo existe default/ (y backups), ya está migrado.
  const movable = entries.filter((e) => e.name !== "default" && !e.name.includes(".bak"));
  if (!movable.length) return;
  mkdirSync(defaultDir, { recursive: true });
  for (const e of movable) {
    const from = join(VAULT_DIR, e.name);
    const to = join(defaultDir, e.name);
    if (existsSync(to)) {
      throw new Error(`[migrate] colisión al mover ${from} → ${to} (ya existe). Resolvé a mano.`);
    }
    renameSync(from, to);
  }
  console.log(`[migrate] ${movable.length} entradas movidas a ${defaultDir}`);
}
