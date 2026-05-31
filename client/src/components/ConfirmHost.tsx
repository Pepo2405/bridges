import { type Component, Show } from "solid-js";
import { pending, setPending } from "~/lib/confirm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";

/** Renderiza el diálogo de confirmación pedido por askConfirm(). Montar una vez. */
export const ConfirmHost: Component = () => {
  const close = (v: boolean) => {
    pending()?.resolve(v);
    setPending(null);
  };
  return (
    <Dialog open={!!pending()} onOpenChange={(o) => !o && close(false)}>
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>{pending()?.title}</DialogTitle>
          <Show when={pending()?.description}>
            <DialogDescription>{pending()!.description}</DialogDescription>
          </Show>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancelar
          </Button>
          <Button variant={pending()?.destructive ? "destructive" : "default"} onClick={() => close(true)}>
            {pending()?.confirmText ?? "Aceptar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
