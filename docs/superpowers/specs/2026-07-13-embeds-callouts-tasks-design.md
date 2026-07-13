# Embeds `![[ ]]` + Callouts `> [!tipo]` + Tareas interactivas — Design

**Fecha:** 2026-07-13
**Proyecto:** Bridges (server Bun + bun:sqlite, cliente SolidJS + Tauri)

## Contexto

El render de markdown del preview vive en `client/src/lib/markdown.ts`: usa el **singleton global**
`marked` (`marked@15.0.12`) con dos extensiones inline propias — `wikilink` (`[[nota]]` →
`<a data-doc-id>` o `<span wikilink-missing>`) y `tag` (`#tag` → `<a data-tag>`) — más `gfm: true`.
`renderMarkdown(md)` hace `marked.parse(stripFrontmatter(md))` y **sanitiza con
`DOMPurify.sanitize(html)`** (config default: conserva `class`/`data-*`, permite `input`, `svg`,
`path`; elimina `<script>`, handlers inline, iframes).

Wiring del preview y guardado (`client/src/App.tsx`):

- `preview()` es un `createMemo`: setea el resolver de wikilinks (`setWikiResolver(createResolver(docs()))`)
  y devuelve `renderMarkdown(draft())`. Solo recomputa cuando cambia `draft()`.
- Se pinta con `<div class="prose-bridges" innerHTML={preview()} onClick={onPreviewClick} />`.
- `onPreviewClick` ya delega por `target.closest(...)`: `[data-tag]` → busca ese tag; `[data-doc-id]`
  → navega a la nota.
- Estado de edición: `draft`/`setDraft`, `dirty`/`setDirty`, `baseVersion`, `onSave` (llama
  `saveDoc({id, path, content: draft(), base_version})`; en 409 abre `ConflictDialog`).
- El resolver (`createResolver`, `client/src/lib/links.ts`) devuelve el `Doc` completo (incluye
  `.content`) por basename o path.

Helpers puros de estructura markdown ya viven en `links.ts` (`parseHeadings`, `normalizeTarget`,
`parseWikilinks`, `buildBacklinks`) y están cubiertos por Vitest (`links.test.ts`, config en
`vite.config.ts` — plan 003).

Hoy **no** hay: embeds/transclusión (`![[...]]`), callouts (solo `blockquote` plano en `app.css`),
ni tareas interactivas (`- [ ]` renderiza como checkbox **`disabled`** de GFM, no togglea).

## Objetivo

Sumar al preview, con paridad Obsidian:

1. **Embeds** `![[Nota]]` (nota entera) y `![[Nota#Heading]]` (una sección), encajonados y navegables.
2. **Callouts** `> [!tipo] Título` con icono + color y colapsables (`[!tipo]-` / `+`).
3. **Tareas interactivas**: clic en un `- [ ]` del preview togglea el source de la nota y guarda.

Alcance cerrado con el usuario: sin live-preview (solo el preview HTML), embeds anidados capados a
profundidad 1, y el toggle de tarea solo aplica a las tareas de la nota actual (no a las embebidas).

## Arquitectura del renderer — dos instancias `marked` aisladas

Se reemplaza el uso del singleton global por **dos instancias `new Marked()`** (soportado en v15;
validado). Un factory las construye con la misma configuración base y de extensiones, difiriendo solo
en dos comportamientos:

```ts
// createRenderer(opts): Marked  — en markdown.ts (no exportado)
//   opts.interactiveTasks: checkbox habilitado + data-task="N" (contador)  |  checkbox disabled sin index
//   opts.expandEmbeds:     ![[ ]] expande el contenido del target          |  ![[ ]] se renderiza como link (corta la recursión)

const embedMd = createRenderer({ interactiveTasks: false, expandEmbeds: false });
const mainMd  = createRenderer({ interactiveTasks: true,  expandEmbeds: true  }); // su extensión embed llama embedMd.parse(...)
```

`renderMarkdown(md)` pasa a: resetear el contador de tareas (`renderState.taskIndex = 0`, módulo-level,
mismo patrón que el `resolver`), `mainMd.parse(stripFrontmatter(md))`, `DOMPurify.sanitize`.

