import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./hook";
import { saveDecision } from "./memory";

let root: string;
let vaultDir: string;
let repo: string;
let prevCfg: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridges-hook-"));
  vaultDir = join(root, "V");
  repo = join(root, "repo");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, "cfg.json"), JSON.stringify({ connections: [{ vault: vaultDir, name: "V" }] }));
  prevCfg = process.env.BRIDGES_CONFIG;
  process.env.BRIDGES_CONFIG = join(root, "cfg.json");
});
afterEach(() => {
  if (prevCfg === undefined) delete process.env.BRIDGES_CONFIG;
  else process.env.BRIDGES_CONFIG = prevCfg;
  rmSync(root, { recursive: true, force: true });
});

test("session-start en un repo con .bridges devuelve additionalContext", () => {
  writeFileSync(join(repo, ".bridges"), JSON.stringify({ vault: "V", folder: "" }));
  saveDecision({ vault: "V", dir: vaultDir, folder: "" }, { topic: "Cron", que: "q", porque: "p" });
  const out = JSON.parse(runHook("session-start", JSON.stringify({ cwd: repo, source: "startup" })));
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("- Cron (decision)");
  expect(out.hookSpecificOutput.additionalContext).not.toContain("compactar");
});

test("source=compact agrega el pedido de Bitácora", () => {
  writeFileSync(join(repo, ".bridges"), JSON.stringify({ vault: "V", folder: "" }));
  const out = JSON.parse(runHook("session-start", JSON.stringify({ cwd: repo, source: "compact" })));
  expect(out.hookSpecificOutput.additionalContext).toContain("log_session");
  expect(out.hookSpecificOutput.additionalContext).toContain("compactar");
});

test("sin .bridges, JSON roto o evento desconocido: silencio", () => {
  expect(runHook("session-start", JSON.stringify({ cwd: repo }))).toBe("");
  expect(runHook("session-start", "{no json")).toBe("");
  expect(runHook("otro", "{}")).toBe("");
});
