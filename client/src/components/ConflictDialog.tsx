import { type Component, Show } from "solid-js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import type { Doc } from "~/lib/api";

export type Conflict = { local: string; server: Doc };

/** Resolución manual de conflicto, estilo Git: quedate con la tuya / con la del server. */
export const ConflictDialog: Component<{
  conflict: Conflict | null;
  onKeepMine: () => void;
  onKeepServer: () => void;
  onClose: () => void;
  label?: string; // p.ej. "vault/archivo.md" para conflictos de sync de fondo
}> = (props) => {
  return (
    <Dialog open={!!props.conflict} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Conflicto de versión</DialogTitle>
          <DialogDescription>
            <Show when={props.label}>
              <span class="font-medium text-foreground">{props.label}</span> ·{" "}
            </Show>
            Alguien guardó este documento antes que vos. Elegí con qué versión quedarte.
          </DialogDescription>
        </DialogHeader>

        <Show when={props.conflict}>
          {(c) => (
            <div class="grid grid-cols-2 gap-3">
              <div class="flex flex-col gap-1.5">
                <span class="text-xs font-medium text-muted-foreground">Tu versión</span>
                <pre class="h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                  {c().local}
                </pre>
              </div>
              <div class="flex flex-col gap-1.5">
                <span class="text-xs font-medium text-muted-foreground">
                  Versión del server (v{c().server.version})
                </span>
                <pre class="h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                  {c().server.content}
                </pre>
              </div>
            </div>
          )}
        </Show>

        <DialogFooter>
          <Button variant="ghost" onClick={props.onKeepServer}>
            Quedarme con la del server
          </Button>
          <Button onClick={props.onKeepMine}>Sobrescribir con la mía</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
