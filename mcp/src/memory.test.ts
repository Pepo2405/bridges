import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject, saveDecision, logSession, projectContext, type Project } from "./memory";

const NOW = new Date(2026, 9, 29, 12, 0, 0); // 2026-10-29 local

let root: string;
let vaultDir: string;
let repo: string;
let prevCfg: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridges-mem-"));
  vaultDir = join(root, "Vaults", "Equipo");
  repo = join(root, "code", "app");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const cfg = join(root, "bridges.json");
  writeFileSync(cfg, JSON.stringify({ connections: [{ vault: vaultDir, name: "Equipo" }], lastVault: vaultDir }));
  prevCfg = process.env.BRIDGES_CONFIG;
  process.env.BRIDGES_CONFIG = cfg;
});
afterEach(() => {
  if (prevCfg === undefined) delete process.env.BRIDGES_CONFIG;
  else process.env.BRIDGES_CONFIG = prevCfg;
  rmSync(root, { recursive: true, force: true });
});

const read = (rel: string) => readFileSync(join(vaultDir, rel), "utf8");
const proj = (folder = "Proyectos/app"): Project => ({ vault: "Equipo", dir: vaultDir, folder });

describe("resolveProject", () => {
  test("encuentra el .bridges subiendo desde un subdirectorio del repo", () => {
    writeFileSync(join(repo, ".bridges"), JSON.stringify({ vault: "Equipo", folder: "/Proyectos/app/" }));
    const p = resolveProject({ cwd: join(repo, "src", "deep") });
    expect(p).toMatchObject({ vault: "Equipo", dir: vaultDir, folder: "Proyectos/app", root: repo });
    expect(projectContext(p, { now: NOW })).toContain(`Repo: \`${repo}\``);
  });

  test("vault explícito gana y no necesita .bridges", () => {
    expect(resolveProject({ cwd: repo, vault: "Equipo", folder: "X" })).toMatchObject({ dir: vaultDir, folder: "X" });
  });

  test("sin .bridges ni vault → error que explica qué pasar", () => {
    expect(() => resolveProject({ cwd: repo })).toThrow(/\.bridges/);
  });

  test("vault desconocido → error", () => {
    expect(() => resolveProject({ vault: "Nope" })).toThrow(/desconocido/);
  });
});

