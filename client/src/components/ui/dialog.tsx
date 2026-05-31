import type { Component, ComponentProps, ParentProps } from "solid-js";
import { splitProps } from "solid-js";
import { Dialog as KDialog } from "@kobalte/core/dialog";
import { X } from "lucide-solid";
import { cn } from "~/lib/utils";

export const Dialog = KDialog;
export const DialogTrigger = KDialog.Trigger;

export const DialogContent: Component<ParentProps<ComponentProps<typeof KDialog.Content>> & { class?: string }> = (
  props,
) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <KDialog.Portal>
      <KDialog.Overlay class="fixed inset-0 z-50 bg-black/60 data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0" />
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <KDialog.Content
          class={cn(
            "relative z-50 grid w-full max-w-lg gap-4 border bg-background p-6 shadow-lg rounded-lg data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95",
            local.class,
          )}
          {...rest}
        >
          {local.children}
          <KDialog.CloseButton class="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
            <X class="h-4 w-4" />
            <span class="sr-only">Cerrar</span>
          </KDialog.CloseButton>
        </KDialog.Content>
      </div>
    </KDialog.Portal>
  );
};

export const DialogHeader: Component<ParentProps<{ class?: string }>> = (props) => (
  <div class={cn("flex flex-col gap-1.5 text-left", props.class)}>{props.children}</div>
);

export const DialogTitle: Component<ParentProps<{ class?: string }>> = (props) => (
  <KDialog.Title class={cn("text-lg font-semibold", props.class)}>{props.children}</KDialog.Title>
);

export const DialogDescription: Component<ParentProps<{ class?: string }>> = (props) => (
  <KDialog.Description class={cn("text-sm text-muted-foreground", props.class)}>
    {props.children}
  </KDialog.Description>
);

export const DialogFooter: Component<ParentProps<{ class?: string }>> = (props) => (
  <div class={cn("flex justify-end gap-2", props.class)}>{props.children}</div>
);
