import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { FilePlus, Pencil, Trash2, RefreshCw, ChevronLeft, RotateCcw } from "lucide-solid";
import { diffLines } from "diff";
import { activeApi } from "~/lib/store";
import type { Change } from "~/lib/api";
import { relativeTime } from "~/lib/time";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";

const ACTION = {
  create: { label: "creó", icon: FilePlus, class: "text-emerald-500" },
  update: { label: "editó", icon: Pencil, class: "text-amber-500" },
  delete: { label: "borró", icon: Trash2, class: "text-destructive" },
} as const;

/** Historial de una nota: log de cambios, diff de una versión vs. la actual, y restaurar. */
export const HistoryDialog: Component<{
  docId: string | null;
  path?: string;
  currentContent?: string;
  onRestore: (content: string) => void;
  onClose: () => void;
}> = (props) => {
  const [items, setItems] = createSignal<Change[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [selected, setSelected] = createSignal<Change | null>(null);
  const [verContent, setVerContent] = createSignal<string | null>(null);
  const [loadingVer, setLoadingVer] = createSignal(false);

  createEffect(() => {
    const id = props.docId;
    setSelected(null);
    setVerContent(null);
    if (!id) return;
    setLoading(true);
    setItems([]);
    const api = activeApi();
    if (!api) return setLoading(false);
    api
      .history(id)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  });

  const openDiff = async (c: Change) => {
    if (!props.docId) return;
    setSelected(c);
    setLoadingVer(true);
    setVerContent(null);
    try {
      setVerContent((await activeApi()?.version(props.docId, c.seq)) ?? null);
    } catch {
      setVerContent(null);
    } finally {
      setLoadingVer(false);
    }
  };

  // Diff de la versión seleccionada → contenido actual.
  const parts = () => {
    const v = verContent();
    if (v == null) return [];
    return diffLines(v, props.currentContent ?? "");
  };

  return (
    <Dialog open={!!props.docId} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>{selected() ? "Cambios desde esta versión" : "Historial"}</DialogTitle>
          <DialogDescription>{props.path}</DialogDescription>
        </DialogHeader>

        <Show
          when={selected()}
          fallback={
            <div class="max-h-80 overflow-auto">
              <Show
                when={!loading()}
                fallback={
                  <div class="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                    <RefreshCw class="h-4 w-4 animate-spin" />
                    Cargando…
                  </div>
                }
              >
                <For each={items()} fallback={<p class="py-6 text-center text-sm text-muted-foreground">Sin historial.</p>}>
                  {(c) => {
                    const a = ACTION[c.action as keyof typeof ACTION] ?? ACTION.update;
                    const canDiff = c.action !== "delete";
                    return (
                      <button
                        disabled={!canDiff}
                        onClick={() => canDiff && openDiff(c)}
                        class="flex w-full items-center gap-2.5 border-b py-2 text-left text-sm transition-colors last:border-0 enabled:hover:bg-accent disabled:cursor-default"
                      >
                        <a.icon class={`h-4 w-4 shrink-0 ${a.class}`} />
                        <span class="min-w-0 flex-1 truncate">
                          <span class="font-medium">{c.author ?? "alguien"}</span>{" "}
                          <span class="text-muted-foreground">{a.label}</span>
                        </span>
                        <span
                          class="shrink-0 text-xs text-muted-foreground"
                          title={new Date(c.created_at).toLocaleString("es-AR")}
                        >
                          {relativeTime(c.created_at)}
                        </span>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>
          }
        >
          <div class="flex items-center justify-between">
            <button
              onClick={() => setSelected(null)}
              class="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft class="h-3.5 w-3.5" />
              Volver
            </button>
            <Show when={verContent() != null}>
              <Button size="sm" variant="outline" onClick={() => props.onRestore(verContent()!)}>
                <RotateCcw class="h-4 w-4" />
                Restaurar esta versión
              </Button>
            </Show>
          </div>

          <div class="max-h-80 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
            <Show
              when={!loadingVer()}
              fallback={
                <div class="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                  <RefreshCw class="h-4 w-4 animate-spin" />
                  Cargando…
                </div>
              }
            >
              <Show when={verContent() != null} fallback={<p class="py-4 text-center text-muted-foreground">Sin snapshot de esta versión.</p>}>
                <For each={parts()}>
                  {(p) => (
                    <pre
                      class={
                        p.added
                          ? "whitespace-pre-wrap bg-emerald-500/15 text-emerald-300"
                          : p.removed
                            ? "whitespace-pre-wrap bg-destructive/15 text-destructive"
                            : "whitespace-pre-wrap text-muted-foreground"
                      }
                    >
                      {p.value.replace(/\n$/, "")}
                    </pre>
                  )}
                </For>
              </Show>
            </Show>
          </div>
          <p class="text-xs text-muted-foreground">
            <span class="text-emerald-400">verde</span> = está ahora y no en esta versión ·{" "}
            <span class="text-destructive">rojo</span> = estaba en esta versión y ya no.
          </p>
        </Show>
      </DialogContent>
    </Dialog>
  );
};
