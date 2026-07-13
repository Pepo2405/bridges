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
