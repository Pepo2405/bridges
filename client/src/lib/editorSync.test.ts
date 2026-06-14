import { describe, it, expect } from "vitest";
import { decideEditorSync, type EditorSyncState, type EditorSyncDoc } from "~/lib/editorSync";

// Tests de la decisión de sync del editor. El caso clave (regresión) es que
// contenido idéntico al borrador NO es conflicto: era el bug de "dos archivos
// iguales" al guardar (el eco del propio guardado disparaba el ConflictDialog).

const st = (over: Partial<EditorSyncState> = {}): EditorSyncState => ({
  loadedId: "id1",
  draft: "hola",
  dirty: false,
  baseVersion: 1,
  ...over,
});

const doc = (over: Partial<EditorSyncDoc> = {}): EditorSyncDoc => ({
  id: "id1",
  content: "hola",
  version: 1,
  ...over,
});

describe("decideEditorSync", () => {
  it("sin doc abierto -> clear", () => {
    expect(decideEditorSync(st(), null)).toEqual({ kind: "clear" });
  });

  it("cambió la selección (otro id) -> load fresco", () => {
    const d = decideEditorSync(st({ loadedId: "viejo" }), doc({ id: "id1", content: "nuevo", version: 5 }));
    expect(d).toEqual({ kind: "load", content: "nuevo", version: 5 });
  });

  it("mismo doc, misma versión -> none", () => {
    expect(decideEditorSync(st({ baseVersion: 3 }), doc({ version: 3 }))).toEqual({ kind: "none" });
  });

  // --- regresión del bug "dos archivos iguales" ---
  it("versión nueva pero contenido idéntico al borrador -> adopt, NO conflict", () => {
    // El server confirmó nuestro propio guardado: version subió, content == draft.
    const d = decideEditorSync(st({ draft: "hola", dirty: true, baseVersion: 1 }), doc({ content: "hola", version: 2 }));
    expect(d).toEqual({ kind: "adopt", version: 2 });
  });

  it("adopta aun sin cambios locales si la versión subió con el mismo contenido", () => {
    const d = decideEditorSync(st({ draft: "hola", dirty: false, baseVersion: 1 }), doc({ content: "hola", version: 2 }));
    expect(d).toEqual({ kind: "adopt", version: 2 });
  });

  it("versión nueva + contenido distinto + borrador sin guardar -> conflict", () => {
    const d = decideEditorSync(st({ draft: "mi edición", dirty: true, baseVersion: 1 }), doc({ content: "edición ajena", version: 2 }));
    expect(d).toEqual({ kind: "conflict" });
  });

  it("versión nueva + contenido distinto + sin cambios locales -> reflect", () => {
    const d = decideEditorSync(st({ draft: "hola", dirty: false, baseVersion: 1 }), doc({ content: "edición ajena", version: 2 }));
    expect(d).toEqual({ kind: "reflect", content: "edición ajena", version: 2 });
  });
});
