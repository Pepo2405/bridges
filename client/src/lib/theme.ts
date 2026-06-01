import { createSignal } from "solid-js";
import {
  BUILTIN_PALETTES,
  DEFAULT_PALETTE_ID,
  TOKEN_KEYS,
  type Palette,
} from "./palettes";

export type Mode = "light" | "dark" | "system";

const MODE_KEY = "forge.theme.mode";
const PALETTE_KEY = "forge.theme.palette";
const CUSTOM_KEY = "forge.themes.custom";
const LEGACY_KEY = "forge.theme"; // valor viejo: "light" | "dark"

const mql = window.matchMedia?.("(prefers-color-scheme: dark)");

function initialMode(): Mode {
  const saved = localStorage.getItem(MODE_KEY);
  if (saved === "light" || saved === "dark" || saved === "system") return saved;
  // Migración del esquema viejo (solo light/dark).
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === "light" || legacy === "dark") return legacy;
  return "system";
}

function initialCustom(): Palette[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const [mode, setModeSignal] = createSignal<Mode>(initialMode());
const [activePaletteId, setActivePaletteId] = createSignal<string>(
  localStorage.getItem(PALETTE_KEY) ?? DEFAULT_PALETTE_ID,
);
const [customThemes, setCustomThemes] = createSignal<Palette[]>(initialCustom());

export { mode, activePaletteId, customThemes };

/** Todas las paletas disponibles: builtin + las custom del usuario. */
export function palettes(): Palette[] {
  return [...BUILTIN_PALETTES, ...customThemes()];
}

function paletteById(id: string): Palette {
  return palettes().find((p) => p.id === id) ?? BUILTIN_PALETTES[0];
}

/** Modo resuelto: "system" se traduce al valor real según el OS. */
function resolvedMode(): "light" | "dark" {
  if (mode() === "system") return mql?.matches ? "dark" : "light";
  return mode() as "light" | "dark";
}

/** Compat con código existente: el modo claro/oscuro efectivo. */
export function theme(): "light" | "dark" {
  return resolvedMode();
}

function applyMode() {
  document.documentElement.classList.toggle("dark", resolvedMode() === "dark");
}

function applyPalette() {
  const p = paletteById(activePaletteId());
  const decls = (set: Palette["light"]) =>
    TOKEN_KEYS.map((k) => `--${k}: ${set[k]};`).join("");
  // `html:root` / `html.dark` tienen especificidad (0,1,1), por encima del `:root`/`.dark`
  // (0,1,0) que Tailwind emite desde app.css, así que ganan sin depender del orden de inyección.
  // El bloque dark va segundo: cuando la clase .dark está activa, desempata a su favor.
  const css = `html:root{${decls(p.light)}}html.dark{${decls(p.dark)}}`;
  let el = document.getElementById("forge-palette") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "forge-palette";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// Aplicar estado inicial al cargar el módulo.
applyPalette();
applyMode();

// Re-aplicar el modo cuando cambia el tema del OS y estamos en "system".
mql?.addEventListener?.("change", () => {
  if (mode() === "system") applyMode();
});

export function setMode(m: Mode) {
  setModeSignal(m);
  localStorage.setItem(MODE_KEY, m);
  applyMode();
}

/** Atajo rápido claro↔oscuro (botón sol/luna de la topbar). */
export function toggleTheme() {
  setMode(resolvedMode() === "dark" ? "light" : "dark");
}

export function selectPalette(id: string) {
  setActivePaletteId(id);
  localStorage.setItem(PALETTE_KEY, id);
  applyPalette();
}

function persistCustom(list: Palette[]) {
  setCustomThemes(list);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

/** Crea o actualiza una paleta custom (match por id). Si es la activa, la re-aplica. */
export function saveCustomTheme(p: Palette) {
  const list = customThemes();
  const idx = list.findIndex((x) => x.id === p.id);
  const next = idx >= 0 ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
  persistCustom(next);
  if (activePaletteId() === p.id) applyPalette();
}

export function deleteCustomTheme(id: string) {
  persistCustom(customThemes().filter((x) => x.id !== id));
  if (activePaletteId() === id) selectPalette(DEFAULT_PALETTE_ID);
}

// ── Utilidades de color (HSL string "H S% L%" ↔ hex), para el editor ──

/** "H S% L%" → "#rrggbb". Devuelve "#000000" si el formato no es válido. */
export function hslToHex(hsl: string): string {
  const m = hsl.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return "#000000";
  const h = +m[1];
  const s = +m[2] / 100;
  const l = +m[3] / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + mm) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** "#rrggbb" → "H S% L%". */
export function hexToHsl(hex: string): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
