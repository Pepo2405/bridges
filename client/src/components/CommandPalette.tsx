import { type Component, For, Show, createSignal, createMemo, createEffect } from "solid-js";
import { Dialog as KDialog } from "@kobalte/core/dialog";
import { Search } from "lucide-solid";
import { cn } from "~/lib/utils";

export type Command = {
  id: string;
  label: string;
  hint?: string; // texto a la derecha (carpeta, atajo…)
  group?: string; // sección
  run: () => void;
};

/** Paleta de comandos (Cmd+K): filtra y ejecuta comandos con el teclado. */
export const CommandPalette: Component<{
  open: boolean;
  onOpenChange: (o: boolean) => void;
  commands: () => Command[];
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const all = props.commands();
    if (!q) return all;
    return all.filter((c) => (c.label + " " + (c.hint ?? "")).toLowerCase().includes(q));
  });

  // Agrupa preservando el orden y guardando el índice plano (para nav/resaltado).
  const grouped = createMemo(() => {
    const groups: { name: string; items: { cmd: Command; index: number }[] }[] = [];
    filtered().forEach((cmd, index) => {
      const name = cmd.group ?? "";
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, items: [] }));
      g.items.push({ cmd, index });
    });
    return groups;
  });

  createEffect(() => {
    if (props.open) {
      setQuery("");
      setActive(0);
      queueMicrotask(() => inputRef?.focus());
    }
  });

  // Mantener el índice activo dentro de rango cuando cambia el filtro.
  createEffect(() => {
    if (active() >= filtered().length) setActive(0);
  });

  const run = (cmd: Command) => {
    props.onOpenChange(false);
    cmd.run();
  };

  const onKey = (e: KeyboardEvent) => {
    const items = filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active()];
      if (it) run(it);
    }
  };

  return (
    <KDialog open={props.open} onOpenChange={props.onOpenChange}>
      <KDialog.Portal>
        <KDialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
        <div class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
          <KDialog.Content
            class="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <div class="flex items-center gap-2 border-b px-3">
              <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onKey}
                placeholder="Buscar notas o acciones…"
                class="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div class="max-h-80 overflow-auto p-1">
              <Show
                when={filtered().length}
                fallback={<p class="px-3 py-6 text-center text-sm text-muted-foreground">Sin resultados</p>}
              >
                <For each={grouped()}>
                  {(g) => (
                    <>
                      <Show when={g.name}>
                        <p class="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{g.name}</p>
                      </Show>
                      <For each={g.items}>
                        {({ cmd, index }) => (
                          <button
                            onClick={() => run(cmd)}
                            onMouseEnter={() => setActive(index)}
                            class={cn(
                              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                              index === active() ? "bg-accent text-accent-foreground" : "text-foreground",
                            )}
                          >
                            <span class="min-w-0 flex-1 truncate">{cmd.label}</span>
                            <Show when={cmd.hint}>
                              <span class="shrink-0 truncate text-xs text-muted-foreground">{cmd.hint}</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
            </div>
          </KDialog.Content>
        </div>
      </KDialog.Portal>
    </KDialog>
  );
};
