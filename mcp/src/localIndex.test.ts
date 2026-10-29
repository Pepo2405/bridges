import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { searchLocal } from "./localIndex";

// Tests del índice FTS local del MCP. localIndex es singleton (un único índice en
// memoria por proceso): para aislar, usamos UN solo dir temporal que reseteamos en
// beforeEach. El propio sweep da de baja lo que ya no está en disco, así el estado
// se autolimpia entre tests. El mtime se setea explícito y monotónico (utimesSync)
// para que el sweep siempre detecte el cambio (sin colisiones de mtime entre tests).

let dir: string;
// Reloj monotónico (segundos) para los mtimes: cada write usa uno nuevo y mayor,
// así reescribir el mismo path siempre dispara la reindexación.
let clock = 1_000_000;

function write(rel: string, content: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  const t = ++clock;
  utimesSync(abs, t, t);
}

function remove(rel: string) {
  rmSync(join(dir, rel), { force: true });
}

/** Busca y devuelve los paths de los hits (en orden de ranking). */
function paths(query: string): string[] {
  return searchLocal(dir, query, 10).map((h) => h.path);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bridges-mcp-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  // Reset de disco: el siguiente searchLocal hace sweep y da de baja lo anterior.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

describe("sweep por mtime", () => {
  test("da de alta lo nuevo, reindexa lo cambiado y baja lo borrado", () => {
    // Alta: el doc nuevo aparece.
    write("a.md", "# A\nalpha contenido original");
    expect(paths("alpha")).toContain("a.md");

    // Cambio: reescribir con mtime mayor reindexa (gana el contenido nuevo).
    write("a.md", "# A\nbeta contenido nuevo");
    expect(paths("beta")).toContain("a.md");
    expect(paths("alpha")).not.toContain("a.md");

    // Alta de otro doc mientras el primero sigue.
    write("b.md", "# B\ngamma texto");
    expect(paths("gamma")).toContain("b.md");

    // Baja: borrar a.md lo saca del índice; b.md sobrevive.
    remove("a.md");
    expect(paths("beta")).not.toContain("a.md");
    expect(paths("gamma")).toContain("b.md");
  });
});

test("prefix-match: 'kuber' encuentra 'kubernetes'", () => {
  write("k.md", "# K\nkubernetes cluster deployment");
  expect(paths("kuber")).toContain("k.md");
});

test("si ninguna nota tiene TODOS los términos, cae a OR rankeado por BM25", () => {
  write("plano.md", "# Plano de mesas\nel plano de mesas del salón");
  write("solo-plano.md", "# Otra\nun plano suelto");
  // "inexistente" no está en ningún doc: con AND puro no habría resultados.
  const hits = paths("plano mesas inexistente");
  expect(hits[0]).toBe("plano.md"); // matchea más términos → rankea primero
  expect(hits).toContain("solo-plano.md");
});

test("con pathPrefix: si el AND solo matchea fuera de la carpeta, cae a OR dentro", () => {
  write("Docs/auth.md", "# Auth\nauth sesiones");
  write("Decisiones/ses.md", "# Ses\nsesiones en redis");
  expect(searchLocal(dir, "auth sesiones", 10, "Decisiones/").map((h) => h.path)).toEqual(["Decisiones/ses.md"]);
});

test("en OR se ignoran los tokens de 1-2 letras", () => {
  write("ruido.md", "# Ruido\nde el la");
  write("plano2.md", "# P\nplano");
  expect(paths("plano de inexistentezz")).toEqual(["plano2.md"]);
});

test("con AND alcanza, no agrega los matches parciales", () => {
  write("ambos.md", "# Ambos\nzorro azul");
  write("uno.md", "# Uno\nzorro rojo");
  expect(paths("zorro azul")).toEqual(["ambos.md"]);
});

test("pathPrefix filtra en SQL y no pierde matches fuera del top-50", () => {
  for (let i = 0; i < 60; i++) write(`bulk-${i}.md`, `# oracle ${i}\nbody`);
  write("01 - Proyectos/a.md", "# unrelated\n\noracle here");

  const all = searchLocal(dir, "oracle", 50);
  expect(all.length).toBe(50);
  expect(all.some((h) => h.path.startsWith("01 - Proyectos/"))).toBe(false);

  expect(searchLocal(dir, "oracle", 10, "01 - Proyectos/").map((h) => h.path)).toEqual([
    "01 - Proyectos/a.md",
  ]);
  // El prefijo es literal: % y _ no son comodines de LIKE.
  expect(searchLocal(dir, "oracle", 10, "01 - Proy%")).toEqual([]);
});

test("insensible a acentos: 'mitocondria' encuentra 'mitocondría'", () => {
  write("bio.md", "# Biología\nla mitocondría produce energía");
  expect(paths("mitocondria")).toContain("bio.md");
});

test("query vacía o sin tokens → sin resultados", () => {
  write("x.md", "# X\ncontenido cualquiera");
  expect(paths("")).toEqual([]);
  expect(paths("   ")).toEqual([]);
  expect(paths('"')).toEqual([]);
});

describe("ranking BM25", () => {
  test("rankea el doc relevante sobre la mención incidental; el snippet trae el término", () => {
    write("relevante.md", "# Kubernetes\nkubernetes kubernetes kubernetes cluster deployment namespace");
    write("incidental.md", "# Notas varias\nuna mención de kubernetes al pasar, nada más");

    const hits = searchLocal(dir, "kubernetes", 10);
    const ps = hits.map((h) => h.path);
    expect(ps).toContain("relevante.md");
    expect(ps).toContain("incidental.md");
    expect(ps.indexOf("relevante.md")).toBeLessThan(ps.indexOf("incidental.md"));

    expect(hits[0].snippet.toLowerCase()).toContain("kubernetes");
    // El hit local incluye la ruta absoluta del .md para abrirlo con Read.
    expect(hits[0].localPath).toBe(join(dir, "relevante.md"));
  });
});
