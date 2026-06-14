import { describe, it, expect } from "vitest";
import { localSearch } from "~/lib/store";
import type { Doc } from "~/lib/api";

// Tests de la búsqueda léxica en memoria de los vaults locales. Es pura: recorre
// los docs y rankea por dónde matchea (título > path > contenido), insensible a
// acentos y mayúsculas.

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: "id1",
  path: "a.md",
  title: null,
  content: "",
  version: 0,
  seq: 0,
  deleted: 0,
  updated_by: null,
  updated_at: "",
  ...over,
});

describe("localSearch", () => {
  it("query vacía (o solo espacios) devuelve []", () => {
    expect(localSearch([doc({ content: "hola" })], "")).toEqual([]);
    expect(localSearch([doc({ content: "hola" })], "   ")).toEqual([]);
  });

  it("un match en el título rankea por encima de un match solo en el contenido", () => {
    const enTitulo = doc({ id: "t", path: "t.md", title: "Reunión semanal", content: "nada relevante" });
    const enContenido = doc({ id: "c", path: "c.md", title: "Otra cosa", content: "hablamos de la reunión" });
    const hits = localSearch([enContenido, enTitulo], "reunion");
    expect(hits.map((h) => h.id)).toEqual(["t", "c"]);
  });

  it("es insensible a acentos y mayúsculas", () => {
    const hits = localSearch([doc({ id: "x", content: "Plan de ACCIÓN inmediato" })], "accion");
    expect(hits.map((h) => h.id)).toEqual(["x"]);
  });

  it("un doc sin match no aparece; el snippet contiene el término", () => {
    const match = doc({ id: "m", content: "el zorro marrón salta la valla" });
    const noMatch = doc({ id: "n", content: "texto totalmente ajeno" });
    const hits = localSearch([match, noMatch], "zorro");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("m");
    expect(hits[0].snippet.toLowerCase()).toContain("zorro");
  });
});
