/**
 * Decisión pura de sincronización del editor: dado el estado del borrador y el
 * doc abierto (que pudo cambiar por selección, SSE, pull o nuestro propio
 * guardado), decide qué reflejar. Extraído del createEffect de App para poder
 * testear el caso que sí o sí hay que pinear: contenido idéntico NO es conflicto.
 */

export type EditorSyncState = {
  loadedId: string | null; // id del doc actualmente cargado en el editor
  draft: string; // contenido en el editor
  dirty: boolean; // hay cambios sin guardar
  baseVersion: number; // versión sobre la que se basa el borrador
};

export type EditorSyncDoc = { id: string; content: string; version: number };

export type EditorSyncDecision =
  | { kind: "clear" } // no hay doc abierto
  | { kind: "load"; content: string; version: number } // cambió la selección: cargar fresco
  | { kind: "none" } // sin novedades
  | { kind: "adopt"; version: number } // el server confirma exactamente nuestro borrador
  | { kind: "conflict" } // colisión real: versión nueva + cambios locales sin guardar
  | { kind: "reflect"; content: string; version: number }; // edición externa, sin cambios locales

export function decideEditorSync(st: EditorSyncState, doc: EditorSyncDoc | null): EditorSyncDecision {
  if (!doc) return { kind: "clear" };
  if (doc.id !== st.loadedId) return { kind: "load", content: doc.content, version: doc.version };
  if (doc.version === st.baseVersion) return { kind: "none" };
  // Mismo contenido que el borrador: eco de nuestro propio guardado (o alguien
  // guardó idéntico). No hay nada que resolver -> adoptamos la versión.
  if (doc.content === st.draft) return { kind: "adopt", version: doc.version };
  if (st.dirty) return { kind: "conflict" };
  return { kind: "reflect", content: doc.content, version: doc.version };
}
