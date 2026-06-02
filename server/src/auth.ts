/**
 * Auth multi-token con permisos por rol, scopeada por vault. Cada token
 * pertenece a UN vault; el server deduce el vault del token. Los tokens viven
 * en SQLite (se guarda el hash, no el token en claro). `BRIDGES_TOKEN` (env) es el
 * "server owner": admin del vault `default` y con poderes cross-vault.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";

export type Role = "viewer" | "editor" | "admin";
export type Perm = "read" | "write" | "delete";

/** Identidad resuelta de un token. El owner (BRIDGES_TOKEN) tiene isOwner=true. */
export type Identity = { name: string; role: Role; vault: string; isOwner: boolean };

export const ROLES: Role[] = ["viewer", "editor", "admin"];

const ROLE_PERMS: Record<Role, Perm[]> = {
  viewer: ["read"],
  editor: ["read", "write"],
  admin: ["read", "write", "delete"],
};

// La tabla `tokens` la crea db.ts (esquema multi-vault) / la migración.

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

const qIdentByHash = db.query<{ name: string; role: Role; vault: string }, [string]>(
  "SELECT name, role, vault FROM tokens WHERE token_hash = ?",
);
const qCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens");
const qList = db.query<{ name: string; role: Role; created_at: string }, [string]>(
  "SELECT name, role, created_at FROM tokens WHERE vault = ? ORDER BY name",
);
const qInsert = db.query(
  "INSERT INTO tokens (vault, name, token_hash, role, created_at) VALUES ($vault, $name, $hash, $role, $now)",
);
const qDelete = db.query("DELETE FROM tokens WHERE vault = ? AND name = ?");

const BOOTSTRAP = process.env.BRIDGES_TOKEN ?? null;

/** ¿La auth está activa? Sí si hay un admin de arranque o algún token en la tabla. */
export function authEnabled(): boolean {
  return BOOTSTRAP != null || qCount.get()!.n > 0;
}

/** Identidad del token, o null si es inválido. */
export function identityForToken(token: string | null): Identity | null {
  if (!token) return null;
  if (BOOTSTRAP && token === BOOTSTRAP) return { name: "admin", role: "admin", vault: "default", isOwner: true };
  const row = qIdentByHash.get(hash(token));
  return row ? { ...row, isOwner: false } : null;
}

/** Identidad del token que viene en el header Authorization: Bearer. */
export function identityForRequest(req: Request): Identity | null {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  return identityForToken(bearer);
}

export function roleCan(role: Role, perm: Perm): boolean {
  return ROLE_PERMS[role].includes(perm);
}

/** Crea un token nuevo en un vault y devuelve el secreto en claro (solo se ve acá una vez). */
export function addToken(vault: string, name: string, role: Role): string {
  if (!ROLES.includes(role)) throw new Error(`rol inválido: ${role} (usá ${ROLES.join(" | ")})`);
  const token = "bg_" + randomBytes(24).toString("hex");
  qInsert.run({ $vault: vault, $name: name, $hash: hash(token), $role: role, $now: new Date().toISOString() });
  return token;
}

export function listTokens(vault: string) {
  return qList.all(vault);
}

export function revokeToken(vault: string, name: string): boolean {
  return qDelete.run(vault, name).changes > 0;
}
