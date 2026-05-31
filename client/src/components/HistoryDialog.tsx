import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { FilePlus, Pencil, Trash2, RefreshCw } from "lucide-solid";
import { api } from "~/lib/store";
import type { Change } from "~/lib/api";
import { relativeTime } from "~/lib/time";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";

const ACTION = {
  create: { label: "creó", icon: FilePlus, class: "text-emerald-500" },
  update: { label: "editó", icon: Pencil, class: "text-amber-500" },
  delete: { label: "borró", icon: Trash2, class: "text-destructive" },
} as const;

/** Historial de cambios de una nota (quién, qué, cuándo). */
export const HistoryDialog: Component<{ docId: string | null; path?: string; onClose: () => void }> = (props) => {
  const [items, setItems] = createSignal<Change[]>([]);
  const [loading, setLoading] = createSignal(false);

  createEffect(() => {
    const id = props.docId;
    if (!id) return;
    setLoading(true);
    setItems([]);
    api
      .history(id)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  });

  return (
    <Dialog open={!!props.docId} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Historial</DialogTitle>
          <DialogDescription>{props.path}</DialogDescription>
        </DialogHeader>
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
                return (
                  <div class="flex items-center gap-2.5 border-b py-2 text-sm last:border-0">
                    <a.icon class={`h-4 w-4 shrink-0 ${a.class}`} />
                    <span class="min-w-0 flex-1 truncate">
                      <span class="font-medium">{c.author ?? "alguien"}</span>{" "}
                      <span class="text-muted-foreground">{a.label}</span>
                    </span>
                    <span class="shrink-0 text-xs text-muted-foreground" title={new Date(c.created_at).toLocaleString("es-AR")}>
                      {relativeTime(c.created_at)}
                    </span>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
};
