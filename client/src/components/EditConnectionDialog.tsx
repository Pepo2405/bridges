import { type Component, Show, createSignal, createEffect, untrack } from "solid-js";
import { Eye, EyeOff, Copy, Check } from "lucide-solid";
import { state, updateConnection } from "~/lib/store";
import { secretGet } from "~/lib/tauri";
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

const baseName = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

/** Editar una conexión guardada: nombre, server URL y token (revelable + copiable). */
export const EditConnectionDialog: Component<{
  vault: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}> = (props) => {
  const [name, setName] = createSignal("");
  const [serverUrl, setServerUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const [tokenLoaded, setTokenLoaded] = createSignal(false);
  const [reveal, setReveal] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const conn = () => state.connections.find((c) => c.vault === props.vault) ?? null;
  const isLocal = () => conn()?.serverUrl === null;

  // Al abrir, precargar valores actuales + el token del keychain.
  createEffect(() => {
    const v = props.vault;
    if (!props.open || !v) return;
    untrack(() => {
      const c = state.connections.find((x) => x.vault === v) ?? null;
      setName(c?.name ?? "");
      setServerUrl(c?.serverUrl ?? "");
      setReveal(false);
      setCopied(false);
      setErr(null);
      setToken("");
      setTokenLoaded(false);
    });
    secretGet(v)
      .then((t) => {
        if (props.vault === v) {
          setToken(t ?? "");
          setTokenLoaded(true);
        }
      })
      .catch(() => {});
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin clipboard: el token está visible para copiar a mano */
    }
  };

  const save = async () => {
    const v = props.vault;
    if (!v) return;
    if (!isLocal() && !serverUrl().trim()) return setErr("Poné una URL de servidor.");
    setBusy(true);
    setErr(null);
    try {
      const patch: { name: string; serverUrl?: string; token?: string } = { name: name() };
      if (!isLocal()) {
        patch.serverUrl = serverUrl().trim();
        if (tokenLoaded()) patch.token = token();
      }
      await updateConnection(v, patch);
      props.onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onOpenChange(false)}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Editar conexión</DialogTitle>
          <DialogDescription class="truncate">{props.vault}</DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-4">
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Nombre</label>
            <Input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={props.vault ? baseName(props.vault) : "Nombre visible"}
            />
          </div>

          <Show
            when={!isLocal()}
            fallback={<p class="text-xs text-muted-foreground">Vault local (sin servidor).</p>}
          >
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">Server URL</label>
              <Input
                value={serverUrl()}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
                placeholder="http://localhost:4321"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">Token (api key)</label>
              <div class="flex items-center gap-2">
                <Input
                  class="min-w-0 flex-1 font-mono"
                  type={reveal() ? "text" : "password"}
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                  placeholder="sin token"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReveal(!reveal())}
                  title={reveal() ? "Ocultar" : "Revelar"}
                >
                  {reveal() ? <EyeOff class="h-4 w-4" /> : <Eye class="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="outline" onClick={copy} title="Copiar" disabled={!token()}>
                  {copied() ? <Check class="h-4 w-4 text-emerald-500" /> : <Copy class="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </Show>

          <Show when={err()}>
            <p class="text-sm text-destructive">{err()}</p>
          </Show>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={busy()}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy()}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
