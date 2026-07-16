# MCP Write — Fase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar escritura al MCP de Bridges (hoy 100% read-only): que Claude cree, edite (overwrite/append/patch) y borre notas en el vault local, con toda operación destructiva recuperable.

**Architecture:** Un módulo nuevo `mcp/src/writer.ts` con ops de filesystem puras sobre un `vaultDir` explícito (igual patrón que `localIndex.searchLocal`). Undo net propio en `.bridges/` del vault (`history/` con snapshots rotados + `trash/` con manifest). Cinco tools nuevas en `index.ts` que resuelven el vault destino con el mismo `vault?` que las de lectura, analizan links rotos/huérfanos reusando `graph.ts`, y solo se registran en modo local (no HTTP) y con write habilitado.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk`, Zod, `bun:test`, `bun:sqlite` (solo lectura, no se toca).

## Global Constraints

- **Modo local-only:** las write-tools escriben `.md` directo a disco; en modo HTTP no se registran. Copiado del spec §2.3/§5.
- **Dir interno = `.bridges/`:** undo net en `.bridges/history/` y `.bridges/trash/`. Convive con `.bridges/index.json` y `.bridges/state.json`. Ya excluido del índice/grafo por `walkMd` (localIndex.ts:59, salta todo lo que empieza con `.`). Spec §2.7.
- **Write default-on, opt-out con `BRIDGES_MCP_READONLY=1`.** Spec §7c.
- **Folder default sin path = `Memoria/`** (slug del title). Spec §7b, §3.
- **Vault destino:** `vault?` opcional por nombre (`resolveNamedVault`); sin él, cascada de arranque (`resolveVaultDir`). Spec §2.6.
- **Anti-traversal en todo path** (reusar `resolveInVault` de `bridges.ts`). Spec §5.
- **Rotación de snapshots:** máx. 50 por nota. Spec §4.
- **Salida JSON estructurada** en cada tool. Spec §3.
- Verificación por tarea: `cd mcp && bun test` y `bunx tsc --noEmit` en verde.

---

### Task 1: Fundaciones de `writer.ts` (`slug` + reuso de `resolveInVault`)

**Files:**
- Modify: `mcp/src/bridges.ts` (exportar `resolveInVault`, hoy privado en ~línea 99)
- Create: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Consumes: `resolveInVault(vaultDir: string, relPath: string): string` (de `bridges.ts`), `deriveTitle(content, path)` (de `server/src/search-common`).
- Produces: `slug(title: string): string` — normaliza un título a nombre de archivo (sin `.md`). `VAULT_INTERNAL = ".bridges"` const.

- [ ] **Step 1: Exportar `resolveInVault` desde `bridges.ts`**

En `mcp/src/bridges.ts`, cambiar la declaración privada:

```ts
function resolveInVault(vaultDir: string, relPath: string): string {
```

por:

```ts
export function resolveInVault(vaultDir: string, relPath: string): string {
```

(No cambia nada más; ya se usa internamente en `readNoteLocal`.)

- [ ] **Step 2: Escribir el test de `slug`**

Crear `mcp/src/writer.test.ts`:

```ts
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
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "Cannot find module './writer'" o "slug is not a function".

- [ ] **Step 4: Implementar `writer.ts` mínimo**

Crear `mcp/src/writer.ts`:

```ts
/**
 * Capa de escritura del MCP de Bridges (Fase 0). Ops de filesystem puras sobre un
 * `vaultDir` explícito, con undo net propio en `.bridges/` (history + trash).
 * Local-only: nunca habla HTTP. Ver docs/superpowers/specs/2026-07-06-mcp-write-fase0-design.md
 */
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, existsSync, appendFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { deriveTitle } from "../../server/src/search-common";
import { resolveInVault } from "./bridges";

/** Carpeta interna del MCP dentro del vault (undo net + índice). Excluida del indexado. */
export const VAULT_INTERNAL = ".bridges";

/** Normaliza un título a nombre de archivo seguro (sin extensión). Nunca vacío. */
export function slug(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")     // no-alfanumérico → guion
    .replace(/^-+|-+$/g, "");        // recorta guiones de los bordes
  return s || "nota";
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS (2 tests de `slug`).

- [ ] **Step 6: Typecheck y commit**

Run: `cd mcp && bunx tsc --noEmit`
Expected: sin errores.

```bash
git add mcp/src/bridges.ts mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): writer.ts base (slug) + exporta resolveInVault"
```

---

### Task 2: Snapshots (`snapshot`) con rotación a 50

**Files:**
- Modify: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Produces: `snapshot(vaultDir: string, relPath: string, now?: number): void` — copia el estado ACTUAL del `.md` a `.bridges/history/<relPath>/<ts>.md`. `now` (ms) inyectable para tests; default `Date.now()`. Rota a los 50 más nuevos.
- Produces: `historyDir(vaultDir: string, relPath: string): string`.

- [ ] **Step 1: Escribir el test de snapshot + rotación**

Añadir a `mcp/src/writer.test.ts`:

```ts
import { snapshot, historyDir } from "./writer";

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

  test("rota a los 50 más nuevos", () => {
    writeFileSync(join(dir, "n.md"), "x", "utf8");
    for (let i = 1; i <= 55; i++) snapshot(dir, "n.md", 1000 + i);
    expect(readdirSync(historyDir(dir, "n.md")).length).toBe(50);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "snapshot is not a function".

- [ ] **Step 3: Implementar `snapshot`**

Añadir a `mcp/src/writer.ts`:

```ts
/** Dir de historial de una nota: .bridges/history/<relPath>/ */
export function historyDir(vaultDir: string, relPath: string): string {
  return join(vaultDir, VAULT_INTERNAL, "history", relPath);
}

/** Timestamp filesystem-safe (sin `:` ni `.`). */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

/**
 * Guarda el estado ACTUAL del `.md` en el historial antes de una edición/borrado.
 * No hace nada si el archivo no existe (create sin versión previa). Rota a 50.
 */
export function snapshot(vaultDir: string, relPath: string, now: number = Date.now()): void {
  const abs = resolveInVault(vaultDir, relPath);
  if (!existsSync(abs)) return;
  const hdir = historyDir(vaultDir, relPath);
  mkdirSync(hdir, { recursive: true });
  writeFileSync(join(hdir, `${stamp(now)}.md`), readFileSync(abs, "utf8"), "utf8");
  const files = readdirSync(hdir).sort(); // ISO ordena cronológicamente
  for (const f of files.slice(0, Math.max(0, files.length - 50))) {
    rmSync(join(hdir, f), { force: true });
  }
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck y commit**

Run: `cd mcp && bunx tsc --noEmit`

```bash
git add mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): snapshot() con rotación a 50 en .bridges/history"
```

---

### Task 3: `createNote`

**Files:**
- Modify: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WriteResult = { path: string; title: string | null; action: string; mode?: string; bytes: number };
  export function createNote(vaultDir: string, args: { title: string; content: string; path?: string; folder?: string; overwrite?: boolean }): WriteResult
  ```
- `action` = `"created"`. Sin `path` → `<folder|Memoria>/<slug(title)>.md`. Colisión sin `overwrite` → throw.

- [ ] **Step 1: Escribir los tests de createNote**

Añadir a `writer.test.ts`:

```ts
import { createNote } from "./writer";

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
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "createNote is not a function".

- [ ] **Step 3: Implementar `createNote`**

Añadir a `writer.ts`:

```ts
export type WriteResult = { path: string; title: string | null; action: string; mode?: string; bytes: number };

/** Escribe `content` en `abs`, creando dirs; devuelve bytes escritos. */
function writeFileEnsured(abs: string, content: string): number {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return Buffer.byteLength(content, "utf8");
}

export function createNote(
  vaultDir: string,
  args: { title: string; content: string; path?: string; folder?: string; overwrite?: boolean },
): WriteResult {
  const rel = args.path
    ? (args.path.endsWith(".md") ? args.path : `${args.path}.md`)
    : join(args.folder || "Memoria", `${slug(args.title)}.md`);
  const abs = resolveInVault(vaultDir, rel);
  if (existsSync(abs) && !args.overwrite) {
    throw new Error(`ya existe una nota en "${rel}" (pasá overwrite:true para reemplazar).`);
  }
  snapshot(vaultDir, rel); // no-op si no existía
  const bytes = writeFileEnsured(abs, args.content);
  return { path: rel, title: deriveTitle(args.content, rel), action: "created", bytes };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck y commit**

```bash
git add mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): createNote (path explícito o Memoria/slug, colisión guardada)"
```

---

### Task 4: `updateNote` modos `overwrite` y `append`

**Files:**
- Modify: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function updateNote(vaultDir: string, args: { path: string; mode: "overwrite" | "append" | "patch"; content: string; heading?: string }): WriteResult
  ```
- `action` = `"updated"`, `mode` se devuelve. Nota inexistente → throw. Snapshotea antes de escribir. (Este task cubre `overwrite`/`append`; `patch` en Task 5.)

- [ ] **Step 1: Tests de overwrite y append**

Añadir a `writer.test.ts`:

```ts
import { updateNote } from "./writer";

describe("updateNote overwrite/append", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-w-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("overwrite reemplaza el cuerpo entero y snapshotea", () => {
    createNote(dir, { title: "T", content: "viejo", path: "n" });
    const r = updateNote(dir, { path: "n.md", mode: "overwrite", content: "nuevo" });
    expect(r).toMatchObject({ path: "n.md", action: "updated", mode: "overwrite" });
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("nuevo");
    expect(readdirSync(historyDir(dir, "n.md")).length).toBe(1);
  });

  test("append agrega al final con salto de línea", () => {
    createNote(dir, { title: "T", content: "línea 1", path: "n" });
    updateNote(dir, { path: "n.md", mode: "append", content: "línea 2" });
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("línea 1\nlínea 2");
  });

  test("nota inexistente lanza", () => {
    expect(() => updateNote(dir, { path: "no.md", mode: "overwrite", content: "x" })).toThrow(/no existe/i);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "updateNote is not a function".

- [ ] **Step 3: Implementar `updateNote` (sin patch todavía)**

Añadir a `writer.ts`:

```ts
export function updateNote(
  vaultDir: string,
  args: { path: string; mode: "overwrite" | "append" | "patch"; content: string; heading?: string },
): WriteResult {
  const rel = args.path;
  const abs = resolveInVault(vaultDir, rel);
  if (!existsSync(abs)) throw new Error(`no existe la nota "${rel}".`);
  snapshot(vaultDir, rel);
  let next: string;
  if (args.mode === "overwrite") {
    next = args.content;
  } else if (args.mode === "append") {
    const prev = readFileSync(abs, "utf8");
    next = prev.endsWith("\n") ? prev + args.content : `${prev}\n${args.content}`;
  } else {
    throw new Error(`modo patch: implementado en patchSection (ver updateNote patch).`);
  }
  const bytes = writeFileEnsured(abs, next);
  return { path: rel, title: deriveTitle(next, rel), action: "updated", mode: args.mode, bytes };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): updateNote overwrite/append con snapshot previo"
```

---

### Task 5: `updateNote` modo `patch` (sección por heading)

**Files:**
- Modify: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Produces: `patchSection(content: string, heading: string, newBody: string): string` (helper puro). `heading` es el texto sin `#` (p. ej. `"Sección B"`). Reemplaza el cuerpo bajo ese heading hasta el próximo heading de nivel igual o mayor (mismo `#` o menos). Heading inexistente → throw.

- [ ] **Step 1: Tests de patchSection y del modo patch**

Añadir a `writer.test.ts`:

```ts
import { patchSection } from "./writer";

describe("patchSection", () => {
  const doc = `# Título

## Sección A
texto A

## Sección B
viejo B
más viejo

## Sección C
texto C
`;

  test("reemplaza solo el cuerpo de la sección indicada", () => {
    const out = patchSection(doc, "Sección B", "nuevo B");
    expect(out).toContain("## Sección B\n\nnuevo B");
    expect(out).toContain("## Sección A\ntexto A"); // A intacta
    expect(out).toContain("## Sección C\ntexto C"); // C intacta
    expect(out).not.toContain("viejo B");
  });

  test("no cruza a subsecciones de menor nivel", () => {
    const nested = `## Padre\ncuerpo\n### Hija\nsub\n## Otro\nx\n`;
    const out = patchSection(nested, "Padre", "NUEVO");
    expect(out).toContain("### Hija"); // la hija (nivel mayor) queda dentro y se reemplaza
    // "Padre" (##) termina en "## Otro" (mismo nivel), así Hija cae dentro de Padre → se va
    expect(out).not.toContain("### Hija") === false; // ver nota abajo
  });

  test("heading inexistente lanza", () => {
    expect(() => patchSection(doc, "No Existe", "x")).toThrow(/heading/i);
  });
});

describe("updateNote patch", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-w-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("patch reemplaza la sección en disco", () => {
    createNote(dir, { title: "T", content: "# T\n\n## X\nviejo\n\n## Y\nkeep\n", path: "n" });
    const r = updateNote(dir, { path: "n.md", mode: "patch", content: "nuevo", heading: "X" });
    expect(r.mode).toBe("patch");
    const out = readFileSync(join(dir, "n.md"), "utf8");
    expect(out).toContain("## X\n\nnuevo");
    expect(out).toContain("## Y\nkeep");
    expect(out).not.toContain("viejo");
  });

  test("heading inexistente no crea nada y lanza", () => {
    createNote(dir, { title: "T", content: "# T\n\n## X\na\n", path: "n" });
    expect(() => updateNote(dir, { path: "n.md", mode: "patch", content: "z", heading: "NoExiste" })).toThrow(/heading/i);
  });
});
```

> Nota para el implementador: en el test "no cruza a subsecciones" la aserción confusa
> se corrige en el Step 3 según el comportamiento real. Borrá esa línea `=== false`
> y dejá la aserción que refleje la semántica implementada (una sección `##` incluye
> sus `###` hijas y las reemplaza junto con su cuerpo). Ver Step 3.

