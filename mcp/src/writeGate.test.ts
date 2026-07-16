/**
 * Test real del gate de write-tools (Fase 0): spawnea el server MCP como subproceso
 * real y habla el protocolo MCP (JSON-RPC 2.0 sobre stdio, newline-delimited) para
 * leer la lista de tools anunciada. Reemplaza el tautológico writeTools.test.ts
 * (que solo chequeaba `typeof isLocalMode() === "boolean"`): esto ejercita el gate
 * de verdad — si algún día se rompe (ej. alguien saca el `if` de index.ts), este
 * test lo detecta porque las tool-lists dejan de coincidir con lo esperado.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_DIR = join(import.meta.dir, "..");
const WRITE_TOOLS = ["create_note", "update_note", "delete_note", "restore_note", "list_history"];
const READ_TOOLS = ["search_vault", "read_note", "get_backlinks", "list_links", "list_vaults"];

/** Levanta el server MCP con el env dado y devuelve los nombres de tools anunciados
 *  vía initialize + tools/list. Mata el proceso al terminar (o a los 10s). */
async function listToolsWithEnv(env: Record<string, string | undefined>): Promise<string[]> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: MCP_DIR,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const writer = proc.stdin;
  const send = (msg: unknown) => writer.write(JSON.stringify(msg) + "\n");

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "writeGate.test", version: "0" } },
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const timeoutMs = 10_000;
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs}ms) esperando respuesta del MCP server`);
      const { done, value } = await reader.read();
      if (done) throw new Error("el server cerró stdout sin responder tools/list");
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; result?: any };
        if (msg.id === 1) {
          // initialize respondió: mandar el notification + tools/list
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        if (msg.id === 2) {
          const tools: string[] = (msg.result?.tools ?? []).map((t: { name: string }) => t.name);
          return tools;
        }
      }
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
}

describe("gate de write-tools (integración real vía protocolo MCP)", () => {
  let vaultDir: string;
  afterEach(() => {
    if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  });

  test(
    "LOCAL + write habilitado: write-tools y read-tools presentes",
    async () => {
      vaultDir = mkdtempSync(join(tmpdir(), "bridges-gate-"));
      const tools = await listToolsWithEnv({
        BRIDGES_VAULT_DIR: vaultDir,
        BRIDGES_URL: undefined,
        BRIDGES_MCP_READONLY: undefined,
        BRIDGES_LOCAL_SEARCH: undefined,
        BRIDGES_CONFIG: undefined,
      });
      for (const t of WRITE_TOOLS) expect(tools).toContain(t);
      for (const t of READ_TOOLS) expect(tools).toContain(t);
    },
    15_000,
  );

  test(
    "LOCAL + BRIDGES_MCP_READONLY=1: write-tools ausentes, read-tools presentes",
    async () => {
      vaultDir = mkdtempSync(join(tmpdir(), "bridges-gate-"));
      const tools = await listToolsWithEnv({
        BRIDGES_VAULT_DIR: vaultDir,
        BRIDGES_MCP_READONLY: "1",
        BRIDGES_LOCAL_SEARCH: undefined,
        BRIDGES_CONFIG: undefined,
      });
      for (const t of WRITE_TOOLS) expect(tools).not.toContain(t);
      for (const t of READ_TOOLS) expect(tools).toContain(t);
    },
    15_000,
  );

  test(
    "modo HTTP (sin vault local resoluble): write-tools ausentes",
    async () => {
      const tools = await listToolsWithEnv({
        BRIDGES_VAULT_DIR: undefined,
        BRIDGES_LOCAL_SEARCH: "0",
        BRIDGES_CONFIG: join(tmpdir(), "bridges-gate-no-existe.json"),
        BRIDGES_MCP_READONLY: undefined,
      });
      for (const t of WRITE_TOOLS) expect(tools).not.toContain(t);
      for (const t of READ_TOOLS) expect(tools).toContain(t);
    },
    15_000,
  );
});
