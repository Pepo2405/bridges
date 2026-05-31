import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { Key, Trash2, Copy, Check, RefreshCw, Plus } from "lucide-solid";
import { activeApi, active } from "~/lib/store";
import type { TokenInfo } from "~/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const ROLES = ["viewer", "editor", "admin"] as const;

/** Gestión de API keys (solo admin). El secreto se muestra una sola vez al crear. */
export const TokenManager: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  const [tokens, setTokens] = createSignal<TokenInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal<string>("editor");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [secret, setSecret] = createSignal<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = createSignal(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const api = activeApi();
      if (!api) return;
      setTokens(await api.listTokens());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Al abrir: limpiar y recargar la lista.
  createEffect(() => {
    if (props.open) {
      setSecret(null);
      setName("");
      setRole("editor");
      setErr(null);
      load();
    }
  });

  const create = async () => {
    const n = name().trim();
    if (!n) return setErr("Poné un nombre.");
    setBusy(true);
    setErr(null);
    try {
      const api = activeApi();
      if (!api) throw new Error("Sin sesión activa.");
      const res = await api.createToken(n, role());
      setSecret({ name: res.name, token: res.token });
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (n: string) => {
    if (!confirm(`¿Revocar el token "${n}"? Las apps que lo usen pierden acceso.`)) return;
    try {
      const api = activeApi();
      if (!api) return;
      await api.revokeToken(n);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async () => {
    const s = secret();
    if (!s) return;
    try {
      await navigator.clipboard.writeText(s.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin clipboard: el token está visible para copiar a mano */
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>API keys</DialogTitle>
          <DialogDescription>
            Tokens de acceso al vault{active()?.remoteVaultName ? ` «${active()!.remoteVaultName}»` : " conectado"}. El
            secreto se muestra una sola vez, al crearlo.
          </DialogDescription>
        </DialogHeader>

        <Show when={secret()}>
          {(s) => (
            <div class="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
              <p class="mb-1.5 text-xs text-muted-foreground">
                Token «{s().name}» creado. Copialo ahora — no se vuelve a mostrar.
              </p>
              <div class="flex items-center gap-2">
                <code class="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">
                  {s().token}
                </code>
                <Button size="sm" variant="outline" onClick={copy} title="Copiar">
                  {copied() ? <Check class="h-4 w-4 text-emerald-500" /> : <Copy class="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}
        </Show>

        <div class="flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Nombre</label>
            <Input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="ej: laptop-juan"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Rol</label>
            <select
              class="h-9 rounded-md border border-input bg-background px-3 text-sm capitalize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={role()}
              onChange={(e) => setRole(e.currentTarget.value)}
            >
              <For each={ROLES}>{(r) => <option value={r}>{r}</option>}</For>
            </select>
          </div>
          <Button onClick={create} disabled={busy()}>
            <Plus class="h-4 w-4" />
            Crear
          </Button>
        </div>

        <Show when={err()}>
          <p class="text-sm text-destructive">{err()}</p>
        </Show>

        <div class="max-h-64 overflow-auto rounded-md border">
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
              each={tokens()}
              fallback={<p class="p-4 text-center text-sm text-muted-foreground">No hay tokens todavía.</p>}
            >
              {(t) => (
                <div class="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <Key class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate text-sm">{t.name}</span>
                  <span class="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                    {t.role}
                  </span>
                  <button
                    class="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                    title="Revocar"
                    onClick={() => revoke(t.name)}
                  >
                    <Trash2 class="h-4 w-4" />
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
};
