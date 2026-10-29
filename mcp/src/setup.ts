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
import hermesTmpl from "./integrations/hermes.py.tmpl" with { type: "text" };

export const AGENTS = ["opencode", "omp", "hermes"] as const;

const HERMES_PLUGIN = "bridges-memoria";
const HERMES_MANIFEST = `name: ${HERMES_PLUGIN}
version: "1.0.0"
description: "Memoria de Bridges: inyecta el contexto del proyecto (Decisiones + Bitácora) cuando la sesión toca o nombra un repo con .bridges, y pide la Bitácora después de compactar."
author: "Bridges (bridges-mcp setup hermes)"
provides_hooks:
  - pre_llm_call
  - transform_tool_result
`;
export type AgentId = (typeof AGENTS)[number];

export type SetupPaths = { config: string; plugin: string };

export function agentPaths(agent: AgentId, home = homedir(), env: NodeJS.ProcessEnv = process.env): SetupPaths {
  if (agent === "opencode") {
    const base = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(home, ".config", "opencode");
    return { config: join(base, "opencode.json"), plugin: join(base, "plugins", "bridges-memoria.js") };
  }
  if (agent === "hermes") {
    const base = env.HERMES_HOME || join(home, ".hermes");
    return { config: join(base, "config.yaml"), plugin: join(base, "plugins", HERMES_PLUGIN, "__init__.py") };
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
  const tmpl = agent === "opencode" ? opencodeTmpl : agent === "omp" ? ompTmpl : hermesTmpl;
  return tmpl.replace("__BRIDGES_CMD__", JSON.stringify(cmd));
}

/** Escribe `abs` solo si cambió. Devuelve true si escribió (o escribiría, en dry-run). */
function writeIfChanged(abs: string, content: string, dryRun?: boolean): boolean {
  if (existsSync(abs) && readFileSync(abs, "utf8") === content) return false;
  if (!dryRun) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return true;
}

/** ¿El config.yaml de Hermes tiene una entrada `bridges` bajo `mcp_servers`? (chequeo textual, sin parser YAML) */
function hermesHasBridgesMcp(yaml: string): boolean {
  const m = yaml.match(/^mcp_servers:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m);
  return !!m && /^[ \t]+bridges:\s*$/m.test(m[1]);
}

/** ¿El plugin figura en `plugins.enabled`? */
function hermesPluginEnabled(yaml: string): boolean {
  const m = yaml.match(/^plugins:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!m) return false;
  const enabled = m[1].match(/^[ \t]+enabled:\s*\n((?:[ \t]+-.*\n?)*)/m);
  return !!enabled && new RegExp(`^[ \\t]+-\\s*${HERMES_PLUGIN}\\s*$`, "m").test(enabled[1]);
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

export type SetupResult = {
  agent: AgentId; config: string; plugin: string; changes: string[]; backup?: string;
  /** Avisos que requieren acción manual (no son cambios aplicados). */
  notes: string[];
};

export function setupAgent(
  agent: AgentId,
  opts: {
    cmd: string[]; home?: string; env?: NodeJS.ProcessEnv; dryRun?: boolean; now?: Date;
    /** Hermes: cómo habilitar el plugin (default: `hermes plugins enable`). Devuelve true si salió bien. */
    enableHermesPlugin?: (name: string) => boolean;
  },
): SetupResult {
  if (!AGENTS.includes(agent)) throw new Error(`agente no soportado: "${agent}". Opciones: ${AGENTS.join(", ")}.`);
  const paths = agentPaths(agent, opts.home, opts.env);
  if (agent === "hermes") return setupHermes(paths, opts);
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
  return { agent, config: paths.config, plugin: paths.plugin, changes, backup, notes: [] };
}

/**
 * Hermes: instala el plugin (manifest + __init__.py) y lo habilita con la CLI de Hermes.
 * El config.yaml no se edita a mano (Hermes lo protege y lo reescribe): solo se lee para
 * avisar si falta el MCP o si el plugin no quedó habilitado.
 */
function setupHermes(
  paths: SetupPaths,
  opts: { cmd: string[]; dryRun?: boolean; enableHermesPlugin?: (name: string) => boolean },
): SetupResult {
  const changes: string[] = [];
  const notes: string[] = [];
  const dir = dirname(paths.plugin);
  if (writeIfChanged(join(dir, "plugin.yaml"), HERMES_MANIFEST, opts.dryRun)) changes.push(`escrito ${join(dir, "plugin.yaml")}`);
  if (writeIfChanged(paths.plugin, renderIntegration("hermes", opts.cmd), opts.dryRun)) changes.push(`escrito ${paths.plugin}`);

  const yaml = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  if (!hermesPluginEnabled(yaml)) {
    if (opts.dryRun) {
      changes.push(`habilitaría el plugin con \`hermes plugins enable ${HERMES_PLUGIN}\``);
    } else {
      const enable = opts.enableHermesPlugin ?? ((name: string) =>
        Bun.spawnSync(["hermes", "plugins", "enable", name], { stdout: "ignore", stderr: "ignore" }).exitCode === 0);
      if (enable(HERMES_PLUGIN)) changes.push(`habilitado el plugin ${HERMES_PLUGIN} (hermes plugins enable)`);
      else notes.push(`no pude habilitar el plugin: corré \`hermes plugins enable ${HERMES_PLUGIN}\`.`);
    }
  }
  if (!hermesHasBridgesMcp(yaml)) {
    notes.push(
      `no encontré el MCP "bridges" en ${paths.config}: agregalo con ` +
        `\`hermes mcp add bridges --command ${opts.cmd[0]}${opts.cmd.length > 1 ? ` --args ${opts.cmd.slice(1).join(" ")}` : ""}\`.`,
    );
  }
  return { agent: "hermes", config: paths.config, plugin: paths.plugin, changes, notes };
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
    for (const n of r.notes) console.log(`  ⚠️ ${n}`);
    if (r.changes.length && !dryRun) console.log(`  Reiniciá ${agent} para que tome los cambios.`);
    return 0;
  } catch (e) {
    console.error(`bridges setup: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
