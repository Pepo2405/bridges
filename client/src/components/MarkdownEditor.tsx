import { type Component, onMount, onCleanup, createEffect } from "solid-js";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, Decoration, MatchDecorator } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

export type LinkTarget = { label: string; path: string };

/** Autocompletado de [[wikilinks]]: al tipear `[[` ofrece los nombres de notas. */
function wikilinkCompletions(targets: () => LinkTarget[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^\]\n]*$/); // `[[` seguido de lo tipeado, sin cerrar
    if (!before) return null;
    return {
      from: before.from + 2, // justo después de `[[`
      options: targets().map((it) => ({
        label: it.label,
        detail: it.path.includes("/") ? it.path.replace(/\/[^/]+$/, "") : undefined,
        apply: it.label + "]]",
      })),
      validFor: /^[^\]\n]*$/,
    };
  };
}

// Resaltado de markdown atado al look de la app. Los colores usan los tokens
// (hsl(var(--…))) para seguir el tema claro/oscuro.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "hsl(217 91% 66%)" },
  { tag: t.url, color: "hsl(var(--muted-foreground))" },
  { tag: t.monospace, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: "hsl(var(--muted-foreground))" },
  { tag: t.quote, color: "hsl(var(--muted-foreground))", fontStyle: "italic" },
  { tag: t.list, color: "hsl(var(--primary))" },
  { tag: [t.processingInstruction, t.meta], color: "hsl(var(--muted-foreground))" },
]);

// [[wikilinks]] coloreados (no son markdown estándar; los decoramos por regex).
const wikilinkMatcher = new MatchDecorator({
  regexp: /\[\[[^\]\n]+\]\]/g,
  decoration: Decoration.mark({ class: "cm-wikilink" }),
});
const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) {
      this.deco = wikilinkMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.deco = wikilinkMatcher.updateDeco(u, this.deco);
    }
  },
  { decorations: (v) => v.deco },
);

const theme = EditorView.theme({
  "&": { height: "100%", color: "hsl(var(--foreground))", backgroundColor: "transparent", fontSize: "0.95rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', lineHeight: "1.7", overflow: "auto" },
  // Columna centrada de ancho cómodo + room para "typewriter scroll".
  ".cm-content": { maxWidth: "46rem", margin: "0 auto", padding: "1.75rem 1.25rem 30vh", caretColor: "hsl(var(--foreground))" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--foreground))" },
  ".cm-selectionBackground": { backgroundColor: "hsl(var(--primary) / 0.18)" },
  "&.cm-focused .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "hsl(var(--primary) / 0.24)" },
  ".cm-wikilink": { color: "hsl(217 91% 66%)" },
});

/** Editor de markdown (CodeMirror 6). Controlado: `value` entra, `onChange` sale. */
export const MarkdownEditor: Component<{
  value: string;
  readOnly?: boolean;
  linkTargets?: () => LinkTarget[];
  onChange: (v: string) => void;
  onSave?: () => void;
}> = (props) => {
  let parent!: HTMLDivElement;
  let view: EditorView | undefined;
  const editable = new Compartment();
  let applyingExternal = false; // evita re-emitir onChange cuando el cambio vino de afuera

  onMount(() => {
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (props.onSave?.(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          markdown(),
          syntaxHighlighting(mdHighlight),
          wikilinkPlugin,
          autocompletion({ override: [wikilinkCompletions(() => props.linkTargets?.() ?? [])], activateOnTyping: true }),
          EditorView.lineWrapping,
          theme,
          editable.of([EditorView.editable.of(!props.readOnly), EditorState.readOnly.of(!!props.readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applyingExternal) props.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
  });

  // Cambió `value` desde afuera (otro doc, edición externa por SSE/watcher): reemplazar.
  createEffect(() => {
    const v = props.value;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (v === cur) return;
    applyingExternal = true;
    view.dispatch({ changes: { from: 0, to: cur.length, insert: v } });
    applyingExternal = false;
  });

  // Cambió el permiso de escritura.
  createEffect(() => {
    const ro = !!props.readOnly;
    if (!view) return;
    view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(!ro), EditorState.readOnly.of(ro)]) });
  });

  onCleanup(() => view?.destroy());

  return <div ref={parent} class="min-h-0 flex-1 overflow-hidden" />;
};
