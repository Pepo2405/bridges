/**
 * Capa de escritura del MCP de Bridges (Fase 0). Ops de filesystem puras sobre un
 * `vaultDir` explícito, con undo net propio en `.bridges/` (history + trash).
 * Local-only: nunca habla HTTP. Ver docs/superpowers/specs/2026-07-06-mcp-write-fase0-design.md
 */
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, existsSync, appendFileSync,
} from "node:fs";
import { join, dirname, basename, relative } from "node:path";
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

/** Dir de historial de una nota: .bridges/history/<relPath sanitizado>/. El destino
 *  pasa por resolveInVault (misma guarda que la fuente) para bloquear traversal. */
export function historyDir(vaultDir: string, relPath: string): string {
  const safeRel = relative(vaultDir, resolveInVault(vaultDir, relPath));
  return join(vaultDir, VAULT_INTERNAL, "history", safeRel);
}

/** Resultado de una operación de escritura. */
export type WriteResult = { path: string; title: string | null; action: string; mode?: string; bytes: number };

/** Resultado de una operación de borrado. */
export type DeleteResult = { path: string; action: "trashed"; trashPath: string };

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
  const base = stamp(now);
  // Sufijo de secuencia uniforme y zero-padded: desambigua colisiones del mismo ms
  // y ordena SIEMPRE por (timestamp, secuencia) — el separador '.' es uniforme, así
  // que el orden lexicográfico coincide con el cronológico (a diferencia de un `-N`).
  const seq = readdirSync(hdir).filter((f) => f.startsWith(base + ".")).length;
  const name = `${base}.${String(seq).padStart(3, "0")}.md`;
  writeFileSync(join(hdir, name), readFileSync(abs, "utf8"), "utf8");
  const files = readdirSync(hdir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 50))) {
    rmSync(join(hdir, f), { force: true });
  }
}

/** Escribe `content` en `abs`, creando dirs; devuelve bytes escritos. */
function writeFileEnsured(abs: string, content: string): number {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return Buffer.byteLength(content, "utf8");
}

export function createNote(
  vaultDir: string,
  args: { title: string; content: string; path?: string; folder?: string; overwrite?: boolean },
): WriteResult {
  const rel = args.path
    ? (args.path.endsWith(".md") ? args.path : `${args.path}.md`)
    : join(args.folder || "Memoria", `${slug(args.title)}.md`);
  const abs = resolveInVault(vaultDir, rel);
  if (existsSync(abs) && !args.overwrite) {
    throw new Error(`ya existe una nota en "${rel}" (pasá overwrite:true para reemplazar).`);
  }
  snapshot(vaultDir, rel); // no-op si no existía
  const bytes = writeFileEnsured(abs, args.content);
  return { path: rel, title: deriveTitle(args.content, rel), action: "created", bytes };
}

/**
 * Reemplaza el cuerpo bajo `heading` (texto sin `#`) por `newBody`, hasta el próximo
 * heading de nivel igual o mayor (mismo nº de `#` o menos). Heading inexistente → throw.
 * Consciente de code fences (```): las líneas dentro de un bloque de código no cuentan
 * como headings (un `# comentario` en bash no corta la sección).
 */
export function patchSection(content: string, heading: string, newBody: string): string {
  const lines = content.split("\n");
  const target = heading.replace(/^#+\s*/, "").trim();
  // 1) localizar el heading, ignorando líneas dentro de fences
  let inFence = false;
  let hIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{1,6}\s+/.test(lines[i]) && lines[i].replace(/^#{1,6}\s+/, "").trim() === target) {
      hIdx = i;
      break;
    }
  }
  if (hIdx === -1) throw new Error(`heading no encontrado: "${heading}"`);
  const level = lines[hIdx].match(/^#+/)![0].length;
  // 2) fin de la sección: próximo heading de nivel <= level, también ignorando fences.
  //    El heading en hIdx no está dentro de un fence, así que reiniciamos el estado.
  let end = lines.length;
  inFence = false;
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const before = lines.slice(0, hIdx + 1);
  const after = lines.slice(end);
  const body = newBody.replace(/\n+$/, "");
  const joined = [...before, "", body, "", ...after].join("\n");
  return joined.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

export function updateNote(
  vaultDir: string,
  args: { path: string; mode: "overwrite" | "append" | "patch"; content: string; heading?: string },
): WriteResult {
  const rel = args.path;
  const abs = resolveInVault(vaultDir, rel);
  if (!existsSync(abs)) throw new Error(`no existe la nota "${rel}".`);
  snapshot(vaultDir, rel);
  let next: string;
  if (args.mode === "overwrite") {
    next = args.content;
  } else if (args.mode === "append") {
    const prev = readFileSync(abs, "utf8");
    next = prev.endsWith("\n") ? prev + args.content : `${prev}\n${args.content}`;
  } else {
    const prev = readFileSync(abs, "utf8");
    if (!args.heading) throw new Error(`modo patch requiere "heading".`);
    next = patchSection(prev, args.heading, args.content);
  }
  const bytes = writeFileEnsured(abs, next);
  return { path: rel, title: deriveTitle(next, rel), action: "updated", mode: args.mode, bytes };
}

export function deleteNote(vaultDir: string, relPath: string, now: number = Date.now()): DeleteResult {
  const abs = resolveInVault(vaultDir, relPath);
  if (!existsSync(abs)) throw new Error(`no existe la nota "${relPath}".`);
  const ts = stamp(now);
  const trashRel = join(VAULT_INTERNAL, "trash", ts, relPath);
  const trashAbs = resolveInVault(vaultDir, trashRel);
  mkdirSync(dirname(trashAbs), { recursive: true });
  renameSync(abs, trashAbs);
  const manifestAbs = join(vaultDir, VAULT_INTERNAL, "trash", "manifest.jsonl");
  mkdirSync(dirname(manifestAbs), { recursive: true });
  appendFileSync(manifestAbs, JSON.stringify({ path: relPath, trashPath: trashRel, ts }) + "\n", "utf8");
  return { path: relPath, action: "trashed", trashPath: trashRel };
}