describe("saveDecision", () => {
  test("crea la nota con frontmatter, campos y Cambios", () => {
    const r = saveDecision(proj(), {
      topic: "Auth - modelo de sesiones", tipo: "decision",
      que: "Sesiones en Redis.", porque: "Escalar horizontal.", donde: "src/auth.ts",
    }, NOW);
    expect(r).toMatchObject({ path: "Proyectos/app/Decisiones/Auth - modelo de sesiones.md", action: "created" });
    const md = read(r.path);
    expect(md).toContain("tipo: decision\nestado: vigente\nactualizado: 2026-10-29\nrevisar_despues: 2027-04-29");
    expect(md).toContain("# Auth - modelo de sesiones");
    expect(md).toContain("**Qué**: Sesiones en Redis.");
    expect(md).toContain("**Dónde**: src/auth.ts");
    expect(md).not.toContain("**Aprendido**");
    expect(md).toContain("## Cambios\n- 2026-10-29: creada.");
  });

  test("plazo de revisión según tipo (bugfix 12 meses, config 3)", () => {
    saveDecision(proj(), { topic: "Bug", tipo: "bugfix", que: "a", porque: "b" }, NOW);
    saveDecision(proj(), { topic: "Conf", tipo: "config", que: "a", porque: "b" }, NOW);
    expect(read("Proyectos/app/Decisiones/Bug.md")).toContain("revisar_despues: 2027-10-29");
    expect(read("Proyectos/app/Decisiones/Conf.md")).toContain("revisar_despues: 2027-01-29");
  });

  test("crear sin qué/por qué falla y no escribe nada", () => {
    expect(() => saveDecision(proj(), { topic: "Nada", que: "solo qué" }, NOW)).toThrow(/por qué/i);
    expect(existsSync(join(vaultDir, "Proyectos/app/Decisiones/Nada.md"))).toBe(false);
  });

  test("mismo tema (otras mayúsculas/acentos) actualiza la misma nota", () => {
    saveDecision(proj(), { topic: "Pagos - redondeo", que: "v1", porque: "p1" }, NOW);
    const later = new Date(2026, 10, 5);
    const r = saveDecision(proj(), { topic: "pagos – REDONDEO", que: "v2", cambio: "pasa a centavos" }, later);
    expect(r.action).toBe("updated");
    expect(r.path).toBe("Proyectos/app/Decisiones/Pagos - redondeo.md");
    const md = read(r.path);
    expect(md).toContain("**Qué**: v2");
    expect(md).toContain("**Por qué**: p1"); // campo omitido se conserva
    expect(md).toContain("actualizado: 2026-11-05");
    expect(md).toContain("- 2026-10-29: creada.\n- 2026-11-05: pasa a centavos.");
    expect(readdirSync(join(vaultDir, "Proyectos/app/Decisiones"))).toEqual(["Pagos - redondeo.md"]);
    // dejó snapshot de la versión anterior
    expect(existsSync(join(vaultDir, ".bridges/history/Proyectos/app/Decisiones/Pagos - redondeo.md"))).toBe(true);
  });

  test("solo topic + cambio = marcar como revisada (renueva fechas)", () => {
    saveDecision(proj(), { topic: "T", tipo: "config", que: "q", porque: "p" }, NOW);
    saveDecision(proj(), { topic: "T", cambio: "revisada, sigue vigente" }, new Date(2027, 1, 10));
    const md = read("Proyectos/app/Decisiones/T.md");
    expect(md).toContain("tipo: config");
    expect(md).toContain("revisar_despues: 2027-05-10");
    expect(md).toContain("**Qué**: q");
  });

  test("avisa temas parecidos al crear", () => {
    saveDecision(proj(), { topic: "Auth - modelo de sesiones", que: "q", porque: "p" }, NOW);
    const r = saveDecision(proj(), { topic: "Auth - sesiones en redis", que: "q", porque: "p" }, NOW);
    expect(r.action).toBe("created");
    expect(r.similares).toEqual(["Auth - modelo de sesiones"]);
  });

  test("reemplaza marca la vieja y enlaza ambas", () => {
    saveDecision(proj(), { topic: "Cache vieja", que: "q", porque: "p" }, NOW);
    saveDecision(proj(), { topic: "Cache nueva", que: "q2", porque: "p2", reemplaza: "cache vieja" }, NOW);
    const vieja = read("Proyectos/app/Decisiones/Cache vieja.md");
    expect(vieja).toContain("estado: reemplazada");
    expect(vieja).toContain('reemplazada_por: "[[Cache nueva]]"');
    expect(vieja).toContain("- 2026-10-29: reemplazada por [[Cache nueva]].");
    expect(read("Proyectos/app/Decisiones/Cache nueva.md")).toContain("**Reemplaza a**: [[Cache vieja]]");
  });

  test("reemplaza un tema inexistente falla antes de escribir", () => {
    expect(() => saveDecision(proj(), { topic: "N", que: "q", porque: "p", reemplaza: "fantasma" }, NOW)).toThrow(/fantasma/);
    expect(existsSync(join(vaultDir, "Proyectos/app/Decisiones/N.md"))).toBe(false);
  });

  test("nota vieja sin formato: no pierde texto ni secciones al actualizar", () => {
    mkdirSync(join(vaultDir, "Decisiones"), { recursive: true });
    writeFileSync(join(vaultDir, "Decisiones/Cron.md"),
      "# Cron\n\n- Corre como servicio externo.\n- No va in-process.\n\n## Detalle\nver compose\n", "utf8");
    saveDecision(proj(""), { topic: "Cron", tipo: "decision", que: "Cron externo.", porque: "Next no garantiza procesos largos." }, NOW);
    const md = read("Decisiones/Cron.md");
    expect(md.startsWith("---\ntipo: decision\n")).toBe(true);
    expect(md).toContain("**Qué**: Cron externo.");
    expect(md).toContain("- Corre como servicio externo.\n- No va in-process.");
    expect(md).toContain("## Detalle\nver compose");
    expect(md).toContain("## Cambios\n- 2026-10-29: actualizada.");
  });

  test("campo multilínea se conserva al actualizar otro campo", () => {
    saveDecision(proj(), { topic: "M", que: "q", porque: "línea 1\nlínea 2" }, NOW);
    saveDecision(proj(), { topic: "M", que: "q nueva" }, NOW);
    expect(read("Proyectos/app/Decisiones/M.md")).toContain("**Por qué**: línea 1\nlínea 2");
  });

  test("tema con caracteres de path se sanea (no crea subcarpetas)", () => {
    const r = saveDecision(proj(), { topic: "API v2/v3: rutas", que: "q", porque: "p" }, NOW);
    expect(r.path).toBe("Proyectos/app/Decisiones/API v2 v3 rutas.md");
  });

  test("tipo inválido falla", () => {
    // @ts-expect-error tipo fuera del enum
    expect(() => saveDecision(proj(), { topic: "X", tipo: "otro", que: "q", porque: "p" }, NOW)).toThrow(/tipo/);
  });
});

