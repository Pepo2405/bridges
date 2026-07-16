/**
 * Capa de escritura del MCP de Bridges (Fase 0). Ops de filesystem puras sobre un
 * `vaultDir` explícito, con undo net propio en `.bridges/` (history + trash).
 * Local-only: nunca habla HTTP. Ver docs/superpowers/specs/2026-07-06-mcp-write-fase0-design.md
 */
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, existsSync, appendFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { deriveTitle } from "../../server/src/search-common";
import { resolveInVault } from "./bridges";

/** Carpeta interna del MCP dentro del vault (undo net + índice). Excluida del indexado. */
export const VAULT_INTERNAL = ".bridges";

/** Normaliza un título a nombre de archivo seguro (sin extensión). Nunca vacío. */
export function slug(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")     // no-alfanumérico → guion
    .replace(/^-+|-+$/g, "");        // recorta guiones de los bordes
  return s || "nota";
}

/** Dir de historial de una nota: .bridges/history/<relPath>/ */
export function historyDir(vaultDir: string, relPath: string): string {
  return join(vaultDir, VAULT_INTERNAL, "history", relPath);
}

/** Timestamp filesystem-safe (sin `:` ni `.`). */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

/**
 * Guarda el estado ACTUAL del `.md` en el historial antes de una edición/borrado.
 * No hace nada si el archivo no existe (create sin versión previa). Rota a 50.
 */
export function snapshot(vaultDir: string, relPath: string, now: number = Date.now()): void {
  const abs = resolveInVault(vaultDir, relPath);
  if (!existsSync(abs)) return;
  const hdir = historyDir(vaultDir, relPath);
  mkdirSync(hdir, { recursive: true });
  writeFileSync(join(hdir, `${stamp(now)}.md`), readFileSync(abs, "utf8"), "utf8");
  const files = readdirSync(hdir).sort(); // ISO ordena cronológicamente
  for (const f of files.slice(0, Math.max(0, files.length - 50))) {
    rmSync(join(hdir, f), { force: true });
  }
}
