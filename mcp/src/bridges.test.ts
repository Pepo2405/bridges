import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultDir, readMarker, resolveNamedVault, searchVault } from "./bridges";

let repo: string;   // cwd simulado del consumidor
let cfgDir: string; // dir del bridges.json

function writeConfig(obj: unknown) {
  const p = join(cfgDir, "bridges.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  process.env.BRIDGES_CONFIG = p;
}
function writeMarker(obj: unknown) {
  writeFileSync(join(repo, ".bridges"), JSON.stringify(obj), "utf8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bridges-repo-"));
  cfgDir = mkdtempSync(join(tmpdir(), "bridges-cfg-"));
  delete process.env.BRIDGES_VAULT_DIR;
});
afterEach(() => {
  delete process.env.BRIDGES_CONFIG;
  delete process.env.BRIDGES_VAULT_DIR;
  rmSync(repo, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("readMarker", () => {
  test("lee y parsea .bridges", () => {
    writeMarker({ vault: "PxSol", folder: "01 - Proyectos/x" });
    expect(readMarker(repo)).toEqual({ vault: "PxSol", folder: "01 - Proyectos/x" });
  });
  test("null si no existe o es inválido", () => {
    expect(readMarker(repo)).toBeNull();
    writeFileSync(join(repo, ".bridges"), "{ nope", "utf8");
    expect(readMarker(repo)).toBeNull();
  });
});

describe("resolveVaultDir cascada", () => {
  test("1) .bridges por name gana", () => {
    writeConfig({ connections: [{ vault: "/v/pxsol", name: "PxSol", openedAt: "x" }], lastVault: "/v/pxsol" });
    writeMarker({ vault: "PxSol" });
    expect(resolveVaultDir(repo)).toBe("/v/pxsol");
  });
  test("1b) .bridges matchea por basename del path", () => {
    writeConfig({ connections: [{ vault: "/vaults/equipo", openedAt: "x" }], lastVault: "/vaults/equipo" });
    writeMarker({ vault: "equipo" });
    expect(resolveVaultDir(repo)).toBe("/vaults/equipo");
  });
  test("2) .bridges con vault inexistente cae al default", () => {
    writeConfig({ connections: [{ vault: "/v/a", name: "A", openedAt: "x" }], lastVault: "/v/a" });
    writeMarker({ vault: "NoExiste" });
    expect(resolveVaultDir(repo)).toBe("/v/a");
  });
  test("3) BRIDGES_VAULT_DIR gana sobre el default cuando no hay .bridges", () => {
    writeConfig({ connections: [{ vault: "/v/a", openedAt: "x" }], lastVault: "/v/a" });
    process.env.BRIDGES_VAULT_DIR = "/env/dir";
    expect(resolveVaultDir(repo)).toBe("/env/dir");
  });
  test("4) sin .bridges ni env usa lastVault", () => {
    writeConfig({ connections: [{ vault: "/v/a", openedAt: "x" }], lastVault: "/v/a" });
    expect(resolveVaultDir(repo)).toBe("/v/a");
  });
  test("5) null si nada resuelve (fuerza HTTP)", () => {
    process.env.BRIDGES_CONFIG = join(cfgDir, "no.json");
    expect(resolveVaultDir(repo)).toBeNull();
  });
});

describe("resolveNamedVault", () => {
  test("resuelve por name", () => {
    writeConfig({ connections: [{ vault: "/v/px", name: "Px", openedAt: "x" }], lastVault: "/v/px" });
    expect(resolveNamedVault("Px")).toBe("/v/px");
  });
  test("resuelve por basename del path cuando no hay name", () => {
    writeConfig({ connections: [{ vault: "/vaults/equipo", openedAt: "x" }], lastVault: "/vaults/equipo" });
    expect(resolveNamedVault("equipo")).toBe("/vaults/equipo");
  });
  test("null si el vault no está configurado", () => {
    writeConfig({ connections: [{ vault: "/v/a", name: "A", openedAt: "x" }], lastVault: "/v/a" });
    expect(resolveNamedVault("NoExiste")).toBeNull();
  });
});

describe("searchVault con vault por nombre", () => {
  test("rechaza con vault desconocido (no toca disco)", async () => {
    writeConfig({ connections: [{ vault: "/v/a", name: "A", openedAt: "x" }], lastVault: "/v/a" });
    await expect(searchVault("hola", 5, undefined, "NoExiste")).rejects.toThrow(/vault desconocido/i);
  });

  test("pathPrefix en modo local filtra por prefijo", async () => {
    writeConfig({ connections: [{ vault: repo, name: "A", openedAt: "x" }], lastVault: repo });
    writeFileSync(join(repo, "a.md"), "# oracle\nalpha", "utf8");
    mkdirSync(join(repo, "01 - Proyectos"), { recursive: true });
    writeFileSync(join(repo, "01 - Proyectos/b.md"), "# other\noracle beta", "utf8");

    const hits = await searchVault("oracle", 10, "01 - Proyectos/", "A");
    expect(hits.map((h) => h.path)).toEqual(["01 - Proyectos/b.md"]);
  });
});
