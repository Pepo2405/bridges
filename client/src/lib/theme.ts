import { createSignal } from "solid-js";

type Theme = "light" | "dark";
const KEY = "forge.theme";

function initial(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const [theme, setTheme] = createSignal<Theme>(initial());

function apply(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
}
apply(theme()); // aplicar el tema inicial al cargar el módulo

export { theme };

export function toggleTheme() {
  const next: Theme = theme() === "dark" ? "light" : "dark";
  setTheme(next);
  localStorage.setItem(KEY, next);
  apply(next);
}
