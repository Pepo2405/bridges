import { type Component, onMount, onCleanup, createEffect, createSignal } from "solid-js";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  forceRadial,
  type Simulation,
  type ForceLink,
} from "d3-force";
import type { Doc } from "~/lib/api";
import { buildGraph, type GraphNode, type GraphLink } from "~/lib/graph";
import { GraphControls, type LabelMode } from "~/components/GraphControls";

const DEFAULTS = { repel: 650, linkDist: 90, gravity: 0.09 };
const TAU = Math.PI * 2;
const OMEGA = TAU / 300000; // rad/ms → ~1 vuelta cada 300s (sistema solar)
const SUN_HUE = 45; // dorado del Sol: los archivos importantes viran a este tono al crecer
const GLOW_HSL = `${SUN_HUE} 92% 62%`; // corona/halo dorado que irradian los soles
const GLOW = `hsl(${GLOW_HSL})`;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Interpola tonos por el arco más corto de la rueda (evita pasar por medio espectro). */
const lerpHue = (a: number, b: number, t: number) => {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
};

function token(name: string, alpha?: number): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
}

export const GraphView: Component<{
  docs: Doc[];
  selectedId: string | null;
  onSelect: (docId: string) => void;
}> = (props) => {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;

  // --- settings (panel de filtros/fuerzas) ---
  const [search, setSearch] = createSignal("");
  const [showPhantoms, setShowPhantoms] = createSignal(true);
  const [showOrphans, setShowOrphans] = createSignal(true);
  const [labelMode, setLabelMode] = createSignal<LabelMode>("hover");
  const [repel, setRepel] = createSignal(DEFAULTS.repel);
  const [linkDist, setLinkDist] = createSignal(DEFAULTS.linkDist);
  const [gravity, setGravity] = createSignal(DEFAULTS.gravity);
  const [spin, setSpin] = createSignal(true);
  const [nodeCount, setNodeCount] = createSignal(0);
  const resetSettings = () => {
    setRepel(DEFAULTS.repel);
    setLinkDist(DEFAULTS.linkDist);
    setGravity(DEFAULTS.gravity);
    setSpin(true);
    setShowPhantoms(true);
    setShowOrphans(true);
    setLabelMode("hover");
    setSearch("");
  };

  let sim: Simulation<GraphNode, GraphLink> | null = null;
  let linkForce: ForceLink<GraphNode, GraphLink> | null = null;
  let nodes: GraphNode[] = [];
  let links: GraphLink[] = [];
  let adj = new Map<string, Set<string>>();
  let inited = false;

  let C = {
    fg: "", fgDim: "", fgLabel: "", edge: "", edgeDim: "", edgeLit: "",
    primary: "", phantom: "", phantomDim: "", bg: "", orbit: "", isDark: false,
  };
  let colorKey = "";
  function refreshColors() {
    // Los colores solo cambian al alternar tema; con la rotación dibujando en bucle
    // evitamos releer ~12 tokens por frame usando --foreground como huella del tema.
    const fg = getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim();
    if (fg === colorKey) return;
    colorKey = fg;
    C = {
      isDark: document.documentElement.classList.contains("dark"),
      fg: token("--foreground", 0.9),
      fgDim: token("--foreground", 0.22),
      fgLabel: token("--foreground", 0.88),
      edge: token("--foreground", 0.075),
      edgeDim: token("--foreground", 0.03),
      edgeLit: token("--primary", 0.7),
      primary: token("--primary"),
      phantom: token("--muted-foreground", 0.5),
      phantomDim: token("--muted-foreground", 0.15),
      bg: token("--background", 0.85),
      orbit: token("--foreground", 0.06),
    };
  }

  let k = 1, tx = 0, ty = 0, w = 0, h = 0, dpr = 1;
  let fitted = false;

  // --- sistema solar: importancia (masa) por backlinks + rotación del campo ---
  let maxWeight = 1; // peso máximo del grafo, para normalizar la importancia
  let systemR = 300; // radio del sistema (borde donde orbitan los huérfanos)
  let centerNode: GraphNode | null = null; // el "Sol": nota más referenciada, fija en el origen
  let angle = 0; // rotación actual del campo (rad)
  let lastT = 0; // timestamp del último frame, para avanzar la rotación

  // Estrellas de fondo (espacio profundo). Fijas en pantalla, se regeneran al redimensionar.
  let stars: { x: number; y: number; r: number; a: number }[] = [];
  function genStars() {
    const n = Math.round((w * h) / 6500);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 0.9 + 0.3,
      a: Math.random() * 0.5 + 0.12,
    }));
  }

  // Peso = backlinks entrantes + un poco de conectividad. Manda la gravedad, el tamaño y el brillo.
  const weight = (n: GraphNode) => n.refs + n.degree * 0.5;
  // Importancia normalizada [0,1]: 1 = sol del núcleo, 0 = huérfano del borde.
  const imp = (n: GraphNode) => weight(n) / maxWeight;

  // Color estilo sistema solar (componentes HSL, para poder construir el sombreado esférico):
  //  · huérfanos (grado 0)  → cuerpos fríos blancos/grises (asteroides / enanas).
  //  · archivos conectados  → planetas con color propio según su carpeta top-level.
  //  · padres de muchos     → soles: al crecer en importancia el tono vira al dorado.
  let groupHue = new Map<string, number>();
  function nodeHSL(n: GraphNode, i: number): { h: number; s: number; l: number } {
    if (n.degree === 0) return { h: 0, s: 0, l: C.isDark ? 74 : 55 }; // blanco/gris neutro
    const folderHue = n.group != null ? groupHue.get(n.group) ?? 220 : 220;
    const t = smoothstep(0.55, 0.9, i); // 0 = planeta (color de carpeta), 1 = sol (dorado)
    return {
      h: lerpHue(folderHue, SUN_HUE, t),
      s: lerp(C.isDark ? 58 : 62, 92, t),
      l: C.isDark ? lerp(60, 66, t) : lerp(48, 56, t),
    };
  }

  let hovered: GraphNode | null = null;
  let dragNode: GraphNode | null = null;
  let panning = false;
  let last = { x: 0, y: 0 };
  let downAt = { x: 0, y: 0 };
  let moved = false;
  let raf = 0;
  let running = false;

  const toWorld = (sx: number, sy: number) => ({ x: (sx - tx) / k, y: (sy - ty) / k });

  function nodeRadius(n: GraphNode): number {
    return 4 + Math.sqrt(weight(n)) * 2.9;
  }

  // Coordenadas de pantalla-mundo tras aplicar la rotación del campo.
  const dispX = (n: GraphNode, c: number, s: number) => (n.x ?? 0) * c - (n.y ?? 0) * s;
  const dispY = (n: GraphNode, c: number, s: number) => (n.x ?? 0) * s + (n.y ?? 0) * c;
  // Punto del mundo (ya rotado) → coordenadas de simulación (sin rotar), para arrastre.
  const toSim = (wx: number, wy: number) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return { x: wx * c + wy * s, y: -wx * s + wy * c };
  };

  function pickNode(sx: number, sy: number): GraphNode | null {
    const p = toWorld(sx, sy);
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = nodeRadius(n) + 4;
      const dx = dispX(n, c, s) - p.x;
      const dy = dispY(n, c, s) - p.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  function fitToView() {
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!);
      minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
    }
    const pad = 80;
    const gw = Math.max(maxX - minX, 1);
    const gh = Math.max(maxY - minY, 1);
    k = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, 1.1);
    tx = w / 2 - ((minX + maxX) / 2) * k;
    ty = h / 2 - ((minY + maxY) / 2) * k;
  }

  function draw() {
    const ctx = canvas.getContext("2d")!;
    refreshColors();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Fondo de espacio profundo (solo en tema oscuro): nebulosa central tenue + estrellas.
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

    // Rotación del campo: giramos las coordenadas (no el ctx) para que las labels queden rectas.
    // (s2 = sin; evitamos el nombre `s` porque el loop de edges usa `s` para el nodo origen.)
    const c = Math.cos(angle), s2 = Math.sin(angle);

    const q = search().trim().toLowerCase();
    const searching = q.length > 0;
    const hi = hovered;
    const neighbors = hi ? adj.get(hi.id) ?? new Set<string>() : null;
    const matches = searching ? new Set(nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;

    // Un nodo está "iluminado" si: no hay foco, o es el hover/vecino, o matchea la búsqueda.
    const isLit = (id: string) => {
      if (hi) return id === hi.id || (neighbors?.has(id) ?? false);
      if (matches) return matches.has(id);
      return true;
    };
    const dimming = !!hi || searching;

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
      // punto de control perpendicular al segmento → arco suave
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
        ctx.shadowColor = GLOW; // brillo dorado creciente en los hubs
        ctx.shadowBlur = 4 + i * 12;
      }
      ctx.beginPath();
      ctx.arc(nx, ny, r, 0, TAU);
      if (selected || (hi && hi.id === n.id)) ctx.fillStyle = C.primary;
      else if (phantom) ctx.fillStyle = lit ? C.phantom : C.phantomDim;
      else {
        const { h, s, l } = nodeHSL(n, i);
        const a = lit ? 1 : 0.25;
        if (r >= 5) {
          // Esfera: highlight arriba-izquierda → terminador abajo-derecha, con la luz
          // "viniendo del núcleo". Los soles tienen centro casi blanco (caliente).
          const core = Math.min(97, l + 16 + i * 26);
          const coreSat = i >= 0.75 ? s * (1 - (i - 0.75) * 2.4) : s;
          const g = ctx.createRadialGradient(nx - r * 0.38, ny - r * 0.38, r * 0.05, nx, ny, r * 1.05);
          g.addColorStop(0, `hsl(${h} ${Math.max(0, coreSat)}% ${core}% / ${a})`);
          g.addColorStop(0.55, `hsl(${h} ${s}% ${l}% / ${a})`);
          g.addColorStop(1, `hsl(${h} ${s}% ${Math.max(4, l - 16)}% / ${a})`);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = `hsl(${h} ${s}% ${l}% / ${a})`;
        }
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
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
      ctx.font = `${fs}px ui-sans-serif, system-ui, sans-serif`;
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

  function loop(t?: number) {
    if (sim && (running || dragNode)) {
      sim.tick();
      if (!fitted && sim.alpha() < 0.15) {
        fitToView();
        fitted = true;
      }
      if (sim.alpha() < 0.005 && !dragNode) running = false;
    }
    // Rotación del sistema: pausada al hacer hover en un nodo, al arrastrar o con la pestaña oculta.
    if (spin() && !dragNode && !hovered && !document.hidden) {
      const now = t ?? lastT;
      if (lastT) angle = (angle + (now - lastT) * OMEGA) % TAU;
      lastT = now;
    } else {
      lastT = t ?? lastT;
    }
    draw();
    if (running || dragNode || (spin() && !document.hidden)) raf = requestAnimationFrame(loop);
    else { raf = 0; lastT = 0; }
  }

  function kick(alpha = 0.3) {
    if (sim) sim.alpha(Math.max(sim.alpha(), alpha)).restart();
    running = true;
    if (!raf) raf = requestAnimationFrame(loop);
  }

  /** Filtra el grafo según los toggles (fantasmas / huérfanos) y recalcula grados. */
  function filterGraph() {
    const g = buildGraph(props.docs);
    let ns = g.nodes;
    if (!showPhantoms()) ns = ns.filter((n) => n.docId !== null);
    let keep = new Set(ns.map((n) => n.id));
    const lid = (l: GraphLink, side: "source" | "target") => {
      const v = l[side];
      return typeof v === "string" ? v : v.id;
    };
    let ls = g.links.filter((l) => keep.has(lid(l, "source")) && keep.has(lid(l, "target")));

    // recomputar grado sobre el subgrafo
    const byId = new Map(ns.map((n) => [n.id, n]));
    for (const n of ns) n.degree = 0;
    for (const l of ls) {
      byId.get(lid(l, "source"))!.degree++;
      byId.get(lid(l, "target"))!.degree++;
    }

    if (!showOrphans()) {
      ns = ns.filter((n) => n.degree > 0);
      keep = new Set(ns.map((n) => n.id));
      ls = ls.filter((l) => keep.has(lid(l, "source")) && keep.has(lid(l, "target")));
    }
    return { nodes: ns, links: ls };
  }

  // Gravedad radial: los soles caen al núcleo (radio ~0) y los huérfanos orbitan en el borde.
  function radialForce() {
    return forceRadial<GraphNode>((d) => systemR * Math.pow(1 - imp(d), 1.3), 0, 0).strength((d) => {
      const i = imp(d);
      // Fuerte en el núcleo (fija los soles) y en el borde (mantiene huérfanos en órbita),
      // floja en el medio para que los enlaces formen los cúmulos locales.
      return gravity() * (0.55 + Math.abs(i - 0.5) * 1.5);
    });
  }
  // Carga: los soles pesan más → repelen más fuerte y despejan su vecindad.
  function chargeForce() {
    return forceManyBody<GraphNode>().strength((d) => -repel() * (1 + imp(d) * 2)).distanceMax(1400);
  }

  function rebuild() {
    const g = filterGraph();
    const prev = new Map(nodes.map((n) => [n.id, n]));
    nodes = g.nodes.map((n) => {
      const p = prev.get(n.id);
      return p ? Object.assign(n, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }) : n;
    });
    links = g.links;
    setNodeCount(nodes.length);
    // Importancia normalizada y radio del sistema (crece con la cantidad de nodos).
    maxWeight = 1;
    centerNode = null;
    let bestW = 0;
    for (const n of nodes) {
      const wgt = weight(n);
      if (wgt > maxWeight) maxWeight = wgt;
      if (n.degree > 0 && wgt > bestW) { bestW = wgt; centerNode = n; }
    }
    systemR = 90 + Math.sqrt(nodes.length) * 42;
    // El Sol: la nota más referenciada queda fija en el centro, inmóvil, mientras el resto orbita.
    if (centerNode) {
      centerNode.x = centerNode.y = 0;
      centerNode.vx = centerNode.vy = 0;
      centerNode.fx = centerNode.fy = 0;
    }
    // Un tono por carpeta, repartidos parejo en la rueda (+25° para esquivar el rojo del "seleccionado").
    const groups = [...new Set(nodes.map((n) => n.group).filter((g): g is string => g != null))].sort();
    groupHue = new Map(groups.map((g, idx) => [g, Math.round((idx / Math.max(1, groups.length)) * 360 + 25) % 360]));
    adj = new Map();
    for (const n of nodes) adj.set(n.id, new Set());
    const lid = (v: string | GraphNode) => (typeof v === "string" ? v : v.id);
    for (const l of links) {
      const s = lid(l.source);
      const t = lid(l.target);
      adj.get(s)?.add(t);
      adj.get(t)?.add(s);
    }

    sim?.stop();
    linkForce = forceLink<GraphNode, GraphLink>(links)
      .id((d) => d.id)
      .distance((l) => linkDist() + ((l.source as GraphNode).degree + (l.target as GraphNode).degree) * 3)
      .strength(0.45);
    sim = forceSimulation(nodes)
      .force("link", linkForce)
      .force("charge", chargeForce())
      .force("radial", radialForce())
      .force("collide", forceCollide<GraphNode>().radius((d) => nodeRadius(d) + 32).strength(1))
      .alphaDecay(0.02);
    fitted = false;
    kick(1);
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    genStars();
    if (tx === 0 && ty === 0) {
      tx = w / 2;
      ty = h / 2;
    }
    draw();
  }

  onMount(() => {
    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    resize();
    rebuild();
    inited = true;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nk = Math.min(6, Math.max(0.1, k * factor));
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      tx = cx - ((cx - tx) * nk) / k;
      ty = cy - ((cy - ty) * nk) / k;
      k = nk;
      draw();
    };

    const onDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      downAt = { x: sx, y: sy };
      moved = false;
      canvas.setPointerCapture(e.pointerId);
      const n = pickNode(sx, sy);
      if (n) {
        dragNode = n;
        const wp = toWorld(sx, sy);
        const sp = toSim(wp.x, wp.y);
        n.fx = sp.x;
        n.fy = sp.y;
        kick(0.1);
      } else {
        panning = true;
        last = { x: sx, y: sy };
      }
    };

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (Math.abs(sx - downAt.x) + Math.abs(sy - downAt.y) > 3) moved = true;

      if (dragNode) {
        const wp = toWorld(sx, sy);
        const sp = toSim(wp.x, wp.y);
        dragNode.fx = sp.x;
        dragNode.fy = sp.y;
        kick(0.1);
      } else if (panning) {
        tx += sx - last.x;
        ty += sy - last.y;
        last = { x: sx, y: sy };
        draw();
      } else {
        const n = pickNode(sx, sy);
        if (n !== hovered) {
          hovered = n;
          canvas.style.cursor = n ? "pointer" : "grab";
          if (!running) draw();
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      canvas.releasePointerCapture(e.pointerId);
      if (dragNode) {
        if (!moved && dragNode.docId) props.onSelect(dragNode.docId);
        if (dragNode === centerNode) {
          dragNode.fx = 0; // el Sol vuelve a su lugar en el centro
          dragNode.fy = 0;
        } else {
          dragNode.fx = null;
          dragNode.fy = null;
        }
        dragNode = null;
        kick(0.05);
      }
      panning = false;
    };

    // Reanudar la rotación al volver a la pestaña (RAF se detiene mientras está oculta).
    const onVis = () => {
      if (spin() && !document.hidden && !raf) {
        lastT = 0;
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);

    onCleanup(() => {
      ro.disconnect();
      sim?.stop();
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
    });
  });

  // Rebuild cuando cambian los docs.
  let lastSig = "";
  createEffect(() => {
    const sig = props.docs.map((d) => `${d.id}:${d.version}`).join(",");
    if (sig !== lastSig) {
      lastSig = sig;
      if (sim) rebuild();
    }
  });

  // Rebuild cuando cambian los filtros estructurales (fantasmas / huérfanos).
  createEffect(() => {
    showPhantoms();
    showOrphans();
    if (inited) rebuild();
  });

  // Ajuste de fuerzas en vivo (sin reconstruir el grafo).
  createEffect(() => {
    const ld = linkDist();
    repel(); gravity(); // dependencias reactivas
    if (!sim) return;
    sim.force("charge", chargeForce());
    linkForce?.distance((l) => ld + ((l.source as GraphNode).degree + (l.target as GraphNode).degree) * 3);
    sim.force("radial", radialForce());
    kick(0.4);
  });

  // Redibujar al cambiar selección, búsqueda o modo de labels.
  createEffect(() => {
    props.selectedId;
    search();
    labelMode();
    if (sim && !running) draw();
  });

  // Arrancar el bucle de rotación al activarla (si el RAF estaba detenido).
  createEffect(() => {
    if (spin() && !document.hidden && !raf) {
      lastT = 0;
      raf = requestAnimationFrame(loop);
    }
  });

  return (
    <div ref={wrap} class="relative h-full w-full overflow-hidden" style={{ "touch-action": "none" }}>
      <canvas ref={canvas} class="block" style={{ cursor: "grab" }} />
      <GraphControls
        search={search} setSearch={setSearch}
        showPhantoms={showPhantoms} setShowPhantoms={setShowPhantoms}
        showOrphans={showOrphans} setShowOrphans={setShowOrphans}
        labelMode={labelMode} setLabelMode={setLabelMode}
        repel={repel} setRepel={setRepel}
        linkDist={linkDist} setLinkDist={setLinkDist}
        gravity={gravity} setGravity={setGravity}
        spin={spin} setSpin={setSpin}
        onReset={resetSettings}
      />
      <div class="pointer-events-none absolute bottom-3 left-3 text-xs text-muted-foreground">
        {nodeCount()} nodos · scroll para zoom · arrastrá un nodo
      </div>
    </div>
  );
};
