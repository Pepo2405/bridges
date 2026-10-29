import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAgent, agentPaths, parseCommand, renderIntegration } from "./setup";

let home: string;
const env = {} as NodeJS.ProcessEnv;
const CMD = ["/usr/bin/bun", "run", "/x/mcp/src/index.ts"];
const NOW = new Date("2026-10-29T12:00:00Z");

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "bridges-setup-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const writeJson = (p: string, o: unknown) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 });
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("setup opencode", () => {
  test("actualiza bridges conservando env y el resto; instala el plugin; backup", () => {
    const { config, plugin } = agentPaths("opencode", home, env);
    writeJson(config, {
      $schema: "x",
      mcp: {
        otro: { type: "remote", url: "u", enabled: true },
        bridges: { type: "local", command: ["bun", "run", "/viejo.ts"], environment: { BRIDGES_TOKEN: "t" }, enabled: true },
      },
      plugins: ["p"],
    });
    const r = setupAgent("opencode", { cmd: CMD, home, env, now: NOW });
    const cfg = readJson(config);
    expect(cfg.mcp.bridges).toEqual({ type: "local", command: CMD, environment: { BRIDGES_TOKEN: "t" }, enabled: true });
    expect(cfg.mcp.otro).toEqual({ type: "remote", url: "u", enabled: true });
    expect(cfg.plugins).toEqual(["p"]);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(plugin, "utf8")).toContain(JSON.stringify(CMD));
    expect(r.changes.length).toBe(2);
  });

  test("idempotente: la segunda corrida no cambia nada ni hace otro backup", () => {
    setupAgent("opencode", { cmd: CMD, home, env, now: NOW });
    const r = setupAgent("opencode", { cmd: CMD, home, env, now: new Date("2026-10-30T00:00:00Z") });
    expect(r.changes).toEqual([]);
    expect(r.backup).toBeUndefined();
  });

  test("sin config previa la crea", () => {
    const r = setupAgent("opencode", { cmd: CMD, home, env });
    expect(readJson(r.config).mcp.bridges.command).toEqual(CMD);
  });

  test("respeta XDG_CONFIG_HOME", () => {
    expect(agentPaths("opencode", home, { XDG_CONFIG_HOME: "/xdg" } as any).config).toBe("/xdg/opencode/opencode.json");
  });

  test("config que no es JSON: falla sin tocarla", () => {
    const { config, plugin } = agentPaths("opencode", home, env);
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, "{ // jsonc\n }");
    expect(() => setupAgent("opencode", { cmd: CMD, home, env })).toThrow(/parsear/);
    expect(readFileSync(config, "utf8")).toBe("{ // jsonc\n }");
    expect(existsSync(plugin)).toBe(false);
  });

  test("dry-run no escribe nada", () => {
    const r = setupAgent("opencode", { cmd: CMD, home, env, dryRun: true });
    expect(r.changes.length).toBe(2);
    expect(existsSync(r.config)).toBe(false);
    expect(existsSync(r.plugin)).toBe(false);
  });
});

describe("setup omp", () => {
  test("command + args, conserva env y los otros servidores", () => {
    const { config, plugin } = agentPaths("omp", home, env);
    writeJson(config, { $schema: "s", mcpServers: { x: { type: "http", url: "u" }, bridges: { type: "stdio", command: "/viejo/launch.sh", env: { A: "1" } } } });
    setupAgent("omp", { cmd: CMD, home, env, now: NOW });
    const cfg = readJson(config);
    expect(cfg.mcpServers.bridges).toEqual({ type: "stdio", command: CMD[0], args: CMD.slice(1), env: { A: "1" } });
    expect(cfg.mcpServers.x).toEqual({ type: "http", url: "u" });
    expect(cfg.$schema).toBe("s");
    expect(plugin.endsWith(".omp/agent/extensions/bridges-memoria.ts")).toBe(true);
    expect(existsSync(plugin)).toBe(true);
  });

  test("binario solo: sin args", () => {
    const r = setupAgent("omp", { cmd: ["/bin/bridges-mcp"], home, env });
    expect(readJson(r.config).mcpServers.bridges).toEqual({ type: "stdio", command: "/bin/bridges-mcp" });
  });
});

