import { type Component, onMount, onCleanup, createEffect, createSignal } from "solid-js";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type ForceLink,
} from "d3-force";
import type { Doc } from "~/lib/api";
import { buildGraph, type GraphNode, type GraphLink } from "~/lib/graph";
import { GraphControls, type LabelMode } from "~/components/GraphControls";

const DEFAULTS = { repel: 650, linkDist: 90, centerForce: 0.012 };

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
  const [labelMode, setLabelMode] = createSignal<LabelMode>("auto");
  const [repel, setRepel] = createSignal(DEFAULTS.repel);
  const [linkDist, setLinkDist] = createSignal(DEFAULTS.linkDist);
  const [centerForce, setCenterForce] = createSignal(DEFAULTS.centerForce);
  const [nodeCount, setNodeCount] = createSignal(0);
  const resetSettings = () => {
    setRepel(DEFAULTS.repel);
    setLinkDist(DEFAULTS.linkDist);
    setCenterForce(DEFAULTS.centerForce);
    setShowPhantoms(true);
    setShowOrphans(true);
    setLabelMode("auto");
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
    primary: "", phantom: "", phantomDim: "", bg: "",
  };
  function refreshColors() {
    C = {
      fg: token("--foreground", 0.9),
      fgDim: token("--foreground", 0.22),
      fgLabel: token("--foreground", 0.88),
      edge: token("--foreground", 0.1),
      edgeDim: token("--foreground", 0.04),
      edgeLit: token("--primary", 0.7),
      primary: token("--primary"),
      phantom: token("--muted-foreground", 0.5),
      phantomDim: token("--muted-foreground", 0.15),
      bg: token("--background", 0.85),
    };
  }

  let k = 1, tx = 0, ty = 0, w = 0, h = 0, dpr = 1;
  let fitted = false;

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
    return 3.5 + Math.sqrt(n.degree) * 2.3;
  }

  function pickNode(sx: number, sy: number): GraphNode | null {
    const p = toWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = nodeRadius(n) + 4;
      const dx = (n.x ?? 0) - p.x;
      const dy = (n.y ?? 0) - p.y;
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
    ctx.translate(tx, ty);
    ctx.scale(k, k);
    ctx.lineCap = "round";

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

    // edges
    for (const l of links) {
      const s = l.source as GraphNode;
      const t = l.target as GraphNode;
      const both = isLit(s.id) && isLit(t.id);
      const emphasize = hi ? s.id === hi.id || t.id === hi.id : searching && both;
      ctx.strokeStyle = emphasize ? C.edgeLit : dimming ? C.edgeDim : C.edge;
      ctx.lineWidth = (emphasize ? 1.1 : 0.6) / k;
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.stroke();
    }

    // nodes
    for (const n of nodes) {
      const r = nodeRadius(n);
      const lit = isLit(n.id);
      const phantom = n.docId == null;
      const selected = n.docId && n.docId === props.selectedId;
      const focus = (hi && hi.id === n.id) || selected || (searching && lit);

      if (focus) {
        ctx.shadowColor = C.primary;
        ctx.shadowBlur = 16;
      }
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
      if (selected || (hi && hi.id === n.id)) ctx.fillStyle = C.primary;
      else if (phantom) ctx.fillStyle = lit ? C.phantom : C.phantomDim;
      else ctx.fillStyle = lit ? C.fg : C.fgDim;
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
      const x = n.x!;
      const y = n.y! + r + 3 / k;
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = C.bg;
      ctx.strokeText(n.label, x, y);
      ctx.fillStyle = lit ? C.fgLabel : C.fgDim;
      ctx.fillText(n.label, x, y);
    }

    ctx.restore();
  }

  function loop() {
    if (sim) {
      sim.tick();
      if (!fitted && sim.alpha() < 0.15) {
        fitToView();
        fitted = true;
      }
      if (sim.alpha() < 0.005 && !dragNode) running = false;
    }
    draw();
    if (running || dragNode) raf = requestAnimationFrame(loop);
    else raf = 0;
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

  function rebuild() {
    const g = filterGraph();
    const prev = new Map(nodes.map((n) => [n.id, n]));
    nodes = g.nodes.map((n) => {
      const p = prev.get(n.id);
      return p ? Object.assign(n, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }) : n;
    });
    links = g.links;
    setNodeCount(nodes.length);
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
      .force("charge", forceManyBody().strength(-repel()).distanceMax(1400))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(centerForce()))
      .force("y", forceY(0).strength(centerForce()))
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
        n.fx = wp.x;
        n.fy = wp.y;
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
        dragNode.fx = wp.x;
        dragNode.fy = wp.y;
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
        dragNode.fx = null;
        dragNode.fy = null;
        dragNode = null;
        kick(0.05);
      }
      panning = false;
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);

    onCleanup(() => {
      ro.disconnect();
      sim?.stop();
      if (raf) cancelAnimationFrame(raf);
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
    const r = repel(), ld = linkDist(), cf = centerForce();
    if (!sim) return;
    sim.force("charge", forceManyBody().strength(-r).distanceMax(1400));
    linkForce?.distance((l) => ld + ((l.source as GraphNode).degree + (l.target as GraphNode).degree) * 3);
    sim.force("x", forceX(0).strength(cf));
    sim.force("y", forceY(0).strength(cf));
    kick(0.4);
  });

  // Redibujar al cambiar selección, búsqueda o modo de labels.
  createEffect(() => {
    props.selectedId;
    search();
    labelMode();
    if (sim && !running) draw();
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
        centerForce={centerForce} setCenterForce={setCenterForce}
        onReset={resetSettings}
      />
      <div class="pointer-events-none absolute bottom-3 left-3 text-xs text-muted-foreground">
        {nodeCount()} nodos · scroll para zoom · arrastrá un nodo
      </div>
    </div>
  );
};
