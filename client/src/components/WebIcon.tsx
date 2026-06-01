import { type Component, For } from "solid-js";

/**
 * Telaraña — mismo motivo que el ícono de la app (Bridges).
 * Radios + anillos concéntricos. Usa `currentColor`, así que toma el color
 * del texto (p.ej. `text-primary`) y se escala con clases h-/w- como lucide.
 */
const N = 8; // radios
const A0 = -Math.PI / 2; // primer radio hacia arriba
const STEP = (2 * Math.PI) / N;
const C = 12; // centro (viewBox 24)
const SPOKE_R = 10.5;
const RINGS = [3.5, 7, 10.5];

const pt = (k: number, r: number): [number, number] => [
  +(C + r * Math.cos(A0 + k * STEP)).toFixed(2),
  +(C + r * Math.sin(A0 + k * STEP)).toFixed(2),
];

const spokes = Array.from({ length: N }, (_, k) => pt(k, SPOKE_R));
const ringPolys = RINGS.map((r) =>
  Array.from({ length: N }, (_, k) => pt(k, r).join(","))
    .join(" "),
);

export const WebIcon: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <For each={spokes}>{([x, y]) => <line x1={C} y1={C} x2={x} y2={y} />}</For>
    <For each={ringPolys}>{(points) => <polygon points={points} />}</For>
  </svg>
);
