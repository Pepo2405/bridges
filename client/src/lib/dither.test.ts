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
