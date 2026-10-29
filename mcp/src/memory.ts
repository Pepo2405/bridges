/**
 * Memoria de agentes sobre el vault (equivalente a Engram, pero en markdown legible):
 * Decisiones (una nota por tema, upsert) y Bitácora (handoff por sesión), en la
 * carpeta del proyecto que declara el `.bridges` del repo. Formato y reglas:
 * docs/memoria-agentes.md. Escribe con createNote/updateNote, así toda edición deja
 * snapshot en .bridges/history (deshacer con restore_note).
 *
 * Funciones puras sobre un `Project` explícito; `now` inyectable para tests.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readMarker, resolveNamedVault } from "./bridges";
import { createNote, updateNote } from "./writer";

export type Project = {
  /** Nombre del vault (como en list_vaults / .bridges). */
  vault: string;
  /** Raíz del vault en disco. */
  dir: string;
  /** Carpeta del proyecto dentro del vault, sin barras en los bordes ("" = raíz). */
  folder: string;
  /** Raíz del repo (donde está el .bridges), si se resolvió por cwd. */
  root?: string;
};

export const TIPOS = ["decision", "bugfix", "patron", "config", "preferencia", "descubrimiento"] as const;
export type Tipo = (typeof TIPOS)[number];

/** Meses hasta `revisar_despues`, por tipo. */
const REVIEW_MONTHS: Record<Tipo, number> = {
  preferencia: 3, config: 3, decision: 6, patron: 6, descubrimiento: 6, bugfix: 12,
};

const DECISIONES = "Decisiones";
const BITACORA = "Bitácora";

// ── Proyecto ────────────────────────────────────────────────────────────────

const cleanFolder = (f: string | undefined) => (f ?? "").trim().replace(/^\/+|\/+$/g, "");

/**
 * Resuelve el proyecto: con `vault` explícito usa ese vault y `folder` (default raíz);
 * si no, busca un `.bridges` en `cwd` (default: cwd del proceso) o en sus padres.
 */
export function resolveProject(opts: { cwd?: string; vault?: string; folder?: string } = {}): Project {
  if (opts.vault) {
    const dir = resolveNamedVault(opts.vault);
    if (!dir) throw new Error(`vault desconocido: "${opts.vault}". Usá list_vaults para ver los disponibles.`);
    return { vault: opts.vault, dir, folder: cleanFolder(opts.folder) };
  }
  const start = resolve(opts.cwd ?? process.cwd());
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, ".bridges"))) {
      const marker = readMarker(d);
      if (!marker?.vault) throw new Error(`el .bridges de ${d} no declara "vault".`);
      const dir = resolveNamedVault(marker.vault);
      if (!dir) throw new Error(`el .bridges de ${d} nombra un vault desconocido: "${marker.vault}".`);
      return { vault: marker.vault, dir, folder: cleanFolder(opts.folder ?? marker.folder), root: d };
    }
    if (dirname(d) === d) break;
  }
  throw new Error(
    `no encontré un .bridges en ${start} ni en sus carpetas padre. Pasá \`cwd\` con la ruta del repo, ` +
      `o \`vault\` (y \`folder\`) explícitos.`,
  );
}

const inFolder = (p: Project, sub: string) => (p.folder ? `${p.folder}/${sub}` : sub);

// ── Fechas ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Suma meses a una fecha local; si el día no existe en el mes destino, usa el último. */
function addMonths(d: Date, months: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return target;
}

// ── Nombres de tema ─────────────────────────────────────────────────────────

