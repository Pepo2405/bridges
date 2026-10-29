/**
 * `bridges-mcp setup <opencode|omp>`: conecta otro agente a la memoria de Bridges, al
 * estilo de `engram setup`. Hace dos cosas, idempotentes:
 *  1. Upsert de la entrada `bridges` del MCP en la config del agente, sin tocar las demás
 *     entradas ni el `environment`/`env` que ya tenga (backup antes de escribir).
 *  2. Instala el plugin/extensión que inyecta el contexto del proyecto al empezar y pide
 *     la Bitácora al compactar (src/integrations/*.tmpl), con el comando del MCP adentro.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import opencodeTmpl from "./integrations/opencode.js.tmpl" with { type: "text" };
import ompTmpl from "./integrations/omp.ts.tmpl" with { type: "text" };

export const AGENTS = ["opencode", "omp"] as const;
export type AgentId = (typeof AGENTS)[number];

export type SetupPaths = { config: string; plugin: string };

export function agentPaths(agent: AgentId, home = homedir(), env: NodeJS.ProcessEnv = process.env): SetupPaths {
  if (agent === "opencode") {
    const base = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(home, ".config", "opencode");
    return { config: join(base, "opencode.json"), plugin: join(base, "plugins", "bridges-memoria.js") };
  }
  const base = join(home, ".omp", "agent");
  return { config: join(base, "mcp.json"), plugin: join(base, "extensions", "bridges-memoria.ts") };
}

/**
 * Comando con el que se está corriendo este MCP: `bun run <index.ts>` desde la fuente,
 * o el binario compilado. Ojo: el binario del plugin de Claude vive en una carpeta con
 * la versión en la ruta; para algo estable conviene correr setup desde la fuente o
 * pasar `--command`.
 */
export function defaultCommand(): string[] {
  const script = process.argv[1];
  if (script && script.endsWith(".ts") && existsSync(script)) return [process.execPath, "run", resolve(script)];
  return [process.execPath];
}

/** Parsea `--command`: un array JSON (`["bun","run","/x/index.ts"]`) o texto separado por espacios. */
export function parseCommand(raw: string): string[] {
  const t = raw.trim();
  const cmd = t.startsWith("[") ? (JSON.parse(t) as unknown) : t.split(/\s+/);
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((s) => typeof s === "string" && s)) {
    throw new Error(`--command inválido: ${raw}`);
  }
  return cmd as string[];
}

export function renderIntegration(agent: AgentId, cmd: string[]): string {
  return (agent === "opencode" ? opencodeTmpl : ompTmpl).replace("__BRIDGES_CMD__", JSON.stringify(cmd));
}

type Json = Record<string, any>;

function upsertMcp(agent: AgentId, cfg: Json, cmd: string[]): void {
  if (agent === "opencode") {
    cfg.mcp ??= {};
    const prev: Json = cfg.mcp.bridges ?? {};
    cfg.mcp.bridges = { ...prev, type: "local", command: cmd, enabled: prev.enabled ?? true };
  } else {
    cfg.mcpServers ??= {};
    const prev: Json = cfg.mcpServers.bridges ?? {};
    const next: Json = { ...prev, type: "stdio", command: cmd[0], args: cmd.slice(1) };
    if (!next.args.length) delete next.args;
    cfg.mcpServers.bridges = next;
  }
}

export type SetupResult = { agent: AgentId; config: string; plugin: string; changes: string[]; backup?: string };

export function setupAgent(
  agent: AgentId,
  opts: { cmd: string[]; home?: string; env?: NodeJS.ProcessEnv; dryRun?: boolean; now?: Date },
): SetupResult {
  if (!AGENTS.includes(agent)) throw new Error(`agente no soportado: "${agent}". Opciones: ${AGENTS.join(", ")}.`);
  const paths = agentPaths(agent, opts.home, opts.env);
  const changes: string[] = [];
  let backup: string | undefined;

  // 1) Config del MCP
  const exists = existsSync(paths.config);
  const before = exists ? readFileSync(paths.config, "utf8") : "";
  let cfg: Json;
  try {
    cfg = exists && before.trim() ? (JSON.parse(before) as Json) : {};
  } catch {
    throw new Error(`no pude parsear ${paths.config} como JSON (¿tiene comentarios?). Agregá la entrada a mano.`);
  }
  upsertMcp(agent, cfg, opts.cmd);
  const after = JSON.stringify(cfg, null, 2) + "\n";
  if (JSON.stringify(JSON.parse(after)) !== JSON.stringify(exists && before.trim() ? JSON.parse(before) : null)) {
    changes.push(`${exists ? "actualizada" : "creada"} la entrada "bridges" del MCP en ${paths.config}`);
    if (!opts.dryRun) {
      mkdirSync(dirname(paths.config), { recursive: true });
      if (exists) {
        const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
        backup = `${paths.config}.bak-bridges-${stamp}`;
        copyFileSync(paths.config, backup);
        chmodSync(backup, 0o600); // la config puede tener tokens
      }
      writeFileSync(paths.config, after, "utf8");
    }
  }

  // 2) Plugin / extensión
  const code = renderIntegration(agent, opts.cmd);
  const prevCode = existsSync(paths.plugin) ? readFileSync(paths.plugin, "utf8") : null;
  if (prevCode !== code) {
    changes.push(`${prevCode === null ? "instalado" : "actualizado"} ${paths.plugin}`);
    if (!opts.dryRun) {
      mkdirSync(dirname(paths.plugin), { recursive: true });
      writeFileSync(paths.plugin, code, "utf8");
    }
  }
  return { agent, config: paths.config, plugin: paths.plugin, changes, backup };
}

/** Entrada CLI: `setup <agente> [--command <cmd>] [--dry-run]`. Devuelve el código de salida. */
export function runSetupCli(args: string[]): number {
  const agent = args[0] as AgentId;
  const dryRun = args.includes("--dry-run");
  const ci = args.indexOf("--command");
  try {
    if (!agent || !AGENTS.includes(agent)) {
      console.error(`uso: bridges-mcp setup <${AGENTS.join("|")}> [--command '<cmd>'] [--dry-run]`);
      return 2;
    }
    const cmd = ci >= 0 ? parseCommand(args[ci + 1] ?? "") : defaultCommand();
    const r = setupAgent(agent, { cmd, dryRun });
    console.log(`bridges setup ${agent}${dryRun ? " (dry-run)" : ""} — comando del MCP: ${JSON.stringify(cmd)}`);
    if (!r.changes.length) console.log("  sin cambios: ya estaba configurado.");
    for (const c of r.changes) console.log(`  - ${c}`);
    if (r.backup) console.log(`  backup: ${r.backup}`);
    if (r.changes.length && !dryRun) console.log(`  Reiniciá ${agent} para que tome los cambios.`);
    return 0;
  } catch (e) {
    console.error(`bridges setup: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
