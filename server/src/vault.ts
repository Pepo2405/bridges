import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const VAULT_DIR = process.env.FORGE_VAULT ?? join(import.meta.dir, "..", "vault");

/** Slug de vault: minúsculas/dígitos/guiones. Doble como segmento de disco. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Raíz de disco de un vault: `${FORGE_VAULT}/${slug}/`. Valida el slug. */
function vaultRoot(vault: string): string {
  if (!isValidSlug(vault)) throw new Error(`slug de vault inválido: ${vault}`);
  return join(VAULT_DIR, vault);
}

/** Resuelve un path relativo dentro del vault, bloqueando traversal (../). */
function resolveInVault(vault: string, relPath: string): string {
  const base = vaultRoot(vault);
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = join(base, clean);
  const root = normalize(base + sep);
  if (!normalize(abs + sep).startsWith(root) && abs !== normalize(base)) {
    throw new Error(`path escapes vault: ${relPath}`);
  }
  return abs;
}

export function writeDoc(vault: string, relPath: string, content: string): void {
  const abs = resolveInVault(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

export function removeDoc(vault: string, relPath: string): void {
  const abs = resolveInVault(vault, relPath);
  rmSync(abs, { force: true });
}

/** Crea la carpeta de disco del vault (idempotente). */
export function ensureVaultDir(vault: string): void {
  mkdirSync(vaultRoot(vault), { recursive: true });
}

export { VAULT_DIR };
