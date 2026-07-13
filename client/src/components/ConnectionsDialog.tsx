import { type Component, For, Show, createSignal } from "solid-js";
import { FolderOpen, MoreVertical, Pencil, Unplug, Trash2 } from "lucide-solid";
import { state, closeSession, removeConnection } from "~/lib/store";
import { askConfirm } from "~/lib/confirm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/ui/dropdown-menu";
import { EditConnectionDialog } from "~/components/EditConnectionDialog";

const baseName = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

/** Gestión de conexiones guardadas: editar, desconectar (cerrar sesión), quitar. */
export const ConnectionsDialog: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  const [editVault, setEditVault] = createSignal<string | null>(null);

  const remove = async (vault: string) => {
    const ok = await askConfirm({
      title: "Quitar conexión",
      description: `"${baseName(vault)}" se saca de la lista y se borra su token guardado. La carpeta en disco no se toca.`,
      confirmText: "Quitar",
      destructive: true,
    });
    if (ok) await removeConnection(vault);
  };

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent class="max-w-lg">
          <DialogHeader>
            <DialogTitle>Conexiones</DialogTitle>
            <DialogDescription>Vaults guardados. Editá, desconectá o quitá cada uno.</DialogDescription>
          </DialogHeader>

          <div class="max-h-80 overflow-auto rounded-md border">
            <For
              each={state.connections}
              fallback={<p class="p-4 text-center text-sm text-muted-foreground">No hay conexiones guardadas.</p>}
            >
              {(conn) => (
                <div class="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <FolderOpen class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{conn.name ?? baseName(conn.vault)}</span>
                    <span class="block truncate text-xs text-muted-foreground">{conn.serverUrl ?? "local"}</span>
                  </span>
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {state.sessions[conn.vault] ? "abierta" : "cerrada"}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      title="Acciones"
                    >
                      <MoreVertical class="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setEditVault(conn.vault)}>
                        <Pencil class="h-4 w-4" />
                        Editar
                      </DropdownMenuItem>
                      <Show when={state.sessions[conn.vault]}>
                        <DropdownMenuItem onSelect={() => closeSession(conn.vault)}>
                          <Unplug class="h-4 w-4" />
                          Desconectar
                        </DropdownMenuItem>
                      </Show>
                      <DropdownMenuItem destructive onSelect={() => remove(conn.vault)}>
                        <Trash2 class="h-4 w-4" />
                        Quitar
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </For>
          </div>
        </DialogContent>
      </Dialog>

      <EditConnectionDialog
        vault={editVault()}
        open={!!editVault()}
        onOpenChange={(o) => !o && setEditVault(null)}
      />
    </>
  );
};