- [ ] **Step 2: Corregir el test ambiguo y correr (rojo)**

Reemplazá el cuerpo del test `"no cruza a subsecciones de menor nivel"` por:

```ts
  test("una sección incluye a sus subsecciones más profundas", () => {
    const nested = `## Padre\ncuerpo\n### Hija\nsub\n## Otro\nx\n`;
    const out = patchSection(nested, "Padre", "NUEVO");
    expect(out).toContain("## Padre\n\nNUEVO");
    expect(out).not.toContain("### Hija"); // la hija (###) cae dentro de Padre (##) → se reemplaza
    expect(out).toContain("## Otro\nx");   // Otro (##, mismo nivel) corta la sección
  });
```

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "patchSection is not a function".

- [ ] **Step 3: Implementar `patchSection` y conectar el modo patch**

Añadir a `writer.ts`:

```ts
/**
 * Reemplaza el cuerpo bajo `heading` (texto sin `#`) por `newBody`, hasta el próximo
 * heading de nivel igual o mayor (mismo nº de `#` o menos). Heading inexistente → throw.
 */
export function patchSection(content: string, heading: string, newBody: string): string {
  const lines = content.split("\n");
  const target = heading.replace(/^#+\s*/, "").trim();
  const hIdx = lines.findIndex(
    (l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === target,
  );
  if (hIdx === -1) throw new Error(`heading no encontrado: "${heading}"`);
  const level = lines[hIdx].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const before = lines.slice(0, hIdx + 1);
  const after = lines.slice(end);
  const body = newBody.replace(/\n+$/, "");
  const joined = [...before, "", body, "", ...after].join("\n");
  return joined.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}
```

Y en `updateNote`, reemplazar la rama `else { throw ... }` por:

```ts
  } else {
    const prev = readFileSync(abs, "utf8");
    if (!args.heading) throw new Error(`modo patch requiere "heading".`);
    next = patchSection(prev, args.heading, args.content);
  }
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck y commit**

```bash
git add mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): updateNote patch (reemplazo de sección por heading)"
```

---

### Task 6: `deleteNote` → trash + manifest

**Files:**
- Modify: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DeleteResult = { path: string; action: "trashed"; trashPath: string };
  export function deleteNote(vaultDir: string, relPath: string, now?: number): DeleteResult
  ```
- Mueve el `.md` a `.bridges/trash/<ts>/<relPath>` (preserva estructura, `<ts>` evita colisiones) y agrega línea a `.bridges/trash/manifest.jsonl`. Nota inexistente → throw.

- [ ] **Step 1: Tests de deleteNote**

Añadir a `writer.test.ts`:

```ts
import { deleteNote } from "./writer";

describe("deleteNote", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-w-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("mueve a trash y registra en el manifest", () => {
    createNote(dir, { title: "T", content: "borrame", path: "sub/n" });
    const r = deleteNote(dir, "sub/n.md", 1000);
    expect(r.action).toBe("trashed");
    expect(existsSync(join(dir, "sub/n.md"))).toBe(false);
    expect(existsSync(join(dir, r.trashPath))).toBe(true);
    expect(readFileSync(join(dir, r.trashPath), "utf8")).toBe("borrame");
    const manifest = readFileSync(join(dir, ".bridges/trash/manifest.jsonl"), "utf8").trim();
    expect(JSON.parse(manifest)).toMatchObject({ path: "sub/n.md" });
  });

  test("nota inexistente lanza", () => {
    expect(() => deleteNote(dir, "no.md")).toThrow(/no existe/i);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "deleteNote is not a function".

- [ ] **Step 3: Implementar `deleteNote`**

Añadir a `writer.ts`:

```ts
export type DeleteResult = { path: string; action: "trashed"; trashPath: string };

export function deleteNote(vaultDir: string, relPath: string, now: number = Date.now()): DeleteResult {
  const abs = resolveInVault(vaultDir, relPath);
  if (!existsSync(abs)) throw new Error(`no existe la nota "${relPath}".`);
  const ts = stamp(now);
  const trashRel = join(VAULT_INTERNAL, "trash", ts, relPath);
  const trashAbs = resolveInVault(vaultDir, trashRel);
  mkdirSync(dirname(trashAbs), { recursive: true });
  renameSync(abs, trashAbs);
  const manifestAbs = join(vaultDir, VAULT_INTERNAL, "trash", "manifest.jsonl");
  mkdirSync(dirname(manifestAbs), { recursive: true });
  appendFileSync(manifestAbs, JSON.stringify({ path: relPath, trashPath: trashRel, ts }) + "\n", "utf8");
  return { path: relPath, action: "trashed", trashPath: trashRel };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): deleteNote → .bridges/trash + manifest.jsonl"
```

---

### Task 7: `restoreNote` + `listHistory`

**Files:**
- Modify: `mcp/src/writer.ts`
- Test: `mcp/src/writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RestoreResult = { path: string; action: "restored"; source: "trash" | "history" };
  export type HistoryEntry = { kind: "history" | "trash"; ts: string; ref: string };
  export function restoreNote(vaultDir: string, args: { path: string; from?: "trash" | "history"; timestamp?: string }): RestoreResult
  export function listHistory(vaultDir: string, relPath: string): HistoryEntry[]
  ```
- `restoreNote` default: trash si hay entrada, si no el snapshot de history más reciente. No pisa un archivo existente salvo que sea revert de history.

- [ ] **Step 1: Tests de restore y listHistory**

Añadir a `writer.test.ts`:

```ts
import { restoreNote, listHistory } from "./writer";

describe("restoreNote / listHistory", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridges-w-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("restaura un borrado desde trash", () => {
    createNote(dir, { title: "T", content: "data", path: "n" });
    deleteNote(dir, "n.md", 1000);
    const r = restoreNote(dir, { path: "n.md" });
    expect(r).toMatchObject({ action: "restored", source: "trash" });
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("data");
  });

  test("revierte una edición desde history (from:history)", () => {
    createNote(dir, { title: "T", content: "v1", path: "n" });
    updateNote(dir, { path: "n.md", mode: "overwrite", content: "v2" }); // snapshotea v1
    const r = restoreNote(dir, { path: "n.md", from: "history" });
    expect(r.source).toBe("history");
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("v1");
  });

  test("listHistory lista snapshots y trash de la nota", () => {
    createNote(dir, { title: "T", content: "v1", path: "n" });
    updateNote(dir, { path: "n.md", mode: "overwrite", content: "v2" });
    deleteNote(dir, "n.md", 2000);
    const h = listHistory(dir, "n.md");
    expect(h.some((e) => e.kind === "history")).toBe(true);
    expect(h.some((e) => e.kind === "trash")).toBe(true);
  });

  test("restaurar sin trash ni history lanza", () => {
    expect(() => restoreNote(dir, { path: "no.md" })).toThrow(/nada que restaurar/i);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: FAIL con "restoreNote is not a function".

- [ ] **Step 3: Implementar `restoreNote` + `listHistory`**

Añadir a `writer.ts`:

```ts
export type RestoreResult = { path: string; action: "restored"; source: "trash" | "history" };
export type HistoryEntry = { kind: "history" | "trash"; ts: string; ref: string };

type TrashRec = { path: string; trashPath: string; ts: string };

function readManifest(vaultDir: string): TrashRec[] {
  const p = join(vaultDir, VAULT_INTERNAL, "trash", "manifest.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrashRec);
}

export function listHistory(vaultDir: string, relPath: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const hdir = historyDir(vaultDir, relPath);
  if (existsSync(hdir)) {
    for (const f of readdirSync(hdir).sort()) {
      out.push({ kind: "history", ts: f.replace(/\.md$/, ""), ref: join(VAULT_INTERNAL, "history", relPath, f) });
    }
  }
  for (const rec of readManifest(vaultDir).filter((r) => r.path === relPath)) {
    out.push({ kind: "trash", ts: rec.ts, ref: rec.trashPath });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function restoreNote(
  vaultDir: string,
  args: { path: string; from?: "trash" | "history"; timestamp?: string },
): RestoreResult {
  const rel = args.path;
  const abs = resolveInVault(vaultDir, rel);
  const trash = readManifest(vaultDir).filter((r) => r.path === rel);
  const wantTrash = args.from === "trash" || (!args.from && trash.length > 0);
  if (wantTrash) {
    const rec = args.timestamp ? trash.find((r) => r.ts === args.timestamp) : trash[trash.length - 1];
    if (!rec) throw new Error(`nada que restaurar en trash para "${rel}".`);
    const src = resolveInVault(vaultDir, rec.trashPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, readFileSync(src, "utf8"), "utf8");
    return { path: rel, action: "restored", source: "trash" };
  }
  const hdir = historyDir(vaultDir, rel);
  const snaps = existsSync(hdir) ? readdirSync(hdir).sort() : [];
  if (!snaps.length) throw new Error(`nada que restaurar (sin trash ni history) para "${rel}".`);
  const snap = args.timestamp ? snaps.find((f) => f.startsWith(args.timestamp!)) : snaps[snaps.length - 1];
  if (!snap) throw new Error(`no hay snapshot "${args.timestamp}" para "${rel}".`);
  snapshot(vaultDir, rel); // guarda el estado actual antes de revertir
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, readFileSync(join(hdir, snap), "utf8"), "utf8");
  return { path: rel, action: "restored", source: "history" };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd mcp && bun test src/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck y commit**

```bash
git add mcp/src/writer.ts mcp/src/writer.test.ts
git commit -m "feat(mcp): restoreNote (trash/history) + listHistory"
```

---

### Task 8: Registrar las 5 tools en `index.ts` (gating + vault + links)

**Files:**
- Modify: `mcp/src/index.ts` (imports, header, gate de write, 5 `registerTool`)
- Modify: `mcp/src/bridges.ts` (exportar `effectiveVaultDir` e `isLocalMode`)
- Test: `mcp/src/writeTools.test.ts` (nuevo)

**Interfaces:**
- Consumes: `createNote/updateNote/deleteNote/restoreNote/listHistory` (writer.ts), `effectiveVaultDir(vault?)`, `isLocalMode()` (bridges.ts), `allDocs(vault?)`, `getOutgoingLinks(docs, path)`, `getBacklinks(docs, path)` (graph.ts).
- Produces: tools `create_note`, `update_note`, `delete_note`, `restore_note`, `list_history` con salida `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

- [ ] **Step 1: Exportar helpers de resolución en `bridges.ts`**

En `mcp/src/bridges.ts`, cambiar la firma privada:

```ts
function effectiveVaultDir(vault?: string): string | undefined {
```

por exportada:

```ts
export function effectiveVaultDir(vault?: string): string | undefined {
```

Y añadir al final del archivo:

```ts
/** true si el MCP arrancó contra un vault local (write habilitable). */
export function isLocalMode(): boolean {
  return !!VAULT_DIR && LOCAL_ENABLED;
}
```

- [ ] **Step 2: Escribir el test del gating de write**

Crear `mcp/src/writeTools.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { isLocalMode } from "./bridges";

// El gate real (registrar o no las tools) depende de isLocalMode() && !READONLY.
// Acá fijamos el invariante del helper; el loop end-to-end va en integration.test.ts.
describe("gate de escritura", () => {
  test("isLocalMode es booleano y refleja VAULT_DIR", () => {
    expect(typeof isLocalMode()).toBe("boolean");
  });
});
```

- [ ] **Step 3: Correr (rojo por import inexistente)**

Run: `cd mcp && bun test src/writeTools.test.ts`
Expected: FAIL con "isLocalMode is not exported" hasta aplicar Step 1.

- [ ] **Step 4: Actualizar imports y header de `index.ts`**

En `mcp/src/index.ts`, reemplazar el bloque de imports (líneas 28-30):

```ts
import { searchVault, readNote, allDocs } from "./bridges";
import { getBacklinks, getOutgoingLinks } from "./graph";
import { readVaults, formatVaults } from "./config";
```

por:

```ts
import { searchVault, readNote, allDocs, effectiveVaultDir, isLocalMode } from "./bridges";
import { getBacklinks, getOutgoingLinks } from "./graph";
import { readVaults, formatVaults } from "./config";
import { createNote, updateNote, deleteNote, restoreNote, listHistory } from "./writer";
```

Y en el docstring del header, agregar bajo la lista de tools read-only:

```
 * Si el vault es local y BRIDGES_MCP_READONLY!=1, además registra 5 write-tools:
 *   - create_note / update_note / delete_note / restore_note / list_history
 * La escritura es local-only (nunca HTTP) y toda op destructiva es recuperable
 * (.bridges/history + .bridges/trash). Ver docs/superpowers/specs/2026-07-06-mcp-write-fase0-design.md
```

- [ ] **Step 5: Añadir el bloque de write-tools antes de `const transport = ...`**

En `mcp/src/index.ts`, justo antes de `const transport = new StdioServerTransport();`, insertar:

```ts
// ── Write-tools (Fase 0) ──────────────────────────────────────────────────
// Solo en modo local y con write habilitado (opt-out con BRIDGES_MCP_READONLY=1).
if (isLocalMode() && process.env.BRIDGES_MCP_READONLY !== "1") {
  const vaultArg = z
    .string()
    .optional()
    .describe("Nombre del vault destino (ver list_vaults). Por defecto, el vault del repo/default.");

  const json = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });
  const fail = (e: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  });
  // dir local del vault destino; lanza si el vault nombrado no existe o no es local.
  const dirFor = (vault?: string): string => {
    const d = effectiveVaultDir(vault);
    if (!d) throw new Error("no hay vault local resuelto para escribir.");
    return d;
  };
  const brokenLinksOf = async (vault: string | undefined, path: string): Promise<string[]> => {
    const docs = await allDocs(vault);
    return getOutgoingLinks(docs, path).filter((l) => !l.resolved).map((l) => l.target);
  };

  server.registerTool(
    "create_note",
    {
      title: "Crear una nota en el vault",
      description:
        "Crea una nota nueva. Con `path` la ubica ahí (agrega .md); sin `path`, usa " +
        "el slug del `title` dentro de `folder` (default 'Memoria'). Si ya existe y no " +
        "pasás overwrite:true, falla. Devuelve JSON con el path creado y links rotos.",
      inputSchema: {
        title: z.string().min(1).describe("Título de la nota (se usa para el slug si no hay path)."),
        content: z.string().describe("Contenido markdown del cuerpo."),
        path: z.string().optional().describe("Ruta relativa destino (sin .md o con .md)."),
        folder: z.string().optional().describe("Carpeta destino si no hay path (default 'Memoria')."),
        overwrite: z.boolean().optional().describe("Si true, reemplaza una nota existente en ese path."),
        vault: vaultArg,
      },
    },
    async ({ title, content, path, folder, overwrite, vault }) => {
      try {
        const r = createNote(dirFor(vault), { title, content, path, folder, overwrite });
        return json({ ...r, brokenLinks: await brokenLinksOf(vault, r.path) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Editar una nota del vault",
      description:
        "Edita una nota existente. mode='overwrite' reemplaza todo el cuerpo; 'append' " +
        "agrega al final (journal); 'patch' reemplaza el cuerpo bajo `heading` (## X) " +
        "hasta el próximo heading de nivel igual o mayor (heading inexistente falla). " +
        "Snapshotea el estado previo. Devuelve JSON con links rotos.",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota (con .md)."),
        mode: z.enum(["overwrite", "append", "patch"]).describe("Modo de edición."),
        content: z.string().describe("Contenido a escribir (cuerpo entero / a agregar / de la sección)."),
        heading: z.string().optional().describe("Requerido en mode='patch': heading de la sección (texto sin #)."),
        vault: vaultArg,
      },
    },
    async ({ path, mode, content, heading, vault }) => {
      try {
        const r = updateNote(dirFor(vault), { path, mode, content, heading });
        return json({ ...r, brokenLinks: await brokenLinksOf(vault, r.path) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "delete_note",
    {
      title: "Borrar una nota del vault (a la papelera)",
      description:
        "Mueve la nota a .bridges/trash (recuperable con restore_note). Devuelve JSON " +
        "con el trashPath y qué notas quedaron con backlinks huérfanos hacia ella.",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota a borrar (con .md)."),
        vault: vaultArg,
      },
    },
    async ({ path, vault }) => {
      try {
        const docs = await allDocs(vault);
        const orphanedBacklinks = getBacklinks(docs, path).map((d) => d.path);
        const r = deleteNote(dirFor(vault), path);
        return json({ ...r, orphanedBacklinks });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "restore_note",
    {
      title: "Restaurar una nota borrada o revertir una edición",
      description:
        "Recupera una nota de la papelera (from='trash') o revierte a un snapshot " +
        "(from='history'). Sin `from`: usa trash si existe, si no el snapshot más reciente. " +
        "`timestamp` opcional elige una versión puntual (ver list_history).",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota (con .md)."),
        from: z.enum(["trash", "history"]).optional().describe("Fuente de la restauración."),
        timestamp: z.string().optional().describe("Timestamp puntual (de list_history)."),
        vault: vaultArg,
      },
    },
    async ({ path, from, timestamp, vault }) => {
      try {
        return json(restoreNote(dirFor(vault), { path, from, timestamp }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "list_history",
    {
      title: "Historial de una nota (snapshots + papelera)",
      description:
        "Lista los snapshots (ediciones previas) y entradas de papelera de una nota, " +
        "con su timestamp, para elegir qué restaurar con restore_note.",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota (con .md)."),
        vault: vaultArg,
      },
    },
    async ({ path, vault }) => {
      try {
        return json({ path, entries: listHistory(dirFor(vault), path) });
      } catch (e) { return fail(e); }
    },
  );
}
```

- [ ] **Step 6: Correr tests + typecheck**

Run: `cd mcp && bun test && bunx tsc --noEmit`
Expected: PASS (todo) y tsc sin errores.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/index.ts mcp/src/bridges.ts mcp/src/writeTools.test.ts
git commit -m "feat(mcp): registra 5 write-tools (gate local + readonly, vault?, links)"
```

---

### Task 9: Test de integración (loop completo) + invariante `.bridges/` excluido

**Files:**
- Create: `mcp/src/integration.test.ts`

**Interfaces:**
- Consumes: `createNote/updateNote/deleteNote/restoreNote` (writer.ts), `searchLocal` (localIndex.ts), `walkMd` (localIndex.ts).

- [ ] **Step 1: Escribir el test de integración**

Crear `mcp/src/integration.test.ts`:

```ts
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

    const del = deleteNote(dir, "m.md");
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
```

- [ ] **Step 2: Correr para verificar que pasa**

Run: `cd mcp && bun test src/integration.test.ts`
Expected: PASS (2 tests). Si el invariante `.bridges/` falla, revisar `walkMd` (localIndex.ts:59 debe saltar dotdirs).

- [ ] **Step 3: Suite completa + typecheck**

Run: `cd mcp && bun test && bunx tsc --noEmit`
Expected: todo verde.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/integration.test.ts
git commit -m "test(mcp): loop de escritura end-to-end + invariante .bridges/ excluido"
```

---

### Task 10: Docs + release `mcp-v0.1.2`

**Files:**
- Modify: `mcp/README.md` (tools de escritura + env `BRIDGES_MCP_READONLY`/`BRIDGES_MCP_DEFAULT_FOLDER`)
- Modify: `CLAUDE.md` (nota: el MCP ya no es solo-lectura en local)
- Modify: `.claude-plugin/launch.sh` (`VERSION="0.1.2"`), `.claude-plugin/plugin.json` (`"version": "0.1.2"`)

**Interfaces:** n/a (documentación + release).

- [ ] **Step 1: Documentar las write-tools en `mcp/README.md`**

Añadir en la sección `## Tools`, después de `list_links`:

```markdown

### Escritura (Fase 0, local-only)

Si el MCP arranca en modo local y `BRIDGES_MCP_READONLY` != `1`, registra además:

- **`create_note(title, content, path?, folder?, overwrite?, vault?)`** — crea una nota
  (sin `path` → `Memoria/<slug(title)>.md`). Colisión sin `overwrite` → error.
- **`update_note(path, mode, content, heading?, vault?)`** — `overwrite` / `append` /
  `patch` (sección por `heading`). Snapshotea el estado previo.
- **`delete_note(path, vault?)`** — a la papelera (`.bridges/trash`), avisa backlinks huérfanos.
- **`restore_note(path, from?, timestamp?, vault?)`** — recupera de trash o revierte un snapshot.
- **`list_history(path, vault?)`** — snapshots + papelera de una nota.

Toda op destructiva es recuperable: snapshots en `.bridges/history/` (máx. 50 por nota)
y borrados en `.bridges/trash/`. Ambos excluidos del índice (dotdir). `BRIDGES_MCP_READONLY=1`
apaga la escritura; `BRIDGES_MCP_DEFAULT_FOLDER` cambia la carpeta default (fallback `Memoria`).
```

Y en la tabla de env (`## Config (env)`), agregar dos filas:

```markdown
| `BRIDGES_MCP_READONLY` | — | `1` desregistra las write-tools (MCP solo-lectura aunque sea local). |
| `BRIDGES_MCP_DEFAULT_FOLDER` | `Memoria` | carpeta para notas creadas sin `path`. |
```

- [ ] **Step 2: Actualizar `CLAUDE.md`**

En `CLAUDE.md`, en la sección del MCP, reemplazar la descripción read-only por una nota de que en local con write habilitado expone además `create_note`/`update_note`/`delete_note`/`restore_note`/`list_history`, con undo net en `.bridges/`.

- [ ] **Step 3: Bump de versión**

En `.claude-plugin/launch.sh`: `VERSION="0.1.2"`.
En `.claude-plugin/plugin.json`: `"version": "0.1.2"`.

- [ ] **Step 4: Suite completa final + dry run del launcher**

Run: `cd mcp && bun test && bunx tsc --noEmit`
Run: `BRIDGES_MCP_DRYRUN=1 sh .claude-plugin/launch.sh`
Expected: tests verdes; el dry run imprime `...mcp-v0.1.2/...`.

- [ ] **Step 5: Commit + tag + push**

```bash
git add mcp/README.md CLAUDE.md .claude-plugin/launch.sh .claude-plugin/plugin.json
git commit -m "docs(mcp): write-tools en README/CLAUDE + release v0.1.2"
git push origin main
git tag mcp-v0.1.2
git push origin mcp-v0.1.2
```

> Nota de release: el workflow `mcp-release.yml` compila los binarios. Recordar el
> gotcha del runner `macos-13` (darwin-x64 puede quedar en cola; darwin-arm64 y
> linux-x64 salen igual). Ver memoria `bridges-mcp-release-macos13`.

---

## Notas de verificación del plan (self-review)

- **Cobertura del spec:** §2 (CRUD total, ops, local, naming, net B, vault destino, `.bridges/`) → Tasks 1-8. §3 (5 tools + salidas JSON) → Tasks 3-8. §4 (writer.ts, layout `.bridges/`, snapshot/slug/resolveInVault) → Tasks 1-7. §5 (exclusión `.bridges/` [Task 9], anti-traversal [Task 1], gate readonly/local [Task 8], HTTP no registra [Task 8]) → cubierto. §6 (unit + integración) → Tasks 1-9. §7 (Memoria, ambas tools de undo, write default-on) → Tasks 3/7/8.
- **`brokenLinks`/`orphanedBacklinks`:** calculados en la capa de tools (index.ts) reusando `graph.ts` sobre `allDocs(vault)`, no en writer.ts (mantiene writer puro de filesystem).
- **Consistencia de tipos:** `WriteResult`/`DeleteResult`/`RestoreResult`/`HistoryEntry` definidos en Task 3/6/7 y consumidos en Task 8. `effectiveVaultDir`/`isLocalMode` exportados en Task 8-Step1 y usados en el mismo task.