describe("logSession", () => {
  test("crea la Bitácora del día con las secciones no vacías", () => {
    const r = logSession(proj(), { tema: "informe spa", objetivo: "Armar el informe.", hecho: "- endpoint", proximos: "- UI" }, NOW);
    expect(r).toMatchObject({ path: "Proyectos/app/Bitácora/2026-10-29 - informe spa.md", action: "created" });
    const md = read(r.path);
    expect(md).toBe("# 2026-10-29 - informe spa\n\n## Objetivo\nArmar el informe.\n\n## Hecho\n- endpoint\n\n## Próximos pasos\n- UI\n");
  });

  test("mismo día y tema: suma a Hecho y reemplaza Próximos pasos", () => {
    logSession(proj(), { tema: "spa", hecho: "- a", proximos: "- b" }, NOW);
    const r = logSession(proj(), { tema: "spa", hecho: "- c", proximos: "- d", archivos: "x.ts" }, NOW);
    expect(r.action).toBe("updated");
    const md = read(r.path);
    expect(md).toContain("## Hecho\n- a\n- c");
    expect(md).toContain("## Próximos pasos\n- d");
    expect(md).not.toContain("- b");
    expect(md.indexOf("## Próximos pasos")).toBeLessThan(md.indexOf("## Archivos"));
  });

  test("sin contenido falla", () => {
    expect(() => logSession(proj(), { tema: "vacía" }, NOW)).toThrow(/al menos/i);
  });
});

describe("projectContext", () => {
  test("lista decisiones vigentes (marca vencidas, omite reemplazadas) y la última Bitácora", () => {
    const p = proj();
    saveDecision(p, { topic: "Vieja", tipo: "config", que: "q", porque: "p" }, new Date(2026, 0, 1)); // vence 2026-04-01
    saveDecision(p, { topic: "Nueva", tipo: "decision", que: "q", porque: "p" }, NOW);
    saveDecision(p, { topic: "Reemplazo", que: "q", porque: "p", reemplaza: "Vieja" }, new Date(2026, 0, 2));
    logSession(p, { tema: "uno", proximos: "- viejo" }, new Date(2026, 9, 1));
    logSession(p, { tema: "dos", proximos: "- seguir con X" }, NOW);
    const ctx = projectContext(p, { now: NOW });
    expect(ctx).toContain("vault `Equipo`");
    expect(ctx).toContain("- Nueva (decision)");
    expect(ctx).toContain("- Reemplazo (decision, REVISAR: vencida 2026-07-02)");
    expect(ctx).not.toContain("- Vieja");
    expect(ctx).toContain("Bitácora/2026-10-29 - dos.md");
    expect(ctx).toContain("- seguir con X");
    expect(ctx).not.toContain("- viejo");
    expect(ctx).toContain("save_decision");
  });

  test("después de compactar pide escribir la Bitácora primero", () => {
    expect(projectContext(proj(), { now: NOW, compacted: true })).toMatch(/compactar.*log_session/is);
  });

  test("proyecto vacío: lo dice y no falla", () => {
    expect(projectContext(proj(), { now: NOW })).toContain("Todavía no hay notas");
  });

  test("respeta maxChars", () => {
    const p = proj();
    for (let i = 0; i < 80; i++) saveDecision(p, { topic: `Tema largo número ${i}`, que: "q", porque: "p" }, NOW);
    const ctx = projectContext(p, { now: NOW, maxChars: 500 });
    expect(ctx.length).toBeLessThan(600);
    expect(ctx).toContain("truncado");
  });
});
