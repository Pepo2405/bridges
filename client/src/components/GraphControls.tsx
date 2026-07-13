import { type Component, Show, createSignal, type Accessor, type Setter, type JSX } from "solid-js";
import { SlidersHorizontal, X, RotateCcw, Search, ChevronDown, ChevronRight } from "lucide-solid";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export type LabelMode = "auto" | "always" | "hover";

export type GraphSettings = {
  search: Accessor<string>;
  setSearch: Setter<string>;
  showPhantoms: Accessor<boolean>;
  setShowPhantoms: Setter<boolean>;
  showOrphans: Accessor<boolean>;
  setShowOrphans: Setter<boolean>;
  labelMode: Accessor<LabelMode>;
  setLabelMode: Setter<LabelMode>;
  repel: Accessor<number>;
  setRepel: Setter<number>;
  linkDist: Accessor<number>;
  setLinkDist: Setter<number>;
  gravity: Accessor<number>;
  setGravity: Setter<number>;
  spin: Accessor<boolean>;
  setSpin: Setter<boolean>;
  onReset: () => void;
};

const Toggle: Component<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = (props) => (
  <button
    onClick={() => props.onChange(!props.checked)}
    class="flex w-full items-center justify-between py-1.5 text-sm"
  >
    <span>{props.label}</span>
    <span
      class={cn(
        "relative h-4 w-7 rounded-full transition-colors",
        props.checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        class={cn(
          "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
          props.checked ? "left-3.5" : "left-0.5",
        )}
      />
    </span>
  </button>
);

const Slider: Component<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  format?: (v: number) => string;
}> = (props) => (
  <div class="py-1.5">
    <div class="mb-1 flex items-center justify-between text-xs">
      <span class="text-muted-foreground">{props.label}</span>
      <span class="tabular-nums">{props.format ? props.format(props.value) : props.value}</span>
    </div>
    <input
      type="range"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      class="h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
    />
  </div>
);

const Section: Component<{ title: string; children: JSX.Element; defaultOpen?: boolean }> = (props) => {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true);
  return (
    <div class="border-t py-2">
      <button
        onClick={() => setOpen((o) => !o)}
        class="flex w-full items-center gap-1 text-sm font-medium text-foreground"
      >
        {open() ? <ChevronDown class="h-3.5 w-3.5" /> : <ChevronRight class="h-3.5 w-3.5" />}
        {props.title}
      </button>
      <Show when={open()}>
        <div class="mt-1 pl-1">{props.children}</div>
      </Show>
    </div>
  );
};

export const GraphControls: Component<GraphSettings> = (props) => {
  const [open, setOpen] = createSignal(false);

  return (
    <Show
      when={open()}
      fallback={
        <button
          onClick={() => setOpen(true)}
          class="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border bg-card/90 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur transition-colors hover:bg-accent"
          title="Filtros y fuerzas"
        >
          <SlidersHorizontal class="h-3.5 w-3.5" />
          Filtros
        </button>
      }
    >
      <div class="absolute right-3 top-3 w-64 rounded-lg border bg-card/95 p-3 text-card-foreground shadow-lg backdrop-blur">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold">Filtros</span>
          <div class="flex items-center gap-1">
            <button onClick={props.onReset} class="rounded p-1 text-muted-foreground hover:text-foreground" title="Restablecer">
              <RotateCcw class="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setOpen(false)} class="rounded p-1 text-muted-foreground hover:text-foreground" title="Cerrar">
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div class="relative mt-2">
          <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            class="h-8 pl-8 text-xs"
            placeholder="Resaltar notas…"
            value={props.search()}
            onInput={(e) => props.setSearch(e.currentTarget.value)}
          />
        </div>

        <div class="mt-1">
          <Toggle label="Solo notas existentes" checked={!props.showPhantoms()} onChange={(v) => props.setShowPhantoms(!v)} />
          <Toggle label="Mostrar huérfanos" checked={props.showOrphans()} onChange={props.setShowOrphans} />
          <Toggle label="Rotación orbital" checked={props.spin()} onChange={props.setSpin} />
        </div>

        <Section title="Mostrar">
          <div class="flex gap-1">
            {(["auto", "always", "hover"] as const).map((mode) => (
              <button
                onClick={() => props.setLabelMode(mode)}
                class={cn(
                  "flex-1 rounded px-2 py-1 text-xs capitalize transition-colors",
                  props.labelMode() === mode ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode === "auto" ? "Auto" : mode === "always" ? "Siempre" : "Hover"}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Fuerzas">
          <Slider label="Repulsión" value={props.repel()} min={100} max={1600} step={50} onInput={props.setRepel} />
          <Slider label="Distancia de enlace" value={props.linkDist()} min={30} max={260} step={5} onInput={props.setLinkDist} />
          <Slider
            label="Gravedad"
            value={props.gravity()}
            min={0}
            max={0.4}
            step={0.01}
            onInput={props.setGravity}
            format={(v) => v.toFixed(2)}
          />
        </Section>
      </div>
    </Show>
  );
};
