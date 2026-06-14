import { describe, it, expect } from "vitest";
import { parseHeadings } from "~/lib/links";

// parseHeadings es puro: extrae los headings (sin los #) de un markdown,
// ignorando los que estén dentro de bloques de código fenced (```).

describe("parseHeadings", () => {
  it("devuelve los headings #/## en orden", () => {
    const md = "# Uno\ntexto\n## Dos\nmás texto\n### Tres";
    expect(parseHeadings(md)).toEqual(["Uno", "Dos", "Tres"]);
  });

  it("ignora headings dentro de un bloque de código fenced", () => {
    const md = "# Real\n```\n# No es heading\n## Tampoco\n```\n## Otro real";
    expect(parseHeadings(md)).toEqual(["Real", "Otro real"]);
  });

  it("recorta los # de cierre (ATX cerrado)", () => {
    expect(parseHeadings("## Título ##")).toEqual(["Título"]);
  });

  it("no toma líneas sin espacio tras los # (#tag) ni texto plano", () => {
    expect(parseHeadings("#tag no es heading\ntexto suelto")).toEqual([]);
  });

  it("devuelve [] para contenido vacío", () => {
    expect(parseHeadings("")).toEqual([]);
  });
});
