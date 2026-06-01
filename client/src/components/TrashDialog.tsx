import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { Trash2, RefreshCw, RotateCcw, FileX } from "lucide-solid";
import { activeApi, active, restoreFromTrash, purgeFromTrash } from "~/lib/store";
import { askConfirm } from "~/lib/confirm";
import type { TrashItem } from "~/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";

const fmtDate = (iso: string) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

/** Papelera del vault: docs borrados, con restaurar (editor+) y borrar definitivo (admin). */
export const TrashDialog: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  const [items, setItems] = createSignal<TrashItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const canRestore = () => active()?.perms.write ?? false;
  const canPurge = () => active()?.perms.delete ?? false;

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const api = activeApi();
      if (!api) return;
      setItems(await api.trash());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Al abrir: recargar la lista.
  createEffect(() => {
    if (props.open) load();
  });

  const restore = async (it: TrashItem) => {
    setBusy(it.id);
    if (await restoreFromTrash(it.id)) setItems((xs) => xs.filter((x) => x.id !== it.id));
    setBusy(null);
  };

  const purge = async (it: TrashItem) => {
    const ok = await askConfirm({
      title: "Borrar definitivamente",
      description: `"${it.title || it.path}" se borra para siempre. No se puede deshacer.`,
      confirmText: "Borrar definitivamente",
      destructive: true,
    });
    if (!ok) return;
    setBusy(it.id);
    if (await purgeFromTrash(it.id)) setItems((xs) => xs.filter((x) => x.id !== it.id));
    setBusy(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>Papelera</DialogTitle>
          <DialogDescription>
            Notas borradas del vault{active()?.remoteVaultName ? ` «${active()!.remoteVaultName}»` : " conectado"}.
            Restaurá una nota o borrala definitivamente.
          </DialogDescription>
        </DialogHeader>

        <Show when={err()}>
          <p class="text-sm text-destructive">{err()}</p>
        </Show>

        <div class="max-h-80 overflow-auto rounded-md border">
          <Show
            when={!loading()}
            fallback={
              <div class="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                <RefreshCw class="h-4 w-4 animate-spin" />
                Cargando…
              </div>
            }
          >
            <For
              each={items()}
              fallback={
                <div class="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
                  <FileX class="h-6 w-6" />
                  La papelera está vacía.
                </div>
              }
            >
              {(it) => (
                <div class="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm">{it.title || it.path}</div>
                    <div class="truncate text-xs text-muted-foreground">
                      {it.path} · {fmtDate(it.updated_at)}
                      {it.updated_by ? ` · ${it.updated_by}` : ""}
                    </div>
                  </div>
                  <Show when={canRestore()}>
                    <button
                      class="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      title="Restaurar"
                      disabled={busy() === it.id}
                      onClick={() => restore(it)}
                    >
                      <RotateCcw class="h-4 w-4" />
                    </button>
                  </Show>
                  <Show when={canPurge()}>
                    <button
                      class="rounded p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                      title="Borrar definitivamente"
                      disabled={busy() === it.id}
                      onClick={() => purge(it)}
                    >
                      <Trash2 class="h-4 w-4" />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
};
