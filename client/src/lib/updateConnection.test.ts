import { describe, it, expect, beforeEach } from "vitest";
import { state, updateConnection } from "~/lib/store";
import { configLoad, configSave, secretGet, secretSet } from "~/lib/tauri";

// updateConnection corre en modo browser (isTauri=false en el entorno "node" de
// Vitest): el token vive en memSecrets y la config en localStorage. Polyfill de
// localStorage porque el entorno node no tiene DOM. Cada test usa un vault único
// (memSecrets es module-scoped y no se resetea entre tests).
beforeEach(() => {
  const store = new Map<string, string>();
  const mem: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  globalThis.localStorage = mem;
});

const seed = async (c: { vault: string; serverUrl: string | null; token?: string; name?: string }) => {
  await configSave({ connections: [{ ...c, openedAt: "2026-01-01T00:00:00.000Z" }], lastVault: c.vault });
  if (c.serverUrl !== null && c.token) await secretSet(c.vault, c.token);
};

describe("updateConnection", () => {
  it("cambia solo el nombre: persiste name, no toca el token", async () => {
    const vault = "/v-name";
    await seed({ vault, serverUrl: "http://s", token: "tok" });
    await updateConnection(vault, { name: "Mi vault" });
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.name).toBe("Mi vault");
    expect(await secretGet(vault)).toBe("tok");
    expect(state.connections.find((c) => c.vault === vault)?.name).toBe("Mi vault");
  });

  it("cambia el token: lo persiste al keychain y (en browser) a la config", async () => {
    const vault = "/v-token";
    await seed({ vault, serverUrl: "http://s", token: "old" });
    await updateConnection(vault, { token: "new" });
    expect(await secretGet(vault)).toBe("new");
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.token).toBe("new");
  });

  it("cambia el serverUrl normalizando la barra final", async () => {
    const vault = "/v-url";
    await seed({ vault, serverUrl: "http://old", token: "t" });
    await updateConnection(vault, { serverUrl: "http://new/" });
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.serverUrl).toBe("http://new");
  });

  it("nombre en blanco borra el nombre custom", async () => {
    const vault = "/v-clear";
    await seed({ vault, serverUrl: "http://s", token: "t", name: "Viejo" });
    await updateConnection(vault, { name: "  " });
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.name).toBeUndefined();
  });

  it("vault inexistente: no-op", async () => {
    await updateConnection("/nope", { name: "x" });
    const cfg = await configLoad();
    expect(cfg.connections).toHaveLength(0);
  });
});