**Por qué dos instancias y no flags en una sola:** el embed renderiza el contenido del target
llamando `embedMd.parse(...)` de forma reentrante desde dentro de `mainMd.parse(...)`. Al ser
instancias separadas (state de lexer/parser propio; el contador de tareas es una var de módulo que
solo lee/incrementa el checkbox renderer de `mainMd`), la recursión no contamina el índice de tareas
de la nota actual ni puede entrar en loop (los embeds anidados de `embedMd` se renderizan como link).
El único estado compartido en parse-time es el `resolver` (solo lectura). Validado: instancias
aisladas + reentrancia OK.

## Feature 1 — Callouts (extensión block)

Extensión **block-level** en cada instancia:

```
> [!warning] Título opcional
> cuerpo (markdown: listas, [[wikilinks]], #tags, tareas…)
```

- `start(src)`: índice de `^ *> *\[!` (multilínea).
- `tokenizer(src)`: matchea el bloque `>`-prefijado cuya primera línea es `[!tipo]`. Captura `tipo`,
  marcador de fold (`-` colapsado / `+` expandido / vacío = no colapsable) y `título`. Al cuerpo le
  quita el prefijo `> ` de cada línea y lo lexea recursivo con `this.lexer.blockTokens(body)`.
- `renderer(token)`: `this.parser.parse(token.tokens)` para el HTML interno (así las tareas/tags/
  wikilinks del cuerpo, **de la nota actual**, funcionan por la misma instancia). Emite:

```html
<div class="callout callout-warning" data-callout="warning" data-fold="collapsed">
  <div class="callout-title"><svg class="callout-icon">…</svg><span>Título</span><svg class="callout-caret">…</svg></div>
  <div class="callout-body">…html interno…</div>
</div>
```

- **Set curado** (tipo desconocido → `note`): `note, info, tip, success, question, warning, danger,
  quote`. Mapa `tipo → { icono SVG inline, clase de color }`. Título por defecto = capitalizado del
  tipo si no hay título explícito.
- **Fold**: `data-fold` presente solo si hubo marcador. `[!x]-` → arranca con clase `is-collapsed`;
  `[!x]+` → expandido pero colapsable (se muestra el caret). Sin marcador → sin caret, no colapsable.
  El caret solo se emite si `data-fold` está presente.

## Feature 2 — Tareas interactivas

**Render** (solo en `mainMd`): se sobreescribe `renderer.checkbox({ checked })` para emitir
`<input type="checkbox" data-task="N"${checked?' checked':''}>` (sin `disabled`), con
`N = renderState.taskIndex++`. En `embedMd` el checkbox renderer emite `<input type="checkbox" disabled${checked?' checked':''}>`
(sin `data-task`) → las tareas embebidas se ven pero no togglean ni corren el índice.

Validado: `marked@15` invoca `renderer.checkbox` **una vez por tarea bullet, en orden de documento,
salteando code fences** → el contador da `data-task=0,1,2…` alineado con el orden en que
`toggleTaskAtIndex` escanea el source.

**Toggle-back** (`onPreviewClick`, rama nueva): clic en `input[data-task]` → `n = +data-task` →
`setDraft(toggleTaskAtIndex(draft(), n)); setDirty(true); onSave()`. `e.preventDefault()` para que el
toggle nativo del checkbox no pelee con el re-render (el memo `preview()` recomputa desde el draft
nuevo y refleja el estado). El guardado usa el path optimista existente; 409 → `ConflictDialog`.

## Feature 3 — Embeds (extensión inline)

Extensión **inline** en cada instancia (`start` en `![[`, tokenizer `^!\[\[([^\]]+)\]\]`).

- Resuelve el target con el `resolver` global (mismo que `wikilink`). `normalizeTarget` saca alias y
  `#`; se conserva el heading por separado para `extractSection`.
