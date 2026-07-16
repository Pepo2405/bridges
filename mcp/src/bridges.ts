/** Acceso al vault: índice/disco local (si resolveVaultDir resuelve un vault) o HTTP al server. */
import { readFileSync } from "node:fs";
import { join, normalize, sep, basename } from "node:path";
import { deriveTitle } from "../../server/src/search-common";
import { searchLocal, walkMd } from "./localIndex";
import type { DocLite } from "./graph";
import { defaultVaultDir, readVaults } from "./config";

export type SearchHit = {
  /** Id del doc (solo modo HTTP; el modo local identifica por path). Opcional, no se expone al agente. */
  id?: string;
  path: string;
  title: string | null;
  snippet: string;
  /** Ruta absoluta en disco, si se resolvió un vault en disco (ver resolveVaultDir). El agente la abre con Read. */
  localPath?: string;
};

/** Contenido completo de una nota (lo que devuelve read_note). */
export type NoteContent = {
  path: string;
  title: string | null;
  content: string;
  /** Ruta absoluta en disco, si la nota se leyó del índice local. */
  localPath?: string;
};

/** Doc del vault (forma mínima que devuelve GET /sync). */
type SyncDoc = { id: string; path: string; title: string | null; content: string; deleted: number };

const BASE = (process.env.BRIDGES_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.BRIDGES_TOKEN;
export type BridgesMarker = { vault?: string; folder?: string };

/** Lee el marcador .bridges del repo consumidor. null si no existe o no parsea. */
export function readMarker(cwd: string = process.cwd()): BridgesMarker | null {
  try {
    return JSON.parse(readFileSync(join(cwd, ".bridges"), "utf8")) as BridgesMarker;
  } catch {
    return null;
  }
}

/** Resuelve el path en disco de un vault configurado por su name o el basename de su
 *  path. null si no está en bridges.json. */
export function resolveNamedVault(name: string): string | null {
  const hit = readVaults().find((v) => v.name === name || basename(v.path) === name);
  return hit ? hit.path : null;
}

/** Cascada: .bridges (por name o basename) → BRIDGES_VAULT_DIR → lastVault. null → HTTP. */
export function resolveVaultDir(cwd: string = process.cwd()): string | null {
  const marker = readMarker(cwd);
  if (marker?.vault) {
    const hit = resolveNamedVault(marker.vault);
    if (hit) return hit;
    console.error(`[bridges-mcp] .bridges nombra un vault desconocido: "${marker.vault}"; uso el default.`);
  }
  if (process.env.BRIDGES_VAULT_DIR) return process.env.BRIDGES_VAULT_DIR;
  return defaultVaultDir();
}

/** Dir efectivo para una consulta: el vault nombrado (si se pasó) o el resuelto al
 *  arrancar. Lanza si `vault` no corresponde a ningún vault configurado. */
function effectiveVaultDir(vault?: string): string | undefined {
  if (!vault) return VAULT_DIR;
  const dir = resolveNamedVault(vault);
  if (!dir) throw new Error(`vault desconocido: "${vault}". Usá list_vaults para ver los disponibles.`);
  return dir;
}

// Raíz del vault resuelta una vez al arrancar el proceso (cwd = repo consumidor).
const VAULT_DIR = resolveVaultDir() ?? undefined;
// Si se resolvió un vault en disco (el default de arranque o uno nombrado por consulta),
// la búsqueda corre contra un índice FTS local (sub-ms, offline). Poné
// BRIDGES_LOCAL_SEARCH=0 para forzar siempre el camino HTTP.
const LOCAL_ENABLED = process.env.BRIDGES_LOCAL_SEARCH !== "0";

async function searchHttp(query: string, limit: number): Promise<SearchHit[]> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(query)}`, { headers });
  if (!res.ok) throw new Error(`${BASE}/search → HTTP ${res.status}`);
  const data = (await res.json()) as { results?: SearchHit[] };
  return (data.results ?? []).slice(0, limit).map((h) => ({
    ...h,
    localPath: VAULT_DIR ? join(VAULT_DIR, h.path) : undefined,
  }));
}

export async function searchVault(
  query: string,
  limit: number,
  pathPrefix?: string,
  vault?: string,
): Promise<SearchHit[]> {
  const dir = effectiveVaultDir(vault);
  // Con filtro de path traemos el cap de resultados crudos (50) y recortamos a
  // `limit` después de filtrar; sin filtro, pedimos directamente `limit`.
  const fetchN = pathPrefix ? 50 : limit;
  let hits: SearchHit[];
  if (dir && LOCAL_ENABLED) {
    try {
      hits = searchLocal(dir, query, fetchN);
    } catch (e) {
      // El índice local falló (dir inaccesible, etc.): caemos al server por HTTP.
      // Con vault nombrado no hay fallback: el server HTTP es un solo vault (por token).
      if (vault) throw e;
      console.error(`[bridges-mcp] índice local falló, usando HTTP: ${e instanceof Error ? e.message : e}`);
      hits = await searchHttp(query, fetchN);
    }
  } else if (vault) {
    throw new Error(`no puedo buscar en el vault "${vault}" en modo HTTP: el server sirve un solo vault (por token).`);
  } else {
    hits = await searchHttp(query, fetchN);
  }
  if (pathPrefix) hits = hits.filter((h) => h.path.startsWith(pathPrefix));
  return hits.slice(0, limit);
}

/**
 * Resuelve un path relativo dentro de VAULT_DIR bloqueando traversal (../). Mismo
 * enfoque que server/src/vault.ts:resolveInVault. Lanza si el path escapa el vault.
 */
function resolveInVault(vaultDir: string, relPath: string): string {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = join(vaultDir, clean);
  const root = normalize(vaultDir + sep);
  if (!normalize(abs + sep).startsWith(root) && abs !== normalize(vaultDir)) {
    throw new Error(`el path escapa el vault: ${relPath}`);
  }
  return abs;
}

/** Trae todos los docs vivos del vault por HTTP (GET /sync?since=0). */
async function fetchSyncDocs(): Promise<SyncDoc[]> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/sync?since=0`, { headers });
  if (!res.ok) throw new Error(`${BASE}/sync → HTTP ${res.status}`);
  const data = (await res.json()) as { documents?: SyncDoc[] };
  return (data.documents ?? []).filter((d) => !d.deleted);
}

