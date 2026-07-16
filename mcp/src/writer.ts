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