- **`mainMd` (expandEmbeds: true)** renderer:
  - target inexistente → `<div class="embed embed-missing">No se encontró: «target»</div>`.
  - con `#heading`: `body = extractSection(doc.content, heading)`; si `null` →
    `<div class="embed"><…título…><div class="embed-body embed-missing">Sección «heading» no encontrada</div></div>`.
  - sin heading: `body = stripFrontmatter(doc.content)`.
  - `inner = embedMd.parse(body)` (tareas disabled; embeds anidados → link = cap de profundidad 1).
  - Emite:
    ```html
    <div class="embed" data-doc-id="ID">
      <div class="embed-title"><a data-doc-id="ID">Nombre de la nota</a></div>
      <div class="embed-body">…inner…</div>
    </div>
    ```
    El título navega por la rama `[data-doc-id]` existente de `onPreviewClick`.
- **`embedMd` (expandEmbeds: false)** renderer: no expande; emite el link estilo wikilink
  (`<a class="wikilink" data-doc-id>` o `wikilink-missing`). Corta la recursión: A embebe B, pero los
  `![[ ]]` dentro de B se ven como links (no se expanden), así que ciclos A→B→A no ocurren.

## Helpers puros (`client/src/lib/links.ts`)

Dos funciones nuevas, puras y testeables (misma casa que `parseHeadings`):

```ts
/** Devuelve el markdown de la sección `heading` (incluye la línea del heading) hasta el próximo
 *  heading de nivel igual o mayor. Ignora code fences. null si no se encuentra. */
export function extractSection(content: string, heading: string): string | null

/** Flipea [ ]<->[x] en la n-ésima tarea bullet (`- [ ]`) del markdown, en orden de documento,
 *  salteando code fences. Devuelve el md sin cambios si n está fuera de rango. */
export function toggleTaskAtIndex(md: string, n: number): string
```

`toggleTaskAtIndex` usa `/^(\s*[-*+]\s+\[)([ xX])(\].*)$/` por línea, con tracking de fence; "checked"
= el char no es espacio. Comparte con el checkbox renderer la definición de "tarea" (bullet + fence
skip); un test fija el invariante contra el render real de `marked`.

## `onPreviewClick` (`App.tsx`) — orden de ramas

Antes de las ramas actuales:

1. `target.closest("input[data-task]")` → `preventDefault`; toggle + save (arriba). `return`.
2. `target.closest(".callout-title")` cuyo `.callout` padre tenga `[data-fold]` →
   `callout.classList.toggle("is-collapsed")`. `return`.
3. (existente) `[data-tag]` → `onSearch("#"+tag)`.
4. (existente) `[data-doc-id]` → navega (cubre título de embed + wikilinks).

El fold es **efímero** (clase en el DOM, no se escribe al `.md`); se resetea cuando `preview()`
recomputa por una edición. Igual que Obsidian (el estado de fold no vive en el archivo).

## CSS (`client/src/app.css`)

- `.callout`: borde izquierdo de color, fondo tenue, radio, padding; `.callout-title` (flex, gap,
  peso, cursor pointer si colapsable), `.callout-icon`/`.callout-caret` (tamaño, color del tipo),
  `.callout-body`. `.callout.is-collapsed .callout-body { display: none }` y rotación del caret.
  Un color por tipo (HSL fijo): info/tip azul-cian, success/question verde, warning ámbar, danger rojo
  (reusa `--primary`), note/quote gris (`--muted-foreground`).
- `.embed`: borde suave, radio, padding, `margin` de bloque; `.embed-title` (link, muted, pequeño),
  `.embed-body`, `.embed-missing` (muted/itálica).
- `.prose-bridges input[type=checkbox]`: `cursor: pointer`, `accent-color: hsl(var(--primary))`,
  alineación con el texto del ítem.

## Edge cases

- **Tareas / callouts dentro de code fences**: no se renderizan como tal (marked los deja literales);
  `toggleTaskAtIndex` y `extractSection` saltean fences para no desalinear el índice ni cortar mal.
- **Índice de tarea con embeds antes**: los checkboxes de embeds no llevan `data-task` ni corren el
  contador → `data-task=N` mapea a la N-ésima tarea del `draft()`. Consistente.
- **Toggle con edición sin guardar**: si el draft está `dirty` (se editó y se pasó a preview sin
  guardar), el toggle guarda el draft completo (incluye lo no guardado). Esperado. 409 → `ConflictDialog`.
