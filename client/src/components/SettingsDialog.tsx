import { type Component, For, Show, createEffect, createSignal } from "solid-js";
import { Palette as PaletteIcon, Plus, Trash2, Pencil, Check, ArrowLeft } from "lucide-solid";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import {
  mode,
  setMode,
  type Mode,
  theme,
  palettes,
  activePaletteId,
  selectPalette,
  saveCustomTheme,
  deleteCustomTheme,
  hslToHex,
  hexToHsl,
} from "~/lib/theme";
import { EDITABLE_TOKENS, type Palette, type TokenKey } from "~/lib/palettes";

const MODES: { value: Mode; label: string }[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Oscuro" },
  { value: "system", label: "Sistema" },
];

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tema"
  );
}

/** Muestra de colores de una paleta en el modo activo. */
const Swatch: Component<{ palette: Palette }> = (props) => {
  const set = () => (theme() === "dark" ? props.palette.dark : props.palette.light);
  const dot = (token: TokenKey) => (
    <span
      class="h-4 w-4 rounded-full border border-border"
      style={{ "background-color": `hsl(${set()[token]})` }}
    />
  );
  return (
    <div class="flex items-center gap-1">
      {dot("background")}
      {dot("primary")}
      {dot("accent")}
      {dot("foreground")}
    </div>
  );
};

export const SettingsDialog: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  // Cuando hay un draft, mostramos el editor de tema custom; null = vista principal.
  const [draft, setDraft] = createSignal<Palette | null>(null);

  createEffect(() => {
    if (props.open) setDraft(null);
  });

  const startCreate = () => {
    const base = palettes().find((p) => p.id === activePaletteId()) ?? palettes()[0];
    setDraft({
      id: "",
      name: `${base.name} (copia)`,
      builtin: false,
      light: { ...base.light },
      dark: { ...base.dark },
    });
  };

  const startEdit = (p: Palette) => {
    setDraft({ ...p, light: { ...p.light }, dark: { ...p.dark } });
  };

  const updateToken = (m: "light" | "dark", key: TokenKey, hex: string) => {
    const d = draft();
    if (!d) return;
    setDraft({ ...d, [m]: { ...d[m], [key]: hexToHsl(hex) } });
  };

  const save = () => {
    const d = draft();
    if (!d) return;
    const name = d.name.trim() || "Tema";
    // id estable: si ya tiene (edición) lo conservamos; si no, derivamos del nombre y desambiguamos.
    let id = d.id;
    if (!id) {
      const taken = new Set(palettes().map((p) => p.id));
      const baseId = slugify(name);
      id = baseId;
      let n = 2;
      while (taken.has(id)) id = `${baseId}-${n++}`;
    }
    saveCustomTheme({ ...d, id, name, builtin: false });
    selectPalette(id);
    setDraft(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-xl">
        <Show
          when={draft()}
          fallback={
            <>
              <DialogHeader>
                <DialogTitle>Configuración</DialogTitle>
                <DialogDescription>Apariencia de la app. Se guarda en este dispositivo.</DialogDescription>
              </DialogHeader>

              {/* Modo */}
              <div class="space-y-2">
                <p class="text-sm font-medium">Modo</p>
                <div class="inline-flex rounded-md border border-input p-0.5">
                  <For each={MODES}>
                    {(m) => (
                      <button
                        onClick={() => setMode(m.value)}
                        class={cn(
                          "rounded px-3 py-1 text-sm transition-colors",
                          mode() === m.value
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {m.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              {/* Tema (paleta) */}
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <p class="text-sm font-medium">Tema</p>
                  <Button size="sm" variant="ghost" onClick={startCreate}>
                    <Plus class="h-4 w-4" />
                    Crear tema
                  </Button>
                </div>
                <div class="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto">
                  <For each={palettes()}>
                    {(p) => (
                      <div
                        onClick={() => selectPalette(p.id)}
                        class={cn(
                          "group flex cursor-pointer items-center justify-between gap-2 rounded-md border p-3 transition-colors hover:bg-accent",
                          activePaletteId() === p.id ? "border-primary ring-1 ring-primary" : "border-border",
                        )}
                      >
                        <div class="flex flex-col gap-1.5 overflow-hidden">
                          <span class="flex items-center gap-1.5 text-sm font-medium">
                            <Show when={activePaletteId() === p.id}>
                              <Check class="h-3.5 w-3.5 text-primary" />
                            </Show>
                            <span class="truncate">{p.name}</span>
                          </span>
                          <Swatch palette={p} />
                        </div>
                        <Show when={!p.builtin}>
                          <div class="flex shrink-0 flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              title="Editar"
                              class="rounded p-1 text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                startEdit(p);
                              }}
                            >
                              <Pencil class="h-3.5 w-3.5" />
                            </button>
                            <button
                              title="Eliminar"
                              class="rounded p-1 text-muted-foreground hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteCustomTheme(p.id);
                              }}
                            >
                              <Trash2 class="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </>
          }
        >
          {/* Editor de tema custom */}
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              <PaletteIcon class="h-4 w-4" />
              {draft()!.id ? "Editar tema" : "Nuevo tema"}
            </DialogTitle>
            <DialogDescription>Editá los colores principales para claro y oscuro.</DialogDescription>
          </DialogHeader>

          <div class="space-y-1">
            <label class="text-xs text-muted-foreground" for="theme-name">
              Nombre
            </label>
            <Input
              id="theme-name"
              value={draft()!.name}
              placeholder="Ej: Mi tema"
              onInput={(e) => setDraft({ ...draft()!, name: e.currentTarget.value })}
            />
          </div>

          <div class="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
            <div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 px-1 text-xs text-muted-foreground">
              <span>Token</span>
              <span class="w-10 text-center">Claro</span>
              <span class="w-10 text-center">Oscuro</span>
            </div>
            <For each={EDITABLE_TOKENS}>
              {(t) => (
                <div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 px-1">
                  <span class="text-sm">{t.label}</span>
                  <input
                    type="color"
                    class="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                    value={hslToHex(draft()!.light[t.key])}
                    onInput={(e) => updateToken("light", t.key, e.currentTarget.value)}
                  />
                  <input
                    type="color"
                    class="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                    value={hslToHex(draft()!.dark[t.key])}
                    onInput={(e) => updateToken("dark", t.key, e.currentTarget.value)}
                  />
                </div>
              )}
            </For>
          </div>

          <div class="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              <ArrowLeft class="h-4 w-4" />
              Volver
            </Button>
            <Button onClick={save}>
              <Check class="h-4 w-4" />
              Guardar
            </Button>
          </div>
        </Show>
      </DialogContent>
    </Dialog>
  );
};
