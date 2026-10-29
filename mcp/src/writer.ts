/**
 * Capa de escritura del MCP de Bridges (Fase 0). Ops de filesystem puras sobre un
 * `vaultDir` explícito, con undo net propio en `.bridges/` (history + trash).
 * Local-only: nunca habla HTTP. Ver docs/superpowers/specs/2026-07-06-mcp-write-fase0-design.md
 */
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync, appendFileSync, rmdirSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
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

/** Directorios internos del vault que las write-tools nunca deben tocar. */
const PROTECTED_DIRS: Record<string, true> = {
  [VAULT_INTERNAL]: true,
  ".git": true,
  ".obsidian": true,
};

/**
 * Resuelve un path de escritura dentro del vault y rechaza directorios internos.
 * `.bridges/` es la red de undo del propio MCP: si una tool pudiera escribir ahí,
 * el agente podría borrar sus snapshots y quedarse sin rollback. Case-insensitive
 * porque APFS/Windows no distinguen `.bridges` de `.Bridges`.
 */
function resolveWritable(vaultDir: string, relPath: string): string {
  const abs = resolveInVault(vaultDir, relPath);
  const first = relative(vaultDir, abs).split(/[\\/]/)[0]?.toLowerCase() ?? "";
  if (!first || PROTECTED_DIRS[first]) {
    throw new Error(`no se puede escribir en rutas internas del vault: "${relPath}"`);
  }
  return abs;
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
    : join(args.folder || process.env.BRIDGES_MCP_DEFAULT_FOLDER?.trim() || "Memoria", `${slug(args.title)}.md`);
  const abs = resolveWritable(vaultDir, rel);
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
  const abs = resolveWritable(vaultDir, rel);
  if (!existsSync(abs)) throw new Error(`no existe la nota "${rel}".`);
  let next: string;
  if (args.mode === "overwrite") {
    snapshot(vaultDir, rel);
    next = args.content;
  } else if (args.mode === "append") {
    snapshot(vaultDir, rel);
    const prev = readFileSync(abs, "utf8");
    next = prev.endsWith("\n") ? prev + args.content : `${prev}\n${args.content}`;
  } else {
    // patch: computar el resultado ANTES de snapshotear, así un heading inválido
    // (o ausente) no deposita un snapshot inútil (erosiona la rotación de 50).
    const prev = readFileSync(abs, "utf8");
    if (!args.heading) throw new Error(`modo patch requiere "heading".`);
    next = patchSection(prev, args.heading, args.content);
    snapshot(vaultDir, rel);
  }
  const bytes = writeFileEnsured(abs, next);
  return { path: rel, title: deriveTitle(next, rel), action: "updated", mode: args.mode, bytes };
}

export function deleteNote(vaultDir: string, relPath: string, now: number = Date.now()): DeleteResult {
  const abs = resolveWritable(vaultDir, relPath);
  if (!existsSync(abs)) throw new Error(`no existe la nota "${relPath}".`);
  const ts = stamp(now);
  const safeRel = relative(vaultDir, abs); // sanitizado: mismo enfoque anti-traversal que historyDir
  // desambigua colisiones (mismo path + mismo ts) con un contador en el dir <ts>
  let trashRel = join(VAULT_INTERNAL, "trash", ts, safeRel);
  let n = 1;
  while (existsSync(resolveInVault(vaultDir, trashRel))) {
    trashRel = join(VAULT_INTERNAL, "trash", `${ts}-${n++}`, safeRel);
  }
  const trashAbs = resolveInVault(vaultDir, trashRel);
  mkdirSync(dirname(trashAbs), { recursive: true });
  renameSync(abs, trashAbs);
  const manifestAbs = manifestPath(vaultDir);
  mkdirSync(dirname(manifestAbs), { recursive: true });
  appendFileSync(manifestAbs, JSON.stringify({ path: relPath, trashPath: trashRel, ts }) + "\n", "utf8");
  return { path: relPath, action: "trashed", trashPath: trashRel };
}

/** Resultado de una restauración (desde trash o history). */
export type RestoreResult = { path: string; action: "restored"; source: "trash" | "history" };
/** Entrada de historial: un snapshot en `.bridges/history/` o un borrado en `.bridges/trash/`. */
export type HistoryEntry = { kind: "history" | "trash"; ts: string; ref: string };

type TrashRec = { path: string; trashPath: string; ts: string };

/** Ruta del manifest de trash (una entrada JSON por línea). */
function manifestPath(vaultDir: string): string {
  return join(vaultDir, VAULT_INTERNAL, "trash", "manifest.jsonl");
}

