import { describe, it, expect, beforeEach } from "vitest";
import { renderToHtml, setWikiResolver } from "~/lib/markdown";
import { createResolver } from "~/lib/links";
import type { Doc } from "~/lib/api";

const doc = (id: string, path: string, content: string): Doc => ({ id, path, content }) as Doc;

const docs: Doc[] = [
  doc("id-beta", "Beta.md", "# Beta\n\ntexto beta\n\n## Sub\n\ndetalle\n\n- [ ] tarea embebida\n"),
  doc("id-gamma", "Gamma.md", "gamma con\n\n![[Beta]]\n"),
];

beforeEach(() => setWikiResolver(createResolver(docs)));

describe("callouts", () => {
  it("renderiza tipo, título y data-callout", () => {
    const html = renderToHtml("> [!warning] Ojo\n> cuerpo\n");
    expect(html).toContain('class="callout callout-warning"');
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain("<span>Ojo</span>");
  });

  it("tipo desconocido cae a note", () => {
    expect(renderToHtml("> [!bogus] x\n> y\n")).toContain("callout-note");
  });

  it("[!x]- arranca colapsado con data-fold", () => {
    const html = renderToHtml("> [!info]- t\n> body\n");
    expect(html).toContain("is-collapsed");
    expect(html).toContain('data-fold="collapsed"');
  });

  it("sin marcador de fold no lleva caret ni data-fold", () => {
    const html = renderToHtml("> [!info] t\n> body\n");
    expect(html).not.toContain("callout-caret");
    expect(html).not.toContain("data-fold");
  });

  it("el cuerpo soporta markdown (wikilink)", () => {
    expect(renderToHtml("> [!note] t\n> ver [[Beta]]\n")).toContain('data-doc-id="id-beta"');
  });
});

describe("tareas interactivas", () => {
  it("asigna data-task en orden y salta fences", () => {
    const html = renderToHtml("- [ ] a\n- [x] b\n\n```\n- [ ] fenced\n```\n\n- [ ] c\n");
    expect(html).toContain('data-task="0"');
    expect(html).toContain('data-task="1"');
    expect(html).toContain('data-task="2"');
    expect(html).not.toContain('data-task="3"');
    expect(html).not.toContain("disabled");
  });
});

describe("embeds", () => {
  it("![[Nota]] expande el contenido encajonado y navegable", () => {
    const html = renderToHtml("![[Beta]]\n");
    expect(html).toContain('class="embed"');
    expect(html).toContain('data-doc-id="id-beta"');
    expect(html).toContain("texto beta");
  });

  it("![[Nota#Heading]] muestra solo la sección", () => {
    const html = renderToHtml("![[Beta#Sub]]\n");
    expect(html).toContain("detalle");
    expect(html).not.toContain("texto beta");
  });

  it("tareas dentro de un embed van disabled y sin data-task", () => {
    const html = renderToHtml("![[Beta]]\n");
    expect(html).toContain('<input type="checkbox" disabled');
    expect(html).not.toContain("data-task");
  });

  it("target inexistente muestra embed-missing", () => {
    expect(renderToHtml("![[NoExiste]]\n")).toContain("embed-missing");
  });

  it("embed anidado no se expande (cap de profundidad)", () => {
    const html = renderToHtml("![[Gamma]]\n");
    expect(html).toContain('data-doc-id="id-gamma"');
    expect(html).not.toContain("texto beta");
  });
});
