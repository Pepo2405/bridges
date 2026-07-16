import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNote, updateNote, deleteNote, restoreNote } from "./writer";
import { searchLocal, walkMd } from "./localIndex";

describe("loop completo de escritura (offline, recuperable)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-int-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("crear → append → patch → search → delete → restore", () => {
    createNote(dir, { title: "Memoria X", content: "# Memoria X\n\n## Notas\ninicial\n", path: "m" });
    updateNote(dir, { path: "m.md", mode: "append", content: "\n## Extra\nagregado\n" });
    updateNote(dir, { path: "m.md", mode: "patch", content: "actualizado", heading: "Notas" });

    // search encuentra el contenido nuevo en el índice local
    expect(searchLocal(dir, "actualizado", 10).map((h) => h.path)).toContain("m.md");

    deleteNote(dir, "m.md");
    expect(existsSync(join(dir, "m.md"))).toBe(false);

    restoreNote(dir, { path: "m.md" });
    expect(existsSync(join(dir, "m.md"))).toBe(true);
    expect(readFileSync(join(dir, "m.md"), "utf8")).toContain("actualizado");
  });

  test("INVARIANTE: .bridges/ (history+trash) no entra al índice ni al walk", () => {
    createNote(dir, { title: "N", content: "hola mundo", path: "n" });
    updateNote(dir, { path: "n.md", mode: "overwrite", content: "otra cosa" }); // crea snapshot en .bridges/history
    deleteNote(dir, "n.md"); // crea .bridges/trash/.../n.md

    // walkMd nunca lista nada bajo .bridges/
    expect(walkMd(dir).some((p) => p.startsWith(".bridges"))).toBe(false);
    // la búsqueda no devuelve el snapshot ("hola mundo" vivía solo en el snapshot)
    expect(searchLocal(dir, "hola mundo", 10).length).toBe(0);
  });
});