/** Lee una nota del disco local. null si no existe; lanza si el path escapa el vault. */
function readNoteLocal(vaultDir: string, path: string): NoteContent | null {
  const abs = resolveInVault(vaultDir, path);
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return null; // no existe o no se puede leer
  }
  return { path, title: deriveTitle(content, path), content, localPath: abs };
}

/** Lee una nota por HTTP filtrando /sync por path. null si no existe. */
async function readNoteHttp(path: string): Promise<NoteContent | null> {
  const doc = (await fetchSyncDocs()).find((d) => d.path === path);
  return doc ? { path: doc.path, title: doc.title, content: doc.content } : null;
}

/**
 * Lee el contenido completo de una nota por su path relativo. Modo local lee del
 * disco; modo HTTP la trae de /sync. `vault` opcional selecciona un vault nombrado.
 */
export async function readNote(path: string, vault?: string): Promise<NoteContent | null> {
  const dir = effectiveVaultDir(vault);
  if (dir && LOCAL_ENABLED) return readNoteLocal(dir, path);
  if (vault) throw new Error(`no puedo leer del vault "${vault}" en modo HTTP: el server sirve un solo vault (por token).`);
  return readNoteHttp(path);
}

/** Todos los docs vivos del vault (path/title/content). Para el grafo de wikilinks. */
function allDocsLocal(vaultDir: string): DocLite[] {
  return walkMd(vaultDir).map((rel) => {
    const content = readFileSync(join(vaultDir, rel), "utf8");
    return { path: rel, title: deriveTitle(content, rel), content };
  });
}

/**
 * Todos los docs vivos del vault. Modo local recorre el disco; modo HTTP usa
 * /sync. backlinks/links necesitan el vault completo (saber quién enlaza a quién).
 * `vault` opcional selecciona un vault nombrado.
 */
export async function allDocs(vault?: string): Promise<DocLite[]> {
  const dir = effectiveVaultDir(vault);
  if (dir && LOCAL_ENABLED) return allDocsLocal(dir);
  if (vault) throw new Error(`no puedo leer del vault "${vault}" en modo HTTP: el server sirve un solo vault (por token).`);
  return (await fetchSyncDocs()).map((d) => ({ path: d.path, title: d.title, content: d.content }));
}
