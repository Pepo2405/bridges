import { type Component, Show, For, createSignal, createEffect } from "solid-js";
import { FolderOpen } from "lucide-solid";
import { state, connect, pickVaultAndInspect, importLocalDocs, browserMode, type VaultInspection } from "~/lib/store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const DEFAULT_SERVER = "http://localhost:4321";

/**
 * Flujo de agregar un vault: elegir server/token + carpeta, inspeccionar
 * colisiones y conectar (enfocando la nueva sesión). Reutilizable desde el
 * estado vacío y desde el switcher. Al conectar exitosamente, se cierra.
 */
export const AddVaultDialog: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  const [serverUrl, setServerUrl] = createSignal(DEFAULT_SERVER);
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<VaultInspection | null>(null);

  // Al abrir: prefijar con el server más usado y limpiar estado.
  createEffect(() => {
    if (props.open) {
      setServerUrl(state.connections[0]?.serverUrl ?? DEFAULT_SERVER);
      setToken("");
      setErr(null);
      setPending(null);
    }
  });

  const addNew = async () => {
    setBusy(true);
    setErr(null);
    try {
      const insp = await pickVaultAndInspect(serverUrl(), token().trim() || undefined);
      if (!insp) {
        setErr("No elegiste ninguna carpeta.");
      } else if (insp.localOnly.length || insp.conflicts.length) {
        setPending(insp); // hay notas locales o colisiones: que el usuario decida
      } else {
        await connect({ vault: insp.vault, serverUrl: insp.serverUrl, token: insp.token });
        props.onOpenChange(false);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finishConnect = async (doImport: boolean) => {
    const p = pending();
    if (!p) return;
    setBusy(true);
    setPending(null);
    try {
      await connect({ vault: p.vault, serverUrl: p.serverUrl, token: p.token });
      if (doImport) await importLocalDocs(p.localOnly);
      props.onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={props.open && !pending()} onOpenChange={(o) => !o && props.onOpenChange(false)}>
        <DialogContent class="max-w-md">
          <DialogHeader>
            <DialogTitle>Agregar vault</DialogTitle>
            <DialogDescription>
              {browserMode()
                ? "Modo browser: los archivos no se escriben a disco."
                : "Elegí una carpeta y el servidor al que sincroniza. La carpeta también la lee Claude Code."}
            </DialogDescription>
          </DialogHeader>

          <div class="space-y-2">
            <label class="text-xs font-medium text-muted-foreground" for="add-server">
              Servidor
            </label>
            <Input
              id="add-server"
              value={serverUrl()}
              onInput={(e) => setServerUrl(e.currentTarget.value)}
              placeholder={DEFAULT_SERVER}
            />
            <label class="text-xs font-medium text-muted-foreground" for="add-token">
              Token <span class="font-normal">(si el server lo pide)</span>
            </label>
            <Input
              id="add-token"
              type="password"
              value={token()}
              onInput={(e) => setToken(e.currentTarget.value)}
              placeholder="fg_…"
            />
          </div>

          <Show when={err()}>
            <p class="text-sm text-destructive">{err()}</p>
          </Show>

          <DialogFooter>
            <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={busy()}>
              Cancelar
            </Button>
            <Button onClick={addNew} disabled={busy()}>
              <FolderOpen class="h-4 w-4" />
              {browserMode() ? "Conectar (modo browser)" : "Elegir carpeta y conectar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pending()} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent class="max-w-md">
          <DialogHeader>
            <DialogTitle>Esta carpeta ya tiene notas</DialogTitle>
            <DialogDescription>
              Antes de conectar, decidí qué hacer con los archivos que ya están en la carpeta.
            </DialogDescription>
          </DialogHeader>

          <Show when={pending()?.localOnly.length}>
            <div class="rounded-md border p-3 text-sm">
              <p class="mb-1 font-medium">
                {pending()!.localOnly.length} nota{pending()!.localOnly.length === 1 ? "" : "s"} local
                {pending()!.localOnly.length === 1 ? "" : "es"} que no está
                {pending()!.localOnly.length === 1 ? "" : "n"} en el server.
              </p>
              <p class="text-xs text-muted-foreground">
                Importalas (se suben al server) o dejalas como están (no aparecen en Bridges hasta editarlas).
              </p>
            </div>
          </Show>

          <Show when={pending()?.conflicts.length}>
            <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p class="mb-1 font-medium text-amber-600">
                {pending()!.conflicts.length} archivo{pending()!.conflicts.length === 1 ? "" : "s"} se
                reemplazará{pending()!.conflicts.length === 1 ? "" : "n"} con la versión del server:
              </p>
              <ul class="mt-1 max-h-24 overflow-auto text-xs text-muted-foreground">
                <For each={pending()!.conflicts}>{(c) => <li class="truncate">· {c.path}</li>}</For>
              </ul>
            </div>
          </Show>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy()}>
              Cancelar
            </Button>
            <Show
              when={pending()?.localOnly.length}
              fallback={
                <Button onClick={() => finishConnect(false)} disabled={busy()}>
                  Conectar
                </Button>
              }
            >
              <Button variant="outline" onClick={() => finishConnect(false)} disabled={busy()}>
                Conectar sin importar
              </Button>
              <Button onClick={() => finishConnect(true)} disabled={busy()}>
                Importar y conectar
              </Button>
            </Show>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
