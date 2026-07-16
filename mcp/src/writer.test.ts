import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug, snapshot, historyDir, createNote } from "./writer";

describe("slug", () => {
  test("normaliza título a nombre de archivo", () => {
    expect(slug("Hola Mundo")).toBe("hola-mundo");
    expect(slug("Título con Acentos áéí")).toBe("titulo-con-acentos-aei");
    expect(slug("  Espacios  y   símbolos!? ")).toBe("espacios-y-simbolos");
    expect(slug("A/B\\C:D")).toBe("a-b-c-d");
  });
  test("nunca devuelve vacío", () => {
    expect(slug("!!!")).toBe("nota");
    expect(slug("")).toBe("nota");
  });
});

describe("snapshot", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-w-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("copia el estado actual a .bridges/history/<rel>/<ts>.md", () => {
    writeFileSync(join(dir, "nota.md"), "v1", "utf8");
    snapshot(dir, "nota.md", 1000);
    const hdir = historyDir(dir, "nota.md");
    const files = readdirSync(hdir);
    expect(files.length).toBe(1);
    expect(readFileSync(join(hdir, files[0]), "utf8")).toBe("v1");
  });

  test("no snapshotea si el archivo no existe (create sin previo)", () => {
    snapshot(dir, "nueva.md", 1000);
    expect(existsSync(historyDir(dir, "nueva.md"))).toBe(false);
  });

  test("rota a los 50 más nuevos (deja los timestamps más nuevos)", () => {
    writeFileSync(join(dir, "n.md"), "x", "utf8");
    for (let i = 1; i <= 55; i++) snapshot(dir, "n.md", 1000 + i);
    const files = readdirSync(historyDir(dir, "n.md")).sort();
    expect(files.length).toBe(50);
    // los 5 más viejos (now=1001..1005) se fueron; el más nuevo (1055) quedó
    const stampOf = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");
    expect(files.some((f) => f.startsWith(stampOf(1001)))).toBe(false);
    expect(files.some((f) => f.startsWith(stampOf(1055)))).toBe(true);
  });

  test("no escapa el vault con relPath de traversal", () => {
    writeFileSync(join(dir, "n.md"), "data", "utf8");
    snapshot(dir, "../../../n.md", 2000); // relPath malicioso
    // el historial queda DENTRO del vault, no un nivel arriba
    const escaped = join(dir, "..", ".bridges");
    expect(existsSync(escaped)).toBe(false);
  });

  test("colisión de ms: el write más nuevo ordena DESPUÉS (rotación nunca lo poda antes)", () => {
    const hdir = historyDir(dir, "n.md");
    writeFileSync(join(dir, "n.md"), "v1", "utf8"); snapshot(dir, "n.md", 4000);
    writeFileSync(join(dir, "n.md"), "v2", "utf8"); snapshot(dir, "n.md", 4000);
    const files = readdirSync(hdir).sort();
    expect(files.length).toBe(2);
    expect(files[0] < files[1]).toBe(true);               // orden estable por escritura
    expect(readFileSync(join(hdir, files[1]), "utf8")).toBe("v2"); // el último sort() es el más nuevo
  });
});

describe("createNote", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-w-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("con path explícito escribe ahí y agrega .md", () => {
    const r = createNote(dir, { title: "T", content: "cuerpo", path: "a/b/c" });
    expect(r).toMatchObject({ path: "a/b/c.md", action: "created" });
    expect(readFileSync(join(dir, "a/b/c.md"), "utf8")).toBe("cuerpo");
  });

  test("sin path usa Memoria/<slug(title)>.md", () => {
    const r = createNote(dir, { title: "Mi Idea", content: "x" });
    expect(r.path).toBe("Memoria/mi-idea.md");
    expect(existsSync(join(dir, "Memoria/mi-idea.md"))).toBe(true);
  });

  test("respeta folder custom", () => {
    const r = createNote(dir, { title: "Log", content: "x", folder: "Journal" });
    expect(r.path).toBe("Journal/log.md");
  });

  test("colisión sin overwrite lanza con el path existente", () => {
    createNote(dir, { title: "T", content: "v1", path: "n" });
    expect(() => createNote(dir, { title: "T", content: "v2", path: "n" })).toThrow(/ya existe/i);
  });

  test("colisión con overwrite reemplaza (snapshotea el previo)", () => {
    createNote(dir, { title: "T", content: "v1", path: "n" });
    const r = createNote(dir, { title: "T", content: "v2", path: "n", overwrite: true });
    expect(r.action).toBe("created");
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("v2");
    expect(readdirSync(historyDir(dir, "n.md")).length).toBe(1); // snapshot de v1
  });
});
