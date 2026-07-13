# Grafo con post-proceso CRT / dither — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Darle al grafo de notas un look pixelart/retro CRT (ordered dithering Bayer 8×8 + paleta reducida + pixelado fino + scanlines), renderizado siempre sobre fondo oscuro, con labels monospace nítidos.

**Architecture:** Se introduce un pipeline de tres buffers dentro de `GraphView.tsx` — `scene` (offscreen a resolución CSS) → `low` (offscreen a `W/PIXEL`, downsample antialiaseado + pasada de dither por CPU) → `canvas` visible (upscale nearest-neighbor + labels crisp encima). La matemática pura del dither (matriz Bayer + cuantización) se extrae a `client/src/lib/dither.ts` para poder testearla. La lógica de fuerzas, sistema solar, hover, drag, zoom y pan **no se toca** (trabaja en coordenadas de mundo, antes del pixelado).

**Tech Stack:** SolidJS, Canvas 2D (`getImageData`/`putImageData`), Vitest. Sin dependencias nuevas.

## Global Constraints

- **Sin dependencias nuevas** ni controles nuevos en la UI (ni toggle ni sliders).
- **Constantes fijas** (config validada en el prototipo): `PIXEL = 2`, `LEVELS = 6`, `SCANLINES = 0.4`.
- **Matriz Bayer 8×8**: permutación de los enteros `0..63` (64 valores, cada uno una vez).
- **Fórmula de dither por píxel/canal RGB** (alpha intacto), idéntica al prototipo:
  - `bm = (BAYER8[(y&7)*8 + (x&7)] + 0.5) / 64 − 0.5`  → umbral en `[−0.5, 0.5)`
  - `q = clamp(round(v * (LEVELS−1) + bm), 0, LEVELS−1)`  con `v = canal/255`
  - `canal' = (q / (LEVELS−1)) * 255`
  - **Scanline:** en filas impares del grid low-res (`y & 1`), multiplicar el RGB resultante por `1 − SCANLINES` (= 0.6).
- **Siempre oscuro:** el grafo se renderiza sobre la paleta oscura del design system sin importar el tema de la app; se logra poniendo `class="dark"` en el wrapper y leyendo los tokens desde ahí (no desde `document.documentElement`). Nada de HSL hardcodeados sueltos.
- **Fuente de labels:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (reemplaza la sans-serif actual).
- Archivos tocados: `client/src/lib/dither.ts` (nuevo, + test) y `client/src/components/GraphView.tsx` (refactor). Nada más.
- Comandos del proyecto: `cd client && npm run test`, `cd client && npm run typecheck`, `cd client && npm run dev`.

---

## File Structure

- **Create** `client/src/lib/dither.ts` — constantes de config (`PIXEL`, `LEVELS`, `SCANLINES`), la matriz `BAYER8`, y `applyPostProcess(data, width, height)` (pura, in-place sobre un buffer RGBA low-res). Única responsabilidad: la matemática del dither. Testeable sin canvas.
- **Create** `client/src/lib/dither.test.ts` — tests unitarios de la matriz y de `applyPostProcess`.
- **Modify** `client/src/components/GraphView.tsx` — (1) lectura de tokens siempre-oscura; (2) pipeline de buffers y split de `draw()` en `litContext()` + `drawScene()` + `drawLabels()` + el `draw()` orquestador.

---

## Task 1: Módulo puro de dither (`lib/dither.ts`)

**Files:**
- Create: `client/src/lib/dither.ts`
- Test: `client/src/lib/dither.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `export const PIXEL = 2`
  - `export const LEVELS = 6`
  - `export const SCANLINES = 0.4`
  - `export const BAYER8: number[]` (length 64)
  - `export function applyPostProcess(data: Uint8ClampedArray, width: number, height: number): void` — modifica `data` in-place (RGBA de un `ImageData` de tamaño `width × height`).

- [ ] **Step 1: Escribir el test que falla**

Create `client/src/lib/dither.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BAYER8, LEVELS, SCANLINES, applyPostProcess } from "./dither";

