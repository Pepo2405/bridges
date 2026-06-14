import { test, expect, describe } from "bun:test";
import { getBacklinks, getOutgoingLinks, type DocLite } from "./graph";

// Tests del grafo de wikilinks del MCP. Puro (sin fs): se arma un DocLite[] a mano.
// La identidad es el path; la resolución de [[target]] es por path completo (sin
// .md) o por basename, y normaliza alias (|), heading (#) y bloque (^).

const doc = (path: string, content: string): DocLite => ({ path, title: null, content });

describe("getBacklinks", () => {
  const docs = [
    doc("a.md", "enlazo a [[B]] y a [[C]]"),
    doc("b.md", "soy b, me enlazo a [[B]] y enlazo a [[c]]"),
    doc("c.md", "nada que enlazar"),
    doc("d.md", "voy a [[B|con alias]] y de nuevo a [[B#una-seccion]]"),
  ];

  test("quiénes enlazan a b.md (sin self, dedup, ordenado por path)", () => {
    expect(getBacklinks(docs, "b.md").map((d) => d.path)).toEqual(["a.md", "d.md"]);
  });

  test("alias y heading no afectan: d.md enlaza dos veces a B pero aparece una sola", () => {
    expect(getBacklinks(docs, "b.md").filter((d) => d.path === "d.md").length).toBe(1);
  });

  test("nota sin backlinks → []", () => {
    expect(getBacklinks(docs, "a.md")).toEqual([]);
  });

  test("nota que no existe → []", () => {
    expect(getBacklinks(docs, "no-existe.md")).toEqual([]);
  });
});

describe("getOutgoingLinks", () => {
  const docs = [
    doc("a.md", "voy a [[B]], a [[Inexistente]] y de nuevo a [[B]]"),
    doc("b.md", "# B"),
  ];

  test("resueltos y rotos, dedup por target", () => {
    const links = getOutgoingLinks(docs, "a.md");
    expect(links.length).toBe(2); // B (dedup) + Inexistente
    expect(links.find((l) => l.target === "B")?.resolved?.path).toBe("b.md");
    expect(links.find((l) => l.target === "Inexistente")?.resolved).toBe(null);
  });

  test("nota sin links salientes → []", () => {
    expect(getOutgoingLinks(docs, "b.md")).toEqual([]);
  });
});
