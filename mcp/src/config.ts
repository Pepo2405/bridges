/** Lee la config de la app Bridges (bridges.json) para enumerar vaults y resolver
 *  el default. Módulo puro y read-only; nunca lanza y nunca expone tokens. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type VaultConn = {
  name: string;
  path: string;
  serverUrl: string | null;
  isDefault: boolean;
};

type RawConn = { vault?: string; name?: string; serverUrl?: string | null; token?: string; openedAt?: string };
type RawCfg = { connections?: RawConn[]; lastVault?: string };

/** Ruta del bridges.json. Prioridad: BRIDGES_CONFIG (test/override) → macOS → Linux.
 *  Identifier de la app Tauri: com.pepo.bridges (igual que vault-path.sh). */
export function configPath(): string | null {
  if (process.env.BRIDGES_CONFIG) return process.env.BRIDGES_CONFIG;
  const home = homedir();
  const candidates = [
    join(home, "Library", "Application Support", "com.pepo.bridges", "bridges.json"),
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "com.pepo.bridges", "bridges.json"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      // sigue probando
    }
  }
  return null;
}

function readCfg(): RawCfg | null {
  const p = configPath();
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawCfg;
  } catch {
    return null;
  }
}

export function readVaults(): VaultConn[] {
  const cfg = readCfg();
  if (!cfg?.connections) return [];
  return cfg.connections
    .filter((c): c is RawConn & { vault: string } => typeof c.vault === "string")
    .map((c) => ({
      name: c.name ?? basename(c.vault),
      path: c.vault,
      serverUrl: c.serverUrl ?? null,
      isDefault: c.vault === cfg.lastVault,
    }));
}

export function defaultVaultDir(): string | null {
  const cfg = readCfg();
  if (!cfg) return null;
  if (cfg.lastVault) return cfg.lastVault;
  return cfg.connections?.find((c) => c.vault)?.vault ?? null;
}

export function formatVaults(vaults: VaultConn[]): string {
  return vaults.map((v) => `- ${v.name}${v.isDefault ? " (default)" : ""}\n  ${v.path}`).join("\n");
}
