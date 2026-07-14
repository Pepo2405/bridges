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

/** Cascada: .bridges (por name o basename) → BRIDGES_VAULT_DIR → lastVault. null → HTTP. */
export function resolveVaultDir(cwd: string = process.cwd()): string | null {
  const marker = readMarker(cwd);
  if (marker?.vault) {
    const hit = readVaults().find((v) => v.name === marker.vault || basename(v.path) === marker.vault);
    if (hit) return hit.path;
    console.error(`[bridges-mcp] .bridges nombra un vault desconocido: "${marker.vault}"; uso el default.`);
  }
  if (process.env.BRIDGES_VAULT_DIR) return process.env.BRIDGES_VAULT_DIR;
  return defaultVaultDir();
}

// Raíz del vault resuelta una vez al arrancar el proceso (cwd = repo consumidor).
const VAULT_DIR = resolveVaultDir() ?? undefined;
// Si se resolvió un vault en disco (ver resolveVaultDir), la búsqueda corre contra un
// índice FTS local (sub-ms, offline). Poné BRIDGES_LOCAL_SEARCH=0 para forzar siempre
// el camino HTTP.
const USE_LOCAL = !!VAULT_DIR && process.env.BRIDGES_LOCAL_SEARCH !== "0";

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

export async function searchVault(query: string, limit: number, pathPrefix?: string): Promise<SearchHit[]> {
  // Con filtro de path traemos el cap de resultados crudos (50) y recortamos a
  // `limit` después de filtrar; sin filtro, pedimos directamente `limit`.
  const fetchN = pathPrefix ? 50 : limit;
  let hits: SearchHit[];
  if (USE_LOCAL) {
    try {
      hits = searchLocal(VAULT_DIR!, query, fetchN);
    } catch (e) {
      // El índice local falló (dir inaccesible, etc.): caemos al server por HTTP.
      console.error(`[bridges-mcp] índice local falló, usando HTTP: ${e instanceof Error ? e.message : e}`);
      hits = await searchHttp(query, fetchN);
    }
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
 * disco; modo HTTP la trae de /sync. Mismo flag que la búsqueda (USE_LOCAL).
 */
export async function readNote(path: string): Promise<NoteContent | null> {
  if (USE_LOCAL) return readNoteLocal(VAULT_DIR!, path);
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
 */
export async function allDocs(): Promise<DocLite[]> {
  if (USE_LOCAL) return allDocsLocal(VAULT_DIR!);
  return (await fetchSyncDocs()).map((d) => ({ path: d.path, title: d.title, content: d.content }));
}
