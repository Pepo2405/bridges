import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaults, defaultVaultDir, formatVaults } from "./config";

let dir: string;
let cfg: string;

function writeCfg(obj: unknown) {
  writeFileSync(cfg, JSON.stringify(obj), "utf8");
  process.env.BRIDGES_CONFIG = cfg;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridges-cfg-"));
  cfg = join(dir, "bridges.json");
});
afterEach(() => {
  delete process.env.BRIDGES_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe("readVaults", () => {
  test("mapea connections, marca el default y no expone token", () => {
    writeCfg({
      connections: [
        { vault: "/v/pxsol", name: "PxSol", serverUrl: "http://s", token: "SECRET", openedAt: "x" },
        { vault: "/v/otro", serverUrl: null, openedAt: "y" },
      ],
      lastVault: "/v/otro",
    });
    const vaults = readVaults();
    expect(vaults).toEqual([
      { name: "PxSol", path: "/v/pxsol", serverUrl: "http://s", isDefault: false },
      { name: "otro", path: "/v/otro", serverUrl: null, isDefault: true },
    ]);
    expect(JSON.stringify(vaults)).not.toContain("SECRET");
  });

  test("cae a [] si el config no existe o es JSON inválido", () => {
    process.env.BRIDGES_CONFIG = join(dir, "no-existe.json");
    expect(readVaults()).toEqual([]);
    writeFileSync(cfg, "{ no json", "utf8");
    process.env.BRIDGES_CONFIG = cfg;
    expect(readVaults()).toEqual([]);
  });
});

describe("defaultVaultDir", () => {
  test("usa lastVault", () => {
    writeCfg({ connections: [{ vault: "/v/a", openedAt: "x" }], lastVault: "/v/a" });
    expect(defaultVaultDir()).toBe("/v/a");
  });
  test("cae a la primera connection si no hay lastVault", () => {
    writeCfg({ connections: [{ vault: "/v/a", openedAt: "x" }] });
    expect(defaultVaultDir()).toBe("/v/a");
  });
  test("null si no hay vaults", () => {
    writeCfg({ connections: [] });
    expect(defaultVaultDir()).toBeNull();
  });
});

describe("formatVaults", () => {
  test("marca el default y lista la ruta", () => {
    const out = formatVaults([
      { name: "PxSol", path: "/v/pxsol", serverUrl: null, isDefault: false },
      { name: "otro", path: "/v/otro", serverUrl: null, isDefault: true },
    ]);
    expect(out).toContain("- PxSol\n  /v/pxsol");
    expect(out).toContain("- otro (default)\n  /v/otro");
  });
});
