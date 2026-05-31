import type { Component, ParentProps } from "solid-js";
import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { cn } from "~/lib/utils";

export const Tooltip = KTooltip;
export const TooltipTrigger = KTooltip.Trigger;

export const TooltipContent: Component<ParentProps<{ class?: string }>> = (props) => (
  <KTooltip.Portal>
    <KTooltip.Content
      class={cn(
        "z-50 max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
        "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0",
        props.class,
      )}
    >
      {props.children}
    </KTooltip.Content>
  </KTooltip.Portal>
);