/** Tema → nombre de archivo seguro (sin extensión). Conserva acentos y espacios. */
function topicFilename(topic: string): string {
  const s = topic.replace(/[\/\\:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!s) throw new Error("el tema (topic) quedó vacío: usá un sustantivo, p. ej. \"Auth - modelo de sesiones\".");
  return s.slice(0, 120).trim();
}

/** Forma comparable de un tema: sin acentos ni mayúsculas, solo letras/números. */
function normTopic(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const STOP = new Set(["del", "las", "los", "por", "para", "con", "una", "uno", "que", "the", "and", "for"]);
const topicTokens = (s: string) => new Set(normTopic(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)));

function similarity(a: string, b: string): number {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Nombres (sin .md) de las notas de una carpeta del vault. [] si no existe. */
function listNotes(p: Project, sub: string): string[] {
  const abs = join(p.dir, inFolder(p, sub));
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => e.name.slice(0, -3))
    .sort();
}

const findTopic = (names: string[], topic: string) => names.find((n) => normTopic(n) === normTopic(topic));

// ── Parseo de notas ─────────────────────────────────────────────────────────

type Section = { heading: string; body: string };
type ParsedNote = { fm: Map<string, string>; title: string | null; intro: string; sections: Section[] };

function parseNote(text: string): ParsedNote {
  const fm = new Map<string, string>();
  let body = text.replace(/\r\n/g, "\n");
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      fm.set(line.slice(0, i).trim(), line.slice(i + 1).replace(/\s+#.*$/, "").trim());
    }
    body = body.slice(m[0].length);
  }
  const lines = body.split("\n");
  let title: string | null = null;
  const intro: string[] = [];
  const sections: Section[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h2: RegExpMatchArray | null | false = !inFence && line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (cur) sections.push({ heading: cur.heading, body: trimBlock(cur.lines.join("\n")) });
      cur = { heading: h2[1], lines: [] };
      continue;
    }
    if (cur) { cur.lines.push(line); continue; }
    const h1: RegExpMatchArray | null | false = !inFence && title === null && line.match(/^#\s+(.+?)\s*$/);
    if (h1) { title = h1[1]; continue; }
    intro.push(line);
  }
  if (cur) sections.push({ heading: cur.heading, body: trimBlock(cur.lines.join("\n")) });
  return { fm, title, intro: trimBlock(intro.join("\n")), sections };
}

const trimBlock = (s: string) => s.replace(/^\s*\n/, "").replace(/\s+$/, "");

const FIELDS = ["Qué", "Por qué", "Dónde", "Aprendido", "Reemplaza a"] as const;
type Field = (typeof FIELDS)[number];
const FIELD_RE = /^\*\*(Qué|Por qué|Dónde|Aprendido|Reemplaza a)\*\*\s*:\s?(.*)$/;

/** Separa los campos **Qué**: … del resto del intro (texto libre, que se conserva). */
function parseFields(intro: string): { fields: Partial<Record<Field, string>>; rest: string } {
  const fields: Partial<Record<Field, string>> = {};
  const rest: string[] = [];
  let cur: Field | null = null;
  for (const line of intro.split("\n")) {
    const m = line.match(FIELD_RE);
    if (m) {
      cur = m[1] as Field;
      fields[cur] = m[2];
    } else if (cur && line.trim() !== "") {
      fields[cur] += "\n" + line;
    } else {
      // Línea en blanco: corta el campo. El texto que sigue es libre.
      if (line.trim() === "") cur = null;
      if (!cur) rest.push(line);
    }
  }
  return { fields, rest: trimBlock(rest.join("\n")) };
}

function renderNote(fm: Map<string, string>, title: string, blocks: string[], sections: Section[]): string {
  const head = ["---", ...[...fm].map(([k, v]) => `${k}: ${v}`), "---", `# ${title}`];
  const parts = [head.join("\n"), ...blocks.filter((b) => b.trim())];
  for (const s of sections) parts.push(`## ${s.heading}\n${s.body}`.replace(/\s+$/, ""));
  return parts.join("\n\n") + "\n";
}

const endDot = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

// ── save_decision ───────────────────────────────────────────────────────────

export type DecisionInput = {
  topic: string;
  tipo?: Tipo;
  que?: string;
  porque?: string;
  donde?: string;
  aprendido?: string;
  /** Línea para `## Cambios` (default "creada" / "actualizada"). */
  cambio?: string;
  /** Tema de otra Decisión que esta reemplaza (se marca `estado: reemplazada`). */
  reemplaza?: string;
};

export type DecisionResult = {
  path: string;
  action: "created" | "updated";
  /** Otras Decisiones con nombre parecido (posible duplicado: unificá si es el mismo tema). */
  similares: string[];
  avisos: string[];
};

export function saveDecision(p: Project, input: DecisionInput, now: Date = new Date()): DecisionResult {
  if (input.tipo !== undefined && !TIPOS.includes(input.tipo)) {
    throw new Error(`tipo inválido: "${input.tipo}". Usá uno de: ${TIPOS.join(", ")}.`);
  }
  const names = listNotes(p, DECISIONES);
  const existing = findTopic(names, input.topic);
  const name = existing ?? topicFilename(input.topic);
  const rel = inFolder(p, `${DECISIONES}/${name}.md`);
  const today = ymd(now);
  const avisos: string[] = [];

  let old: ParsedNote | null = null;
  if (existing) old = parseNote(readFileSync(join(p.dir, rel), "utf8"));
  else if (!input.que?.trim() || !input.porque?.trim()) {
    throw new Error(`"${name}" es una Decisión nueva: hacen falta \`que\` y \`por qué\` (\`porque\`).`);
  }

  // Validar el reemplazo antes de escribir nada.
  let replaced: string | undefined;
  if (input.reemplaza) {
    replaced = findTopic(names, input.reemplaza);
    if (!replaced) throw new Error(`no existe la Decisión a reemplazar: "${input.reemplaza}".`);
    if (replaced === name) throw new Error("una Decisión no puede reemplazarse a sí misma.");
  }

  const { fields: oldFields, rest } = old ? parseFields(old.intro) : { fields: {}, rest: "" };
  const fields: Partial<Record<Field, string>> = { ...oldFields };
  const set = (f: Field, v: string | undefined) => { if (v !== undefined && v.trim()) fields[f] = v.trim(); };
  set("Qué", input.que);
  set("Por qué", input.porque);
  set("Dónde", input.donde);
  set("Aprendido", input.aprendido);
  if (replaced) fields["Reemplaza a"] = `[[${replaced}]]`;

  const tipo = (input.tipo ?? (old?.fm.get("tipo") as Tipo | undefined) ?? "decision") as Tipo;
  const months = REVIEW_MONTHS[tipo] ?? 6;
  const fm = new Map(old?.fm ?? []);
  if (fm.get("estado") === "reemplazada") {
    avisos.push(`"${name}" estaba reemplazada por ${fm.get("reemplazada_por") ?? "otra"}; quedó vigente otra vez.`);
    fm.delete("reemplazada_por");
  }
  fm.set("tipo", tipo);
  fm.set("estado", "vigente");
  fm.set("actualizado", today);
  fm.set("revisar_despues", ymd(addMonths(now, months)));
  // Orden estable de las claves conocidas; las demás se conservan después.
  const ordered = new Map<string, string>();
  for (const k of ["tipo", "estado", "actualizado", "revisar_despues"]) ordered.set(k, fm.get(k)!);
  for (const [k, v] of fm) if (!ordered.has(k)) ordered.set(k, v);

  const fieldBlock = FIELDS.filter((f) => fields[f]).map((f) => `**${f}**: ${fields[f]}`).join("\n");
  const sections = (old?.sections ?? []).filter((s) => s.heading !== "Cambios");
  const prevCambios = old?.sections.find((s) => s.heading === "Cambios")?.body ?? "";
  const line = `- ${today}: ${endDot(input.cambio ?? (existing ? "actualizada" : "creada"))}`;
  sections.push({ heading: "Cambios", body: prevCambios ? `${prevCambios}\n${line}` : line });

  const content = renderNote(ordered, old?.title ?? name, [fieldBlock, rest], sections);
  if (existing) updateNote(p.dir, { path: rel, mode: "overwrite", content });
  else createNote(p.dir, { title: name, content, path: rel });

  if (replaced) {
    const oldRel = inFolder(p, `${DECISIONES}/${replaced}.md`);
    const prev = parseNote(readFileSync(join(p.dir, oldRel), "utf8"));
    const pfm = new Map(prev.fm);
    pfm.set("estado", "reemplazada");
    pfm.set("reemplazada_por", `"[[${name}]]"`);
    pfm.set("actualizado", today);
    const secs = prev.sections.filter((s) => s.heading !== "Cambios");
    const pc = prev.sections.find((s) => s.heading === "Cambios")?.body ?? "";
    const l = `- ${today}: reemplazada por [[${name}]].`;
    secs.push({ heading: "Cambios", body: pc ? `${pc}\n${l}` : l });
    updateNote(p.dir, { path: oldRel, mode: "overwrite", content: renderNote(pfm, prev.title ?? replaced, [prev.intro], secs) });
  }

  const similares = names.filter((n) => n !== name && n !== replaced && similarity(n, name) >= 0.5);
  return { path: rel, action: existing ? "updated" : "created", similares, avisos };
}

// ── log_session ─────────────────────────────────────────────────────────────

export type SessionInput = {
  tema: string;
  objetivo?: string;
  instrucciones?: string;
  descubrimientos?: string;
  hecho?: string;
  proximos?: string;
  archivos?: string;
};

const LOG_SECTIONS: [keyof SessionInput, string][] = [
  ["objetivo", "Objetivo"],
  ["instrucciones", "Instrucciones del usuario"],
  ["descubrimientos", "Descubrimientos"],
  ["hecho", "Hecho"],
  ["proximos", "Próximos pasos"],
  ["archivos", "Archivos"],
];
/** Secciones que se reemplazan al volver a escribir el mismo día (las demás se suman). */
const REPLACE_ON_UPDATE = new Set(["Objetivo", "Próximos pasos"]);

export function logSession(
  p: Project, input: SessionInput, now: Date = new Date(),
): { path: string; action: "created" | "updated" } {
  const given = LOG_SECTIONS.filter(([k]) => input[k]?.trim());
  if (!given.length) throw new Error("la Bitácora necesita al menos una sección (hecho, proximos, objetivo…).");
  const today = ymd(now);
  const title = `${today} - ${topicFilename(input.tema)}`;
  const rel = inFolder(p, `${BITACORA}/${title}.md`);
  const abs = join(p.dir, rel);

  if (!existsSync(abs)) {
    const parts = [`# ${title}`, ...given.map(([k, h]) => `## ${h}\n${input[k]!.trim()}`)];
    createNote(p.dir, { title, content: parts.join("\n\n") + "\n", path: rel });
    return { path: rel, action: "created" };
  }

  const prev = parseNote(readFileSync(abs, "utf8"));
  const byHeading = new Map(prev.sections.map((s) => [s.heading, s.body]));
  for (const [k, h] of given) {
    const v = input[k]!.trim();
    const old = byHeading.get(h);
    byHeading.set(h, old && !REPLACE_ON_UPDATE.has(h) ? `${old}\n${v}` : v);
  }
  const known = LOG_SECTIONS.map(([, h]) => h);
  const out: string[] = [`# ${prev.title ?? title}`];
  if (prev.intro) out.push(prev.intro);
  for (const h of known) if (byHeading.has(h)) out.push(`## ${h}\n${byHeading.get(h)}`);
  for (const s of prev.sections) if (!known.includes(s.heading)) out.push(`## ${s.heading}\n${s.body}`);
  const fmText = prev.fm.size ? `---\n${[...prev.fm].map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n` : "";
  updateNote(p.dir, { path: rel, mode: "overwrite", content: fmText + out.join("\n\n") + "\n" });
  return { path: rel, action: "updated" };
}

// ── project_context ─────────────────────────────────────────────────────────

export function projectContext(
  p: Project, opts: { now?: Date; compacted?: boolean; maxChars?: number } = {},
): string {
  const today = ymd(opts.now ?? new Date());
  const maxChars = opts.maxChars ?? 4000;
  const where = p.folder ? `${p.folder}/` : "/";
  const lines: string[] = [];
  if (opts.compacted) {
    lines.push(
      "⚠️ El contexto se acaba de compactar. Antes de seguir, guardá el handoff con `log_session` " +
        "(Hecho y Próximos pasos, sacados del resumen) y las decisiones que hayan quedado sin guardar.\n",
    );
  }
  lines.push(
    `## Memoria del proyecto (Bridges: vault \`${p.vault}\`, carpeta \`${where}\`)`,
    "Guardá sin preguntar con `save_decision` (bugfix con causa raíz, decisión de diseño, convención, " +
      "trampa del código, cambio de config, lo que el usuario confirma o rechaza) y cerrá la sesión con " +
      "`log_session`. Avisá en una línea qué guardaste.",
  );
  if (p.root) {
    lines.push(`Repo: \`${p.root}\` (pasalo como \`cwd\` a esas tools si tu MCP no corre dentro del repo).`);
  }

  const decs: string[] = [];
  for (const n of listNotes(p, DECISIONES)) {
    const { fm } = parseNote(readFileSync(join(p.dir, inFolder(p, `${DECISIONES}/${n}.md`)), "utf8"));
    if (fm.get("estado") === "reemplazada") continue;
    let tag = fm.get("tipo") || "sin formato";
    const rev = fm.get("revisar_despues");
    if (rev && rev < today) tag += `, REVISAR: vencida ${rev}`;
    decs.push(`- ${n} (${tag})`);
  }
  if (decs.length) {
    lines.push(`\nDecisiones vigentes en \`${inFolder(p, DECISIONES)}/\` (leé la nota antes de tocar ese tema; las vencidas, verificalas contra el código):`);
    lines.push(...decs);
  } else {
    lines.push(`\nTodavía no hay notas en \`${inFolder(p, DECISIONES)}/\`.`);
  }

  const logs = listNotes(p, BITACORA);
  if (logs.length) {
    const last = logs[logs.length - 1];
    const lrel = inFolder(p, `${BITACORA}/${last}.md`);
    const { sections } = parseNote(readFileSync(join(p.dir, lrel), "utf8"));
    lines.push(`\nÚltima Bitácora: \`${lrel}\``);
    const next = sections.find((s) => s.heading === "Próximos pasos")?.body;
    if (next) lines.push("Próximos pasos que quedaron:\n" + next.slice(0, 1200));
  }

  const ctx = lines.join("\n");
  return ctx.length > maxChars
    ? ctx.slice(0, maxChars) + "\n[…truncado; listá la carpeta para ver el resto]"
    : ctx;
}
