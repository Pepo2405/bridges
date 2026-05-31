import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { Boxes, Copy, Check, RefreshCw, Plus } from "lucide-solid";
import { activeApi } from "~/lib/store";
import type { VaultInfo } from "~/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Gestión de vaults del server (solo el owner). El token admin del vault nuevo
 *  se muestra una sola vez: con él se agrega el vault como una conexión más. */
export const VaultManager: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  const [vaults, setVaults] = createSignal<VaultInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [slug, setSlug] = createSignal("");
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [secret, setSecret] = createSignal<{ slug: string; token: string } | null>(null);
  const [copied, setCopied] = createSignal(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const api = activeApi();
      if (!api) return;
      setVaults(await api.listVaults());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    if (props.open) {
      setSecret(null);
      setSlug("");
      setName("");
      setErr(null);
      load();
    }
  });

  const create = async () => {
    const s = slug().trim();
    if (!SLUG_RE.test(s)) return setErr("Slug inválido: minúsculas, dígitos y guiones (ej: trabajo-2025).");
    setBusy(true);
    setErr(null);
    try {
      const api = activeApi();
      if (!api) throw new Error("Sin sesión activa.");
      const res = await api.createVault(s, name().trim() || s);
      setSecret({ slug: res.vault.slug, token: res.token });
      setSlug("");
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
          <DialogTitle>Vaults</DialogTitle>
          <DialogDescription>
            Cada vault es un espacio aislado en el server. Al crearlo se emite su token admin: usalo en «Agregar
            vault» con una carpeta local para conectarte.
          </DialogDescription>
        </DialogHeader>

        <Show when={secret()}>
          {(s) => (
            <div class="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
              <p class="mb-1.5 text-xs text-muted-foreground">
                Vault «{s().slug}» creado. Copiá su token admin ahora — no se vuelve a mostrar.
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
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Slug</label>
            <Input
              value={slug()}
              onInput={(e) => setSlug(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="ej: trabajo"
            />
          </div>
          <div class="min-w-0 flex-1">
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Nombre (opcional)</label>
            <Input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="ej: Trabajo"
            />
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
              each={vaults()}
              fallback={<p class="p-4 text-center text-sm text-muted-foreground">No hay vaults todavía.</p>}
            >
              {(v) => (
                <div class="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <Boxes class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate text-sm">{v.name}</span>
                  <span class="rounded-full border px-2 py-0.5 font-mono text-xs text-muted-foreground">{v.slug}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
};