describe("BAYER8", () => {
  it("es una permutación de 0..63 (64 valores únicos)", () => {
    expect(BAYER8.length).toBe(64);
    expect(new Set(BAYER8).size).toBe(64);
    const sorted = [...BAYER8].sort((a, b) => a - b);
    expect(sorted[0]).toBe(0);
    expect(sorted[63]).toBe(63);
  });
});

describe("applyPostProcess", () => {
  // Paleta esperada tras cuantizar a LEVELS niveles: round(q/(LEVELS-1)*255) para q en 0..LEVELS-1
  const palette = Array.from({ length: LEVELS }, (_, q) => Math.round((q / (LEVELS - 1)) * 255));

  const uniform = (w: number, h: number, value: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      data[o] = data[o + 1] = data[o + 2] = value;
      data[o + 3] = 255;
    }
    return data;
  };

  it("cuantiza cada canal a la paleta y deja el alpha intacto (fila par, sin scanline)", () => {
    const w = 8, h = 1; // solo y=0 → fila par → sin atenuación de scanline
    const data = uniform(w, h, 140);
    applyPostProcess(data, w, h);
    for (let x = 0; x < w; x++) {
      const o = x * 4;
      expect(palette).toContain(data[o]);     // R snapped a la paleta
      expect(palette).toContain(data[o + 1]); // G
      expect(palette).toContain(data[o + 2]); // B
      expect(data[o + 3]).toBe(255);          // alpha intacto
    }
  });

  it("las filas impares (scanline) quedan más oscuras que las pares en promedio", () => {
    const w = 8, h = 2;
    const data = uniform(w, h, 180);
    applyPostProcess(data, w, h);
    const rowMean = (y: number) => {
      let s = 0;
      for (let x = 0; x < w; x++) s += data[(y * w + x) * 4];
      return s / w;
    };
    // row1 ≈ (1 - SCANLINES) × row0; margen holgado para absorber la varianza del dithering
    expect(rowMean(1)).toBeLessThan(rowMean(0) * (1 - SCANLINES / 2));
    expect(SCANLINES).toBeGreaterThan(0);
  });

  it("es determinista (mismo input → mismo output)", () => {
    const a = uniform(8, 8, 100);
    const b = uniform(8, 8, 100);
    applyPostProcess(a, 8, 8);
    applyPostProcess(b, 8, 8);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd client && npm run test -- dither`
Expected: FAIL — `Failed to resolve import "./dither"` (el módulo aún no existe).

- [ ] **Step 3: Escribir la implementación mínima**

Create `client/src/lib/dither.ts`:

```ts
// Post-proceso CRT / dither del grafo. Config validada en el prototipo: pixel 2 · niveles 6 · scanlines 40%.

/** Factor de pixelado: la escena se downsamplea a W/PIXEL antes del blit nearest-neighbor. */
export const PIXEL = 2;
/** Niveles de cuantización por canal RGB. */
export const LEVELS = 6;
/** Atenuación de las filas impares del grid low-res (scanlines). */
export const SCANLINES = 0.4;

/**
 * Matriz Bayer 8×8 para ordered dithering: permutación de 0..63, cada valor una vez.
 * El orden define el patrón espacial de umbrales que convierte gradientes en tramas de píxeles.
 */
export const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/**
 * Aplica ordered dithering (Bayer 8×8) + cuantización a LEVELS + scanlines, in-place,
 * sobre el buffer RGBA de un ImageData low-res. Alpha intacto. Idéntico al prototipo aprobado.
 */
export function applyPostProcess(data: Uint8ClampedArray, width: number, height: number): void {
  const levels = LEVELS - 1;
  const dim = 1 - SCANLINES;
  for (let y = 0; y < height; y++) {
    const scan = y & 1 ? dim : 1;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const bm = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 - 0.5;
      for (let ch = 0; ch < 3; ch++) {
        const v = data[idx + ch] / 255;
        const q = Math.min(levels, Math.max(0, Math.round(v * levels + bm)));
        data[idx + ch] = (q / levels) * 255 * scan; // Uint8ClampedArray redondea y satura
      }
      // data[idx + 3] (alpha) queda intacto
    }
  }
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `cd client && npm run test -- dither`
Expected: PASS (los 4 tests en verde).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/dither.ts client/src/lib/dither.test.ts
git commit -m "feat(grafo): módulo puro de dither Bayer 8x8 + cuantización + scanlines"
```

---

## Task 2: Grafo siempre oscuro (tokens desde el wrapper)

**Files:**
- Modify: `client/src/components/GraphView.tsx` (`token()` en :34-37, `refreshColors()` en :80-100, JSX del wrapper en :651)

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces: el objeto de closure `C` con `C.isDark === true` de forma efectiva y todos los tokens resueltos a sus valores **oscuros**, independientemente del tema de la app. Firma nueva: `token(el: Element, name: string, alpha?: number): string`.

**Contexto:** `client/src/app.css` define `.dark { --background/--foreground/... }`. Poniendo `class="dark"` en `wrap` y leyendo con `getComputedStyle(wrap)`, los custom properties resuelven a los valores oscuros aunque `document.documentElement` esté en tema claro. `token()` hoy se usa **solo** dentro de `refreshColors()`.

- [ ] **Step 1: Cambiar la firma de `token()` para leer desde un elemento**

En `client/src/components/GraphView.tsx`, reemplazar (líneas 34-37):

```ts
function token(name: string, alpha?: number): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
}
```

por:

```ts
function token(el: Element, name: string, alpha?: number): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
}
```

- [ ] **Step 2: Leer los tokens desde `wrap` en `refreshColors()`**

Reemplazar el cuerpo de `refreshColors()` (líneas 80-100) por:

```ts
  function refreshColors() {
    // Los colores solo cambian al alternar tema; con la rotación dibujando en bucle
    // evitamos releer ~12 tokens por frame usando --foreground como huella del tema.
    // Se lee desde `wrap` (class="dark") → los tokens resuelven siempre a la paleta oscura.
    const fg = getComputedStyle(wrap).getPropertyValue("--foreground").trim();
    if (fg === colorKey) return;
    colorKey = fg;
    C = {
      isDark: true, // el efecto CRT es inherentemente fósforo/oscuro (wrap lleva class="dark")
      fg: token(wrap, "--foreground", 0.9),
      fgDim: token(wrap, "--foreground", 0.22),
      fgLabel: token(wrap, "--foreground", 0.88),
      edge: token(wrap, "--foreground", 0.075),
      edgeDim: token(wrap, "--foreground", 0.03),
      edgeLit: token(wrap, "--primary", 0.7),
      primary: token(wrap, "--primary"),
      phantom: token(wrap, "--muted-foreground", 0.5),
      phantomDim: token(wrap, "--muted-foreground", 0.15),
      bg: token(wrap, "--background", 0.85),
      orbit: token(wrap, "--foreground", 0.06),
    };
  }
```

- [ ] **Step 3: Poner `class="dark"` en el wrapper**

Reemplazar la apertura del `<div ref={wrap} ...>` (línea 651):

```tsx
    <div ref={wrap} class="relative h-full w-full overflow-hidden" style={{ "touch-action": "none" }}>
```

por:

```tsx
    <div ref={wrap} class="dark relative h-full w-full overflow-hidden" style={{ "touch-action": "none" }}>
```

- [ ] **Step 4: Verificar typecheck**

Run: `cd client && npm run typecheck`
Expected: sin errores (la firma nueva de `token()` está bien tipada y no hay otros llamadores).

- [ ] **Step 5: Verificar visualmente (grafo oscuro en tema claro)**

Run: `cd client && npm run dev`
Abrir el grafo con la app en **tema claro**.
Expected: el grafo se ve oscuro (fondo espacio profundo + nebulosa + campo de estrellas presentes), no sobre fondo blanco. En tema oscuro se ve igual que antes.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/GraphView.tsx
git commit -m "feat(grafo): render siempre oscuro leyendo tokens desde el wrapper .dark"
```

---

## Task 3: Pipeline de buffers + split de `draw()` (dither + labels crisp)

**Files:**
- Modify: `client/src/components/GraphView.tsx` — import de `lib/dither`; buffers offscreen; `resize()` (:478-493); refactor de `draw()` (:197-353) en `litContext()` + `drawScene()` + `drawLabels()` + `draw()` orquestador.

**Interfaces:**
- Consumes de Task 1: `import { PIXEL, applyPostProcess } from "~/lib/dither"`.
- Consumes de Task 2: `C.isDark === true` (el fondo de espacio profundo se dibuja siempre).
- Produces: sin API nueva hacia otras tareas; es la tarea final.

**Contexto del flujo por frame:**
```
drawScene(sceneCtx)                     // escena completa SIN labels, coords CSS (sin dpr)
lowCtx.drawImage(scene → low)           // smoothing ON  → downsample antialiaseado a W/PIXEL
applyPostProcess(low.data)              // Bayer + cuantización + scanlines, in-place
visCtx.drawImage(low → canvas)          // smoothing OFF → upscale nearest-neighbor (píxeles duros)
drawLabels(visCtx)                      // monospace crisp, transform de mundo a dpr, sobre todo
```

- [ ] **Step 1: Importar el módulo de dither**

En `client/src/components/GraphView.tsx`, después del import de `GraphControls` (línea 13), agregar:

```ts
import { PIXEL, applyPostProcess } from "~/lib/dither";
```

- [ ] **Step 2: Declarar los buffers offscreen**

Junto a las otras variables de canvas (`let k = 1, tx = 0, ...` cerca de línea 102), agregar:

```ts
  // Buffers del pipeline CRT: scene (coords CSS) → low (W/PIXEL, dither) → canvas visible.
  let scene: HTMLCanvasElement | null = null;
  let low: HTMLCanvasElement | null = null;
  let sceneCtx: CanvasRenderingContext2D | null = null;
  let lowCtx: CanvasRenderingContext2D | null = null;
```

- [ ] **Step 3: Extraer el contexto de iluminación a `litContext()`**

Inmediatamente antes de `function draw()` (línea 197), agregar el helper (comparte la lógica de lit/dimming/búsqueda entre `drawScene` y `drawLabels`, hoy inline en `draw`):

```ts
  // Contexto de resaltado del frame: rotación + qué nodos están "iluminados" (hover/vecinos/búsqueda).
  function litContext() {
    const c = Math.cos(angle), s2 = Math.sin(angle);
    const q = search().trim().toLowerCase();
    const searching = q.length > 0;
    const hi = hovered;
    const neighbors = hi ? adj.get(hi.id) ?? new Set<string>() : null;
    const matches = searching
      ? new Set(nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id))
      : null;
    const isLit = (id: string) => {
      if (hi) return id === hi.id || (neighbors?.has(id) ?? false);
      if (matches) return matches.has(id);
      return true;
    };
    return { c, s2, hi, searching, isLit, dimming: !!hi || searching };
  }
```

- [ ] **Step 4: Reemplazar `draw()` por `drawScene()` + `drawLabels()` + `draw()` orquestador**

Reemplazar toda la función `draw()` actual (líneas 197-353, desde `function draw() {` hasta su `}` de cierre) por lo siguiente. **`drawScene` es el `draw` actual sin el `scale(dpr)`, sin `refreshColors`, sin `getContext` y sin el bloque de labels; `drawLabels` es el bloque de labels con fuente monospace y su propio transform.**

```ts
  // Escena completa (fondo, nebulosa, estrellas, órbitas, edges, nodos) SIN labels.
  // Coordenadas CSS: se dibuja sobre `scene` (W×H, sin dpr); el pixelado hace irrelevante el dpr aquí.
  function drawScene(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // Fondo de espacio profundo: nebulosa central tenue + estrellas (C.isDark siempre true).
    if (C.isDark) {
      const neb = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.62);
      neb.addColorStop(0, "hsl(235 48% 11% / 0.55)");
      neb.addColorStop(1, "hsl(235 48% 11% / 0)");
      ctx.fillStyle = neb;
      ctx.fillRect(0, 0, w, h);
      for (const st of stars) {
        ctx.globalAlpha = st.a;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, TAU);
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.translate(tx, ty);
    ctx.scale(k, k);
    ctx.lineCap = "round";

    const { c, s2, hi, searching, isLit, dimming } = litContext();

    // Anillos de órbita: círculos concéntricos tenues centrados en el núcleo del sistema.
    ctx.strokeStyle = C.orbit;
    ctx.lineWidth = 1 / k;
    ctx.setLineDash([4 / k, 7 / k]);
    for (const frac of [0.32, 0.55, 0.78, 1.02]) {
      ctx.beginPath();
      ctx.arc(0, 0, systemR * frac, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // edges: finas y con una leve curva (mismo sentido) para desenredar el centro.
    for (const l of links) {
      const s = l.source as GraphNode;
      const t = l.target as GraphNode;
      const both = isLit(s.id) && isLit(t.id);
      const emphasize = hi ? s.id === hi.id || t.id === hi.id : searching && both;
      ctx.strokeStyle = emphasize ? C.edgeLit : dimming ? C.edgeDim : C.edge;
      ctx.lineWidth = (emphasize ? 1.0 : 0.4) / k;
      const ax = dispX(s, c, s2), ay = dispY(s, c, s2);
      const bx = dispX(t, c, s2), by = dispY(t, c, s2);
      const cpx = (ax + bx) / 2 - (by - ay) * 0.1;
      const cpy = (ay + by) / 2 + (bx - ax) * 0.1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cpx, cpy, bx, by);
      ctx.stroke();
    }

    // nodes
    for (const n of nodes) {
      const r = nodeRadius(n);
      const lit = isLit(n.id);
      const phantom = n.docId == null;
      const selected = n.docId && n.docId === props.selectedId;
      const i = imp(n);
      const nx = dispX(n, c, s2), ny = dispY(n, c, s2);
      const focus = (hi && hi.id === n.id) || selected || (searching && lit);

      // Corona dorada: los soles irradian calor estelar, creciente con la importancia.
      if (!phantom && lit && i >= 0.5) {
        const cr = r * (2.6 + i * 2.2);
        const grad = ctx.createRadialGradient(nx, ny, r * 0.5, nx, ny, cr);
        grad.addColorStop(0, `hsl(${GLOW_HSL} / ${0.22 * i})`);
        grad.addColorStop(1, `hsl(${GLOW_HSL} / 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(nx, ny, cr, 0, TAU);
        ctx.fill();
      }

      if (focus) {
        ctx.shadowColor = C.primary;
        ctx.shadowBlur = 16;
      } else if (!phantom && lit && i >= 0.3) {
        ctx.shadowColor = GLOW;
        ctx.shadowBlur = 4 + i * 12;
      }
      ctx.beginPath();
      ctx.arc(nx, ny, r, 0, TAU);
      if (selected || (hi && hi.id === n.id)) ctx.fillStyle = C.primary;
      else if (phantom) ctx.fillStyle = lit ? C.phantom : C.phantomDim;
      else {
        const { h: hh, s, l } = nodeHSL(n, i);
        const a = lit ? 1 : 0.25;
        if (r >= 5) {
          const core = Math.min(97, l + 16 + i * 26);
          const coreSat = i >= 0.75 ? s * (1 - (i - 0.75) * 2.4) : s;
          const g = ctx.createRadialGradient(nx - r * 0.38, ny - r * 0.38, r * 0.05, nx, ny, r * 1.05);
          g.addColorStop(0, `hsl(${hh} ${Math.max(0, coreSat)}% ${core}% / ${a})`);
          g.addColorStop(0.55, `hsl(${hh} ${s}% ${l}% / ${a})`);
          g.addColorStop(1, `hsl(${hh} ${s}% ${Math.max(4, l - 16)}% / ${a})`);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = `hsl(${hh} ${s}% ${l}% / ${a})`;
        }
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // Labels crisp: se dibujan DESPUÉS del post-proceso, sobre el canvas visible a resolución dpr.
  function drawLabels(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(tx, ty);
    ctx.scale(k, k);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";

    const { c, s2, isLit, dimming } = litContext();
    const mode = labelMode();
    for (const n of nodes) {
      const lit = isLit(n.id);
      const r = nodeRadius(n);
      let showLabel: boolean;
      if (dimming) showLabel = lit;
      else if (mode === "always") showLabel = true;
      else if (mode === "hover") showLabel = false;
      else showLabel = k > 0.55 || n.degree >= 3; // auto
      if (!showLabel) continue;
      const fs = 11 / k;
      ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      const x = dispX(n, c, s2);
      const y = dispY(n, c, s2) + r + 3 / k;
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = C.bg;
      ctx.strokeText(n.label, x, y);
      ctx.fillStyle = lit ? C.fgLabel : C.fgDim;
      ctx.fillText(n.label, x, y);
    }

    ctx.restore();
  }

  // Orquestador del pipeline de tres buffers.
  function draw() {
    refreshColors();
    if (!scene || !low || !sceneCtx || !lowCtx) return;

    // 1) escena completa sin labels, en coords CSS
    drawScene(sceneCtx);

    // 2) downsample antialiaseado a low-res
    lowCtx.imageSmoothingEnabled = true;
    lowCtx.clearRect(0, 0, low.width, low.height);
    lowCtx.drawImage(scene, 0, 0, low.width, low.height);

    // 3) pasada de dither por CPU, in-place sobre el buffer low
    const img = lowCtx.getImageData(0, 0, low.width, low.height);
    applyPostProcess(img.data, low.width, low.height);
    lowCtx.putImageData(img, 0, 0);

    // 4) blit nearest-neighbor cubriendo todo el canvas visible → píxeles duros
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(low, 0, 0, canvas.width, canvas.height);

    // 5) labels monospace crisp encima
    drawLabels(ctx);
  }
```

- [ ] **Step 5: Crear y dimensionar los buffers en `resize()`**

En `resize()` (líneas 478-493), después de `canvas.style.height = ...;` y antes de `genStars();`, insertar la creación/dimensionado de los buffers:

```ts
    if (!scene) {
      scene = document.createElement("canvas");
      sceneCtx = scene.getContext("2d");
    }
    if (!low) {
      low = document.createElement("canvas");
      lowCtx = low.getContext("2d", { willReadFrequently: true });
    }
    scene.width = w;
    scene.height = h;
    low.width = Math.max(1, Math.ceil(w / PIXEL));
    low.height = Math.max(1, Math.ceil(h / PIXEL));
```

El `draw()` al final de `resize()` ya encuentra los buffers creados; su guard `if (!scene || ...) return` cubre cualquier llamada temprana.

- [ ] **Step 6: Verificar typecheck**

Run: `cd client && npm run typecheck`
Expected: sin errores.

- [ ] **Step 7: Verificar que la suite completa sigue verde**

Run: `cd client && npm run test`
Expected: PASS (incluye los tests de `dither` de Task 1; ningún test roto).

- [ ] **Step 8: Verificar visualmente contra los criterios de aceptación**

Run: `cd client && npm run dev`
Abrir el grafo y comprobar:
1. Se ve pixelado fino + dithering Bayer sutil + scanlines (equivalente a pixel 2 / niveles 6 / scanlines 40).
2. Los labels se leen **nítidos** en monospace, sin pixelar, sobre la escena ditherizada.
3. El grafo se ve oscuro tanto con la app en tema claro como en oscuro.
4. Hover, drag, click-para-seleccionar, zoom y pan funcionan exactamente como antes (picking preciso — trabaja en coords de mundo).
5. La rotación del sistema solar sigue fluida, sin caídas de framerate perceptibles.
6. No hay controles nuevos en la UI ni dependencias nuevas.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/GraphView.tsx
git commit -m "feat(grafo): pipeline de buffers CRT (dither + pixelado + scanlines) con labels crisp"
```

---

## Notas de implementación

- **Período de scanline visible:** `low` mide `W/PIXEL` y el canvas visible `W·dpr`, así que el upscale es `PIXEL·dpr`. Cada fila low-res atenuada ocupa `PIXEL` px CSS → patrón de período `2·PIXEL = 4` px CSS (2 normal / 2 oscuro), consistente con el prototipo en cualquier `dpr`.
- **Por qué `willReadFrequently`:** `getImageData`/`putImageData` por frame sobre `low`; la opción evita el warning del navegador y mantiene el readback barato.
- **Picking intacto:** `pickNode`/hover/drag/zoom/pan operan en coordenadas de mundo (antes del pixelado); el post-proceso es puramente visual y no toca esa ruta.
- **Fallback WebGL:** fuera de alcance ahora. Si la pasada CPU pesa en el webview de Tauri, se migra **solo** `applyPostProcess` + el blit a un fragment shader, sin tocar el resto del render 2D (ver spec).
```