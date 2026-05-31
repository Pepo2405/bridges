/**
 * Motor de reconciliación offline-first.
 *
 * Este módulo es deliberadamente "tonto" respecto del store: solo maneja el
 * índice persistente (.forge/index.json), hashing y la clasificación pura de
 * cada doc (disco vs base vs remoto). La orquestación con efectos (escribir
 * disco, pushear al server) vive en store.ts, que tiene el estado y la api.
 *
 * El índice guarda, por doc, la BASE del 3-way merge (el último contenido
 * sincronizado = ancestro común). Se persiste con su contenido porque la app
 * puede estar cerrada mientras una app externa (ej. Claude Code) edita los .md,
 * y no hay otra forma de re-derivar el ancestro al reabrir.
 */

import { merge as diff3 } from "node-diff3";
import { indexLoad, indexSave } from "./tauri";
import type { Doc } from "./api";

export type IndexEntry = {
  id: string | null; // null = creado offline, sin id del server todavía
  base_version: number; // version del server del ancestro común
  base_content: string; // contenido del ancestro común (imprescindible para 3-way)
  synced_hash: string; // hash del contenido ya sincronizado (detección barata de dirty)
  dirty: boolean; // hay edición local sin pushear
  deleted: boolean; // borrado local pendiente de pushear
  updated_at: string; // último cambio local
};

export type ForgeIndex = { version: 1; docs: Record<string, IndexEntry> };

function emptyIndex(): ForgeIndex {
  return { version: 1, docs: {} };
}

// --- índice por vault (espejo de .forge/index.json), instanciable ---

/**
 * Maneja el índice de UN vault. Cada sesión de sync tiene su propio handle, así
 * varios vaults sincronizan en paralelo sin pisarse un singleton compartido.
 */
export type IndexHandle = {
  vault: string;
  load(): Promise<ForgeIndex>;
  getIndex(): ForgeIndex;
  getEntry(path: string): IndexEntry | undefined;
  setEntry(path: string, entry: IndexEntry): void;
  deleteEntry(path: string): void;
  /** Persiste el índice en disco (atómico en Rust). */
  persist(): Promise<void>;
  /** Entradas marcadas como dirty (la "cola" de cambios pendientes). */
  dirtyPaths(): string[];
  clear(): void;
};

export function createIndexHandle(vault: string): IndexHandle {
  let index: ForgeIndex = emptyIndex();
  return {
    vault,
    async load() {
      const raw = await indexLoad(vault);
      index = emptyIndex();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as ForgeIndex;
          if (parsed?.docs) index = { version: 1, docs: parsed.docs };
        } catch {
          /* índice corrupto: arrancamos vacío (degradación a 2-way manual por doc) */
        }
      }
      return index;
    },
    getIndex() {
      return index;
    },
    getEntry(path) {
      return index.docs[path];
    },
    setEntry(path, entry) {
      index.docs[path] = entry;
    },
    deleteEntry(path) {
      delete index.docs[path];
    },
    async persist() {
      await indexSave(vault, JSON.stringify(index));
    },
    dirtyPaths() {
      const docs = index.docs;
      return Object.keys(docs)
        .filter((p) => docs[p].dirty || docs[p].deleted)
        .sort((a, b) => (docs[a].updated_at < docs[b].updated_at ? -1 : 1));
    },
    clear() {
      index = emptyIndex();
    },
  };
}

// --- hashing ---

/** Hash estable del contenido, con prefijo de algoritmo. */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

// --- 3-way merge ---

/**
 * Merge automático a nivel de líneas (diff3). `local` y `remote` parten de
 * `base` (ancestro común). Si los cambios no se pisan, devuelve el resultado
 * mergeado sin conflicto; si se pisan, `conflict=true` y `result` lleva el
 * contenido con marcadores `<<<<<<< / ======= / >>>>>>>` para resolver a mano.
 */
export function threeWayMerge(
  local: string,
  base: string,
  remote: string,
): { conflict: boolean; result: string } {
  const r = diff3(local.split("\n"), base.split("\n"), remote.split("\n"));
  return { conflict: r.conflict, result: r.result.join("\n") };
}

// --- clasificación pura (disco vs base vs remoto), un doc a la vez ---

export type Decision =
  | "noop"
  | "pull" // solo remoto cambió → aplicar remoto a disco + actualizar base
  | "push" // solo local cambió → encolar push
  | "merge" // ambos cambiaron → 3-way merge
  | "create" // nuevo solo local → crear en server
  | "push-delete" // borrado local, remoto sin cambio → DELETE al server
  | "pull-delete" // borrado remoto, local sin cambio → borrar de disco + base
  | "delete-vs-edit" // borró local, editó remoto → gana la edición (restaurar)
  | "edit-vs-delete"; // editó local, borró remoto → re-crear

export type ClassifyInput = {
  onDisk: boolean;
  diskHash: string | null; // sha256 del contenido en disco (null si no está)
  remoteHash: string | null; // sha256 del contenido remoto (null si no está / borrado)
  base: IndexEntry | undefined;
  remote: Doc | undefined; // doc del server por path (puede venir con deleted=1)
};

/**
 * Decide qué hacer con un doc comparando los tres lados. Pura: sin efectos.
 * `remote` con `deleted` se trata como "no existe en remoto" pero recordando
 * que el server lo conoce (para distinguir borrado remoto de inexistencia).
 */
export function classify({ onDisk, diskHash, remoteHash, base, remote }: ClassifyInput): Decision {
  const remoteLive = remote && !remote.deleted ? remote : undefined;
  const remoteDeleted = !!remote?.deleted;

  // Sin base: el doc nunca se sincronizó desde este cliente.
  if (!base) {
    if (onDisk && remoteLive) {
      // Caso típico del primer connect a un vault ya sincronizado: el archivo
      // existe en disco y en el server. Si son idénticos, adoptamos el remoto
      // como base (pull); si difieren, no hay ancestro común → conflicto.
      return diskHash === remoteHash ? "pull" : "merge";
    }
    if (onDisk) return "create"; // nuevo local
    if (remoteLive) return "pull"; // nuevo remoto
    return "noop";
  }

  const localChanged = onDisk ? diskHash !== base.synced_hash : true; // !onDisk con base = borrado local
  const localDeleted = !onDisk;
  const remoteChanged = remoteLive ? remoteLive.version !== base.base_version : true;
  const remoteGone = !remoteLive; // borrado remoto o desaparecido

  if (!localChanged && !remoteChanged) return "noop";

  // Borrados.
  if (localDeleted && remoteGone) return "pull-delete"; // ambos borraron (o convergen al borrado)
  if (localDeleted && remoteLive) return remoteChanged ? "delete-vs-edit" : "push-delete";
  if (remoteDeleted && onDisk) return localChanged ? "edit-vs-delete" : "pull-delete";

  // Ediciones (ambos lados vivos).
  if (localChanged && remoteChanged) return "merge";
  if (localChanged) return "push";
  if (remoteChanged) return "pull";
  return "noop";
}