- **Embed a sección inexistente**: caja de embed con cuerpo "Sección no encontrada" (no rompe el render).
- **Ciclo de embeds** (A↔B): cortado por el cap de profundidad 1 (embed dentro de embed → link).
- **Callout sin título**: título = tipo capitalizado. **Tipo desconocido**: cae a `note`.
- **Sanitización**: `input[type=checkbox][data-task]` y los SVG de iconos están en el allowlist default
  de DOMPurify (validado); no se agregan handlers inline (todo por delegación en `onPreviewClick`), así
  que la CSP del plan 001 no se toca.

## Tests (Vitest, ya configurado; `cd client && bun run test`)

`client/src/lib/links.test.ts` (extender):
- `extractSection`: devuelve la sección hasta el próximo heading de nivel ≤; incluye la línea del
  heading; ignora un heading homónimo dentro de un fence; `null` si no existe.
- `toggleTaskAtIndex`: flipea `[ ]→[x]` y `[x]→[ ]` en el índice correcto; saltea tareas en fences;
  fuera de rango → sin cambios.

`client/src/lib/markdown.test.ts` (nuevo):
- **Callouts**: `> [!warning] t` → `.callout-warning` con `data-callout` y título; tipo desconocido →
  `note`; `[!x]-` → `is-collapsed` + `data-fold`; sin marcador → sin caret.
- **Tareas**: `renderMarkdown` de N tareas bullet → `data-task="0..N-1"` en orden, sin `disabled`;
  tarea en fence no genera checkbox; **invariante**: para cada N, `toggleTaskAtIndex(src, N)` flipea la
  misma línea que el `data-task=N` renderizado.
- **Embeds**: `![[Nota]]` con resolver mock → `.embed` con `data-doc-id` y el contenido; `![[Nota#H]]`
  → solo la sección; target inexistente → `.embed-missing`; embed anidado (B tiene `![[C]]`) → dentro
  del embed de B, C aparece como link, no expandido (cap de profundidad); tarea dentro de un embed →
  `disabled`, sin `data-task`.
- **Sanitización**: el HTML final de una tarea y de un callout con icono conserva
  `input[type=checkbox][data-task]` y el `<svg>` tras `DOMPurify`.

Verificación adicional: `tsc` (typecheck del cliente) y **smoke manual** en `tauri dev`: togglear una
tarea persiste al reabrir la nota; un callout `[!warning]-` colapsa/expande al click; `![[Nota#H]]`
muestra solo esa sección y el título navega.

## Fuera de alcance (anotado, no se construye)

- **Live-preview** (WYSIWYG híbrido en el editor CodeMirror): sigue el toggle edit/preview actual.
- **Block refs** `![[Nota#^id]]` y anclas `^id`: requieren extender el modelo de contenido; no v1.
- **Embeds de imágenes/adjuntos** `![[img.png]]`: el vault es `.md`-only.
- **Tareas de lista ordenada** (`1. [ ]`): solo bullets (`- [ ]`), como GFM.
- **Persistir el estado de fold** de callouts al archivo: efímero, igual que Obsidian.
- **Recursión de embeds > 1 nivel**: capada a 1 a propósito.

## Criterios de éxito

1. `![[Nota]]` en el preview muestra el contenido de la nota encajonado; el título navega a ella.
2. `![[Nota#Heading]]` muestra **solo** esa sección; sección/nota inexistente muestra la caja de error
   sin romper el render.
3. `> [!warning] Título` renderiza con icono + color; `[!x]-` colapsa y expande al click; el cuerpo
   soporta markdown (listas, wikilinks, tags, tareas).
4. Clic en un `- [ ]` del preview lo togglea, edita el source de la nota y guarda (409 → ConflictDialog);
   al reabrir la nota el estado persiste.
5. Las tareas dentro de un embed se ven pero no son toggleables; el índice de tareas de la nota actual
   no se corre por embeds.
6. `bun run test` (nuevos + existentes) y `tsc` en verde; sanitización conserva checkboxes y SVG.
