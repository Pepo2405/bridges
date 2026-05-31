/**
 * Auth multi-token con permisos por rol. Los tokens viven en SQLite (se guarda
 * el hash, no el token en claro) y se consultan por request — agregar/revocar
 * funciona en vivo sin reiniciar. `FORGE_TOKEN` (env) es un admin de arranque
 * opcional: escape hatch para el primer deploy cuando la tabla está vacía.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";

export type Role = "viewer" | "editor" | "admin";
export type Perm = "read" | "write" | "delete";

export const ROLES: Role[] = ["viewer", "editor", "admin"];

const ROLE_PERMS: Record<Role, Perm[]> = {
  viewer: ["read"],
  editor: ["read", "write"],
  admin: ["read", "write", "delete"],
};

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    name        TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
`);

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

const qByHash = db.query<{ role: Role }, [string]>("SELECT role FROM tokens WHERE token_hash = ?");
const qCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens");
const qList = db.query<{ name: string; role: Role; created_at: string }, []>(
  "SELECT name, role, created_at FROM tokens ORDER BY name",
);
const qInsert = db.query(
  "INSERT INTO tokens (name, token_hash, role, created_at) VALUES ($name, $hash, $role, $now)",
);
const qDelete = db.query("DELETE FROM tokens WHERE name = ?");

const BOOTSTRAP = process.env.FORGE_TOKEN ?? null;

/** ¿La auth está activa? Sí si hay un admin de arranque o algún token en la tabla. */
export function authEnabled(): boolean {
  return BOOTSTRAP != null || qCount.get()!.n > 0;
}

/** Devuelve el rol del token, o null si es inválido. */
export function roleForToken(token: string | null): Role | null {
  if (!token) return null;
  if (BOOTSTRAP && token === BOOTSTRAP) return "admin";
  return qByHash.get(hash(token))?.role ?? null;
}

export function roleCan(role: Role, perm: Perm): boolean {
  return ROLE_PERMS[role].includes(perm);
}

/** Crea un token nuevo y devuelve el secreto en claro (solo se ve acá una vez). */
export function addToken(name: string, role: Role): string {
  if (!ROLES.includes(role)) throw new Error(`rol inválido: ${role} (usá ${ROLES.join(" | ")})`);
  const token = "fg_" + randomBytes(24).toString("hex");
  qInsert.run({ $name: name, $hash: hash(token), $role: role, $now: new Date().toISOString() });
  return token;
}

export function listTokens() {
  return qList.all();
}

export function revokeToken(name: string): boolean {
  return qDelete.run(name).changes > 0;
}
