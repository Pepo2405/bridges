import { describe, it, expect } from "vitest";
import { parseHeadings, extractSection, toggleTaskAtIndex } from "~/lib/links";

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

describe("extractSection", () => {
  const md = "# Uno\n\na\n\n## Dos\n\nb\n\n### Tres\n\nc\n\n## Cuatro\n\nd\n";

  it("devuelve desde el heading hasta el próximo de nivel <=", () => {
    expect(extractSection(md, "Dos")).toBe("## Dos\n\nb\n\n### Tres\n\nc\n");
  });

  it("incluye la línea del heading", () => {
    expect(extractSection(md, "Uno")!.startsWith("# Uno")).toBe(true);
  });

  it("null si no existe", () => {
    expect(extractSection(md, "Nope")).toBeNull();
  });

  it("ignora un heading homónimo dentro de un fence", () => {
    const f = "```\n## Dos\n```\n\n## Dos\n\nreal\n";
    expect(extractSection(f, "Dos")).toBe("## Dos\n\nreal\n");
  });
});

describe("toggleTaskAtIndex", () => {
  const md = "- [ ] a\n- [x] b\n\n```\n- [ ] fenced\n```\n\n- [ ] c\n";

  it("flipea [ ]->[x] en el índice dado", () => {
    expect(toggleTaskAtIndex(md, 0)).toContain("- [x] a");
  });

  it("flipea [x]->[ ]", () => {
    expect(toggleTaskAtIndex(md, 1)).toContain("- [ ] b");
  });

  it("saltea tareas en fences (índice 2 = 'c')", () => {
    const out = toggleTaskAtIndex(md, 2);
    expect(out).toContain("- [x] c");
    expect(out).toContain("- [ ] fenced");
  });

  it("fuera de rango no cambia nada", () => {
    expect(toggleTaskAtIndex(md, 9)).toBe(md);
  });
});
