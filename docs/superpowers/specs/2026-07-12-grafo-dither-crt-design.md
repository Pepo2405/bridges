# Grafo con post-proceso CRT / dither (pixelart retro)

**Fecha:** 2026-07-12
**Componente:** `client/src/components/GraphView.tsx`
**Estado:** diseño aprobado, pendiente de plan de implementación

## Objetivo

Darle al grafo de notas de Bridges una estética pixelart/retro tipo CRT, inspirada en
[dither-kit](https://www.tripwire.sh/dither-kit): gradientes convertidos en patrones de
píxeles mediante **ordered dithering (matriz Bayer 8×8)**, paleta reducida por canal,
pixelado fino y scanlines. El look objetivo es un **monitor de fósforo refinado**, no un
lo-fi chunky.

Se valida con un prototipo interactivo; la configuración elegida por el usuario es
**pixel 2 · niveles 6 · scanlines 40%**: dithering sutil + pixelado fino + scanlines
marcadas.

## Alcance

- **Reemplazo total:** el grafo se ve siempre con el efecto. Sin toggle, sin sliders.
- **Constantes fijas** (hardcoded): `PIXEL = 2`, `LEVELS = 6`, `SCANLINES = 0.40`.
- **Siempre oscuro:** el efecto es inherentemente fósforo/CRT; el grafo se renderiza
  siempre sobre fondo oscuro, sin importar el tema (claro/oscuro) de la app.

### Fuera de alcance (YAGNI)

- Toggle activar/desactivar el efecto.
- Sliders de intensidad en la UI.
- Patrones de dither por-serie (crosshatch diagonal vs. puntos, como dither-kit).
- Implementación WebGL de entrada (ver "Performance").

## Arquitectura

Hoy `draw()` renderiza directo sobre el canvas visible. Se introduce un pipeline de tres
buffers **dentro de `GraphView.tsx`** (sin dependencias nuevas). La lógica de fuerzas,
sistema solar, rotación, hover, drag, zoom y pan **no se toca**.

### Buffers

1. **`scene`** — canvas offscreen a resolución CSS (`W × H`, sin dpr). Recibe todo el
   dibujo actual: fondo espacio profundo, nebulosa, estrellas, anillos de órbita, edges
   curvos, nodos con sombreado esférico y coronas doradas. Es el `draw()` actual renombrado
   a `drawScene(ctx)`, **menos los labels**.
2. **`low`** — canvas offscreen a `ceil(W/PIXEL) × ceil(H/PIXEL)`. Se obtiene con
   `drawImage(scene, …)` y `imageSmoothingEnabled = true` (downsample antialiaseado).
3. **`canvas`** (visible) — a `W·dpr × H·dpr`. Recibe el `low` reescalado
   **nearest-neighbor** (`imageSmoothingEnabled = false`) cubriendo todo el canvas, y encima
   los labels crisp.

### Flujo por frame (`loop` / `draw`)

```
drawScene(sceneCtx)                    // escena completa sin labels, coords CSS
downsample: lowCtx.drawImage(scene)    // smoothing on → W/2 × H/2
postProcess(lowCtx)                    // Bayer 8x8 + cuantización + scanlines, in-place
visible: drawImage(low → canvas)       // smoothing off → píxeles duros
drawLabels(visibleCtx)                 // monospace crisp, transform de mundo, sobre todo
```

### `postProcess()` — la pasada de dither

CPU vía `getImageData` / `putImageData` sobre el buffer `low`. Idéntica al prototipo
validado, para que el resultado coincida con lo aprobado.

- Matriz **Bayer 8×8** (constante, valores 0..63).
- Por píxel `(x, y)` y canal RGB (alpha intacto):
  - `bm = (BAYER[(y&7)*8 + (x&7)] + 0.5) / 64 − 0.5`  → umbral en `[−0.5, 0.5)`
  - `q = clamp(round(v * (LEVELS−1) + bm), 0, LEVELS−1)`  con `v = canal/255`
  - `canal' = (q / (LEVELS−1)) * 255`
- **Scanlines:** en filas impares del grid low-res (`y & 1`), multiplicar RGB por
  `1 − SCANLINES` (= 0.60). Al reescalar por `PIXEL = 2`, produce un patrón de período 4px
  (2px normal / 2px oscuro).

### `drawLabels()` — labels crisp

- Se extraen del `drawScene`; se dibujan **después** del post-proceso, sobre el canvas
  visible.
- Se replica la transformación de mundo en el ctx visible:
  `setTransform(dpr,0,0,dpr,0,0)` → `translate(tx, ty)` → `scale(k)`, y se usan las mismas
  coords rotadas (`dispX`/`dispY`) que hoy.
- **Fuente monospace:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  (reemplaza la sans-serif actual de los labels).
- Se conserva la lógica actual de qué labels mostrar (`labelMode`, dimming por hover/búsqueda)
  y el halo (`strokeText` con color de fondo). Nítidos en retina porque se dibujan a `dpr`.

### Siempre oscuro (desacople del tema)

El grafo debe verse oscuro aunque la app esté en tema claro, reusando la paleta oscura del
design system (sin hardcodear HSL sueltos).

- El wrapper del canvas (`wrap`) lleva `class="dark"`.
- `token()` y `refreshColors()` leen los custom properties **desde `wrap`**
  (`getComputedStyle(wrap)`) en vez de `document.documentElement`. Así los tokens resuelven
  siempre a sus valores oscuros.
- `C.isDark` queda `true` de forma efectiva → la nebulosa central y el campo de estrellas
  (hoy condicionados a `C.isDark`) se dibujan siempre.
- La huella de tema en `refreshColors()` (usa `--foreground` para evitar releer tokens por
  frame) sigue funcionando: al estar fija en oscuro, se leen los tokens una sola vez.

## Interacción

Sin cambios funcionales. `pickNode`, hover, drag, zoom, pan trabajan en coordenadas de
**mundo** (antes del pixelado), así que el post-proceso no afecta la precisión del picking
ni el arrastre. El cursor, la selección y la búsqueda se comportan igual.

## Performance

El `postProcess()` corre por frame durante la rotación (la escena cambia cada frame). El
loop recorre ~`(W/2)·(H/2)` píxeles × 3 canales — del orden de cientos de miles de
operaciones aritméticas simples por frame. Se espera del orden de pocos ms; aceptable dado
que el grafo ya redibuja por frame mientras rota.

**Fallback (no se implementa ahora):** si en el webview de Tauri la pasada CPU pesa, se
migra **solo** `postProcess()` + el blit final a un shader WebGL (fragment shader con Bayer
+ scanlines sobre el `scene` como textura), sin tocar el resto del render 2D.

## Criterios de aceptación

1. El grafo se ve con pixelado fino + dithering Bayer sutil + scanlines, equivalente a la
   config **pixel 2 / niveles 6 / scanlines 40** del prototipo.
2. Los labels se leen **nítidos** en monospace, sin pixelar, sobre la escena ditherizada.
3. El grafo se ve oscuro tanto con la app en tema claro como en oscuro.
4. Hover, drag, click-para-seleccionar, zoom y pan funcionan exactamente como antes (picking
   preciso).
5. La rotación del sistema solar sigue fluida; sin caídas de framerate perceptibles en uso
   normal.
6. No se agregan dependencias nuevas ni controles nuevos en la UI.

## Archivos afectados

- `client/src/components/GraphView.tsx` — único archivo. Se reestructura `draw()` en
  `drawScene()` + `postProcess()` + `drawLabels()`, se agregan los buffers offscreen y las
  constantes, y se cambia el origen de lectura de tokens a `wrap` con `class="dark"`.