/** Reescribe el manifest de forma atómica; sin entradas, lo elimina. */
function writeManifest(vaultDir: string, records: TrashRec[]): void {
  const p = manifestPath(vaultDir);
  if (!records.length) {
    rmSync(p, { force: true });
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  renameSync(tmp, p);
}

/** Lee el manifest de trash. [] si no existe aún. */
function readManifest(vaultDir: string): TrashRec[] {
  const p = manifestPath(vaultDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrashRec);
}

/** Borra directorios vacíos desde `dir` hacia arriba, sin tocar `stop`. */
function removeEmptyDirsUpTo(dir: string, stop: string): void {
  let cur = dir;
  while (cur !== stop && cur.startsWith(stop + sep)) {
    try {
      rmdirSync(cur);
    } catch {
      return; // no está vacío (u otro error): no seguir subiendo
    }
    cur = dirname(cur);
  }
}

/** Snapshots de history + entradas de trash de una nota, ordenados por ts. */
export function listHistory(vaultDir: string, relPath: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const hdir = historyDir(vaultDir, relPath);
  if (existsSync(hdir)) {
    // ref sanitizado: relative(vaultDir, hdir), NO el relPath crudo (historyDir ya
    // pasó por resolveInVault) — mismo enfoque anti-traversal que el resto del módulo.
    const relHistoryDir = relative(vaultDir, hdir);
    for (const f of readdirSync(hdir).sort()) {
      out.push({ kind: "history", ts: f.replace(/\.md$/, ""), ref: join(relHistoryDir, f) });
    }
  }
  for (const rec of readManifest(vaultDir).filter((r) => r.path === relPath)) {
    out.push({ kind: "trash", ts: rec.ts, ref: rec.trashPath });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Restaura una nota borrada (desde trash) o revierte una edición (desde history).
 * Default: trash si hay una entrada para `path`, si no el snapshot de history más
 * reciente. No pisa un archivo existente, salvo que sea un revert desde history
 * (ahí se snapshotea el estado actual antes de sobreescribir). Nada que restaurar → throw.
 */
export function restoreNote(
  vaultDir: string,
  args: { path: string; from?: "trash" | "history"; timestamp?: string },
): RestoreResult {
  const rel = args.path;
  const abs = resolveWritable(vaultDir, rel); // destino: siempre vía resolveWritable
  const manifest = readManifest(vaultDir);
  const trash = manifest.filter((r) => r.path === rel);
  const wantTrash = args.from === "trash" || (!args.from && trash.length > 0);
  if (wantTrash) {
    const rec = args.timestamp ? trash.find((r) => r.ts === args.timestamp) : trash[trash.length - 1];
    if (!rec) throw new Error(`nada que restaurar en trash para "${rel}".`);
    if (existsSync(abs)) {
      throw new Error(`ya existe una nota en "${rel}"; no se puede restaurar desde trash sin pisarla.`);
    }
    const src = resolveInVault(vaultDir, rec.trashPath); // fuente también vía resolveInVault
    const trashRoot = join(vaultDir, VAULT_INTERNAL, "trash");
    // Defensa extra: una entrada de manifest corrupta no debe poder leer/borrar
    // un archivo fuera de la papelera.
    if (!src.startsWith(trashRoot + sep)) throw new Error(`entrada de trash inválida: "${rec.trashPath}"`);
    writeFileEnsured(abs, readFileSync(src, "utf8"));
    // La nota ya está viva: su copia en trash no es una versión recuperable
    // distinta y su entrada quedaría stale en list_history. Se limpia.
    writeManifest(vaultDir, manifest.filter((r) => r.trashPath !== rec.trashPath));
    rmSync(src, { force: true });
    removeEmptyDirsUpTo(dirname(src), trashRoot);
    return { path: rel, action: "restored", source: "trash" };
  }
  const hdir = historyDir(vaultDir, rel);
  const snaps = existsSync(hdir) ? readdirSync(hdir).sort() : [];
  if (!snaps.length) throw new Error(`nada que restaurar (sin trash ni history) para "${rel}".`);
  const snap = args.timestamp ? snaps.find((f) => f.startsWith(args.timestamp!)) : snaps[snaps.length - 1];
  if (!snap) throw new Error(`no hay snapshot "${args.timestamp}" para "${rel}".`);
  snapshot(vaultDir, rel); // guarda el estado actual antes de revertir
  writeFileEnsured(abs, readFileSync(join(hdir, snap), "utf8"));
  return { path: rel, action: "restored", source: "history" };
}