test("parseCommand: JSON o texto", () => {
  expect(parseCommand('["bun","run","/a b/index.ts"]')).toEqual(["bun", "run", "/a b/index.ts"]);
  expect(parseCommand("bun run /x.ts")).toEqual(["bun", "run", "/x.ts"]);
  expect(() => parseCommand("[]")).toThrow();
});

// ── Los plugins generados, ejercitados con un comando falso ─────────────────

describe("plugins generados", () => {
  let fakeCmd: string[];
  beforeEach(() => {
    const fake = join(home, "fake-hook.ts");
    // Imita `bridges-mcp hook session-start`: sin .bridges (cwd con "nobridges") no imprime nada.
    writeFileSync(fake, `
      const data = JSON.parse(await Bun.stdin.text());
      if (process.argv[2] !== "hook" || data.cwd.includes("nobridges")) process.exit(0);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX:" + data.source } }));
    `);
    fakeCmd = [process.execPath, fake];
  });

  test("opencode: inyecta, pide Bitácora al compactar hasta log_session, saltea subagentes", async () => {
    const file = join(home, "oc-plugin.js");
    writeFileSync(file, renderIntegration("opencode", fakeCmd));
    const { BridgesMemoria } = await import(file);
    const hooks = await BridgesMemoria({ directory: home });

    const sys = async (sessionID: string) => {
      const out = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID }, out);
      return out.system;
    };
    expect(await sys("s1")).toEqual(["base\n\nCTX:startup"]);

    const comp = { context: [] as string[] };
    await hooks["experimental.session.compacting"]({ sessionID: "s1" }, comp);
    expect(comp.context[0]).toContain("log_session");
    expect(await sys("s1")).toEqual(["base\n\nCTX:compact"]);

    await hooks["tool.execute.after"]({ tool: "bridges_log_session", sessionID: "s1" });
    expect(await sys("s1")).toEqual(["base\n\nCTX:startup"]);

    await hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "s1" } } } });
    expect(await sys("child")).toEqual(["base"]);
  });

  test("opencode: repo sin .bridges no toca el prompt ni la compactación", async () => {
    const dir = join(home, "nobridges");
    mkdirSync(dir);
    const file = join(home, "oc-plugin2.js");
    writeFileSync(file, renderIntegration("opencode", fakeCmd));
    const hooks = await (await import(file)).BridgesMemoria({ directory: dir });
    const out = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
    expect(out.system).toEqual(["base"]);
    const comp = { context: [] as string[] };
    await hooks["experimental.session.compacting"]({ sessionID: "s" }, comp);
    expect(comp.context).toEqual([]);
  });

  test("opencode: comando inexistente → silencio, no rompe", async () => {
    const file = join(home, "oc-plugin3.js");
    writeFileSync(file, renderIntegration("opencode", ["/no/existe/bridges"]));
    const hooks = await (await import(file)).BridgesMemoria({ directory: home });
    const out = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
    expect(out.system).toEqual(["base"]);
  });

  test("omp: before_agent_start agrega al systemPrompt; compacting y log_session", async () => {
    const file = join(home, "omp-ext.ts");
    writeFileSync(file, renderIntegration("omp", fakeCmd));
    const handlers: Record<string, Function> = {};
    (await import(file)).default({ on: (ev: string, fn: Function) => { handlers[ev] = fn; } });
    const ctx = { cwd: home, sessionManager: { getSessionId: () => "s1" } };

    expect(await handlers["before_agent_start"]({ systemPrompt: ["a"] }, ctx)).toEqual({ systemPrompt: ["a", "CTX:startup"] });
    const c = await handlers["session.compacting"]({ sessionId: "s1" }, ctx);
    expect(c.context[0]).toContain("log_session");
    expect(await handlers["before_agent_start"]({ systemPrompt: ["a"] }, ctx)).toEqual({ systemPrompt: ["a", "CTX:compact"] });
    await handlers["tool_execution_end"]({ toolName: "bridges_log_session" }, ctx);
    expect(await handlers["before_agent_start"]({ systemPrompt: ["a"] }, ctx)).toEqual({ systemPrompt: ["a", "CTX:startup"] });

    const none = { cwd: join(home, "nobridges"), sessionManager: { getSessionId: () => "s2" } };
    mkdirSync(none.cwd);
    expect(await handlers["before_agent_start"]({ systemPrompt: ["a"] }, none)).toBeUndefined();
  });
});
