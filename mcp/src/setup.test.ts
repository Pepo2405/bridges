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

describe("setup hermes", () => {
  const yamlCon = "model:\n  default: x\nmcp_servers:\n  nexus:\n    url: u\n  bridges:\n    command: bun\nplugins:\n  enabled:\n    - camofox\n  disabled: []\n";

  test("escribe manifest + plugin y lo habilita; MCP presente → sin avisos", () => {
    const { config, plugin } = agentPaths("hermes", home, env);
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, yamlCon);
    const enabled: string[] = [];
    const r = setupAgent("hermes", { cmd: CMD, home, env, enableHermesPlugin: (n) => (enabled.push(n), true) });
    expect(plugin).toBe(join(home, ".hermes/plugins/bridges-memoria/__init__.py"));
    expect(readFileSync(plugin, "utf8")).toContain(`CMD: List[str] = ${JSON.stringify(CMD)}`);
    expect(readFileSync(join(home, ".hermes/plugins/bridges-memoria/plugin.yaml"), "utf8")).toContain("transform_tool_result");
    expect(enabled).toEqual(["bridges-memoria"]);
    expect(r.notes).toEqual([]);
    expect(readFileSync(config, "utf8")).toBe(yamlCon); // nunca edita el config.yaml
  });

  test("ya habilitado y sin cambios: idempotente", () => {
    const { config } = agentPaths("hermes", home, env);
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, yamlCon.replace("    - camofox\n", "    - camofox\n    - bridges-memoria\n"));
    setupAgent("hermes", { cmd: CMD, home, env, enableHermesPlugin: () => true });
    let called = false;
    const r = setupAgent("hermes", { cmd: CMD, home, env, enableHermesPlugin: () => (called = true) });
    expect(r.changes).toEqual([]);
    expect(called).toBe(false);
  });

  test("sin MCP bridges y enable fallido → avisos con el comando a correr", () => {
    const { config } = agentPaths("hermes", home, env);
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, "mcp_servers:\n  nexus:\n    url: u\n");
    const r = setupAgent("hermes", { cmd: CMD, home, env, enableHermesPlugin: () => false });
    expect(r.notes.join("\n")).toContain("hermes plugins enable bridges-memoria");
    expect(r.notes.join("\n")).toContain("hermes mcp add bridges --command /usr/bin/bun --args run /x/mcp/src/index.ts");
  });

  test("HERMES_HOME (perfiles)", () => {
    expect(agentPaths("hermes", home, { HERMES_HOME: "/h/profiles/x" } as any).plugin)
      .toBe("/h/profiles/x/plugins/bridges-memoria/__init__.py");
  });

  test("el plugin generado funciona (tests de Python con el intérprete de Hermes)", () => {
    const fake = join(home, "fake-hook.ts");
    writeFileSync(fake, `
      const data = JSON.parse(await Bun.stdin.text());
      if (process.argv[2] !== "hook") process.exit(0);
      const name = data.cwd.split("/").pop();
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX:" + data.source + ":" + name } }));
    `);
    for (const [repo, marker] of [
      ["gym-admin", { vault: "Gym-Admin", folder: "" }],
      ["pxsol/pxsol-blanco", { vault: "Px", folder: "01 - Proyectos/pxsol-blanco" }],
      ["goblin", { vault: "Goblin", folder: "" }],
      ["forge", { vault: "Bridges", folder: "" }],
      ["bulon", { vault: "Personal", folder: "01 - Proyectos/Bulón" }],
    ] as const) {
      mkdirSync(join(home, "code", repo, "src"), { recursive: true });
      writeFileSync(join(home, "code", repo, ".bridges"), JSON.stringify(marker));
    }
    mkdirSync(join(home, "code", "sin-bridges"), { recursive: true });
    const file = join(home, "plugin_under_test.py");
    writeFileSync(file, renderIntegration("hermes", [process.execPath, fake]));
    const py = [join(process.env.HOME ?? "", ".hermes/hermes-agent/venv/bin/python"), "python3"].find((p) =>
      p === "python3" || existsSync(p))!;
    const r = Bun.spawnSync([py, join(import.meta.dir, "integrations/hermes_plugin_test.py")], {
      // HERMES_HOME explícito: si no, la telemetría del test iría al log real de Hermes.
      env: { ...process.env, HOME: home, HERMES_HOME: join(home, ".hermes-test"), PLUGIN_FILE: file },
      stderr: "pipe", stdout: "pipe",
    });
    const out = r.stderr.toString() + r.stdout.toString();
    if (r.exitCode !== 0) console.error(out);
    expect(r.exitCode).toBe(0);
    expect(out).toMatch(/Ran 15 tests/);
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
