import { describe, it, expect } from "vitest";
import { classify, threeWayMerge, sha256, type IndexEntry, type ClassifyInput } from "~/lib/reconcile";
import type { Doc } from "~/lib/api";

// Tests de caracterización del motor de sync puro. Pinean la tabla de decisión
// de classify() tal cual está hoy: si alguno falla, o la tabla cambió o hay un
// bug en reconcile.ts (no se "arregla" acá, se reporta).

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: "id1",
  path: "a.md",
  title: null,
  content: "c",
  version: 1,
  seq: 1,
  deleted: 0,
  updated_by: null,
  updated_at: "",
  ...over,
});

const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  id: "id1",
  base_version: 1,
  base_content: "base",
  synced_hash: "sha256:base",
  dirty: false,
  deleted: false,
  updated_at: "",
  ...over,
});

const input = (over: Partial<ClassifyInput>): ClassifyInput => ({
  onDisk: true,
  diskHash: null,
  remoteHash: null,
  base: undefined,
  remote: undefined,
  ...over,
});

describe("classify - sin base", () => {
  it("disco + remoto vivos, hashes idénticos -> pull", () => {
    expect(classify(input({ onDisk: true, diskHash: "sha256:x", remoteHash: "sha256:x", remote: doc() }))).toBe("pull");
  });

  it("disco + remoto vivos, hashes distintos -> merge", () => {
    expect(classify(input({ onDisk: true, diskHash: "sha256:x", remoteHash: "sha256:y", remote: doc() }))).toBe("merge");
  });

  it("solo en disco -> create", () => {
    expect(classify(input({ onDisk: true, diskHash: "sha256:x", remote: undefined }))).toBe("create");
  });

  it("solo remoto vivo -> pull", () => {
    expect(classify(input({ onDisk: false, remote: doc() }))).toBe("pull");
  });

  it("ni disco ni remoto -> noop", () => {
    expect(classify(input({ onDisk: false, remote: undefined }))).toBe("noop");
  });
});

describe("classify - con base", () => {
  const base = entry({ synced_hash: "sha256:base", base_version: 1 });

  it("nada cambió (disco == synced_hash, version == base_version) -> noop", () => {
    expect(
      classify(input({ onDisk: true, diskHash: "sha256:base", base, remote: doc({ version: 1 }), remoteHash: "sha256:base" })),
    ).toBe("noop");
  });

  it("solo editó local -> push", () => {
    expect(
      classify(input({ onDisk: true, diskHash: "sha256:edited", base, remote: doc({ version: 1 }), remoteHash: "sha256:base" })),
    ).toBe("push");
  });

  it("solo editó remoto -> pull", () => {
    expect(
      classify(input({ onDisk: true, diskHash: "sha256:base", base, remote: doc({ version: 2 }), remoteHash: "sha256:remote" })),
    ).toBe("pull");
  });

  it("editaron ambos -> merge", () => {
    expect(
      classify(input({ onDisk: true, diskHash: "sha256:edited", base, remote: doc({ version: 2 }), remoteHash: "sha256:remote" })),
    ).toBe("merge");
  });

  it("borrado local, remoto vivo sin cambios -> push-delete", () => {
    expect(classify(input({ onDisk: false, base, remote: doc({ version: 1 }) }))).toBe("push-delete");
  });

  it("borrado local, remoto desaparecido -> pull-delete", () => {
    expect(classify(input({ onDisk: false, base, remote: undefined }))).toBe("pull-delete");
  });

  it("borrado local, remoto editado (vivo, version cambió) -> delete-vs-edit", () => {
    expect(classify(input({ onDisk: false, base, remote: doc({ version: 2 }) }))).toBe("delete-vs-edit");
  });

  it("remoto borrado, local sin cambios en disco -> pull-delete", () => {
    expect(
      classify(input({ onDisk: true, diskHash: "sha256:base", base, remote: doc({ deleted: 1 }), remoteHash: null })),
    ).toBe("pull-delete");
  });

  it("remoto borrado, local editado en disco -> edit-vs-delete", () => {
    expect(
      classify(input({ onDisk: true, diskHash: "sha256:edited", base, remote: doc({ deleted: 1 }), remoteHash: null })),
    ).toBe("edit-vs-delete");
  });
});

describe("threeWayMerge", () => {
  it("ediciones no superpuestas -> sin conflicto, conserva ambos cambios", () => {
    const base = "a\nb\nc";
    const local = "A\nb\nc"; // cambia línea 1
    const remote = "a\nb\nC"; // cambia línea 3
    const { conflict, result } = threeWayMerge(local, base, remote);
    expect(conflict).toBe(false);
    expect(result).toContain("A");
    expect(result).toContain("C");
  });

  it("ediciones superpuestas -> conflicto con marcadores", () => {
    const base = "a\nb\nc";
    const local = "X\nb\nc";
    const remote = "Y\nb\nc";
    const { conflict, result } = threeWayMerge(local, base, remote);
    expect(conflict).toBe(true);
    expect(result).toContain("<<<<<<<");
  });
});

describe("sha256", () => {
  it("mismo input -> mismo hash, con prefijo sha256:", async () => {
    const a = await sha256("hola mundo");
    const b = await sha256("hola mundo");
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("inputs distintos -> hashes distintos", async () => {
    expect(await sha256("uno")).not.toBe(await sha256("dos"));
  });
});
