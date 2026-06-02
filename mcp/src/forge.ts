/** Búsqueda del vault: índice FTS local (si hay FORGE_VAULT_DIR) o HTTP al server. */
import { join } from "node:path";
import { searchLocal } from "./localIndex";

export type SearchHit = {
  id: string;
  path: string;
  title: string | null;
  snippet: string;
  /** Ruta absoluta en disco, si FORGE_VAULT_DIR está seteado. El agente la abre con Read. */
  localPath?: string;
};

const BASE = (process.env.FORGE_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.FORGE_TOKEN;
// Raíz del vault en disco. Si está, search_vault devuelve el path absoluto local
// para que el agente lea la nota del disco (con Read) en vez de traerla por HTTP.
const VAULT_DIR = process.env.FORGE_VAULT_DIR;
// Con FORGE_VAULT_DIR seteado, la búsqueda corre contra un índice FTS local
// (sub-ms, offline). Poné FORGE_LOCAL_SEARCH=0 para forzar siempre el camino HTTP.
const USE_LOCAL = !!VAULT_DIR && process.env.FORGE_LOCAL_SEARCH !== "0";

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

export async function searchVault(query: string, limit: number): Promise<SearchHit[]> {
  if (USE_LOCAL) {
    try {
      return searchLocal(VAULT_DIR!, query, limit);
    } catch (e) {
      // El índice local falló (dir inaccesible, etc.): caemos al server por HTTP.
      console.error(`[forge-mcp] índice local falló, usando HTTP: ${e instanceof Error ? e.message : e}`);
    }
  }
  return searchHttp(query, limit);
}
