import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const VAULT_DIR = process.env.FORGE_VAULT ?? join(import.meta.dir, "..", "vault");

/** Resuelve un path relativo dentro del vault, bloqueando traversal (../). */
function resolveInVault(relPath: string): string {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = join(VAULT_DIR, clean);
  const root = normalize(VAULT_DIR + sep);
  if (!normalize(abs + sep).startsWith(root) && abs !== normalize(VAULT_DIR)) {
    throw new Error(`path escapes vault: ${relPath}`);
  }
  return abs;
}

export function writeDoc(relPath: string, content: string): void {
  const abs = resolveInVault(relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

export function removeDoc(relPath: string): void {
  const abs = resolveInVault(relPath);
  rmSync(abs, { force: true });
}

export { VAULT_DIR };
