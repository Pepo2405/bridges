import { type Component, For, Show, createSignal } from "solid-js";
import { Link2, ChevronDown, ChevronUp } from "lucide-solid";
import type { Doc } from "~/lib/api";
import { displayName } from "~/lib/links";

/** Panel de backlinks: notas que enlazan a la nota actual (estilo Obsidian). */
export const Backlinks: Component<{ backlinks: Doc[]; onSelect: (docId: string) => void }> = (props) => {
  const [open, setOpen] = createSignal(true);

  return (
    <div class="shrink-0 border-t bg-card/40">
      <button
        onClick={() => setOpen((o) => !o)}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Link2 class="h-3.5 w-3.5" />
        Backlinks
        <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{props.backlinks.length}</span>
        <span class="ml-auto">
          {open() ? <ChevronDown class="h-3.5 w-3.5" /> : <ChevronUp class="h-3.5 w-3.5" />}
        </span>
      </button>
      <Show when={open()}>
        <div class="max-h-40 overflow-auto px-2 pb-2">
          <Show
            when={props.backlinks.length}
            fallback={<p class="px-1 py-2 text-xs text-muted-foreground">Ninguna nota enlaza a esta todavía.</p>}
          >
            <For each={props.backlinks}>
              {(doc) => (
                <button
                  onClick={() => props.onSelect(doc.id)}
                  class="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <span class="truncate text-sm">{displayName(doc.path)}</span>
                  <span class="truncate text-xs text-muted-foreground">{doc.path}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};
