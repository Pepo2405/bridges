import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug } from "./writer";

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
