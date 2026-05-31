import type { Component, ComponentProps, ParentProps } from "solid-js";
import { splitProps } from "solid-js";
import { DropdownMenu as Kbd } from "@kobalte/core/dropdown-menu";
import { cn } from "~/lib/utils";

export const DropdownMenu = Kbd;
export const DropdownMenuTrigger = Kbd.Trigger;

export const DropdownMenuContent: Component<ParentProps<{ class?: string }>> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <Kbd.Portal>
      <Kbd.Content
        class={cn(
          "z-50 min-w-[11rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </Kbd.Content>
    </Kbd.Portal>
  );
};

type ItemProps = ParentProps<{ class?: string; onSelect?: () => void; destructive?: boolean }>;

export const DropdownMenuItem: Component<ItemProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children", "destructive"]);
  return (
    <Kbd.Item
      class={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground",
        local.destructive && "text-destructive focus:bg-destructive/10 focus:text-destructive",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </Kbd.Item>
  );
};

export const DropdownMenuSeparator: Component<ComponentProps<"div">> = (props) => (
  <Kbd.Separator class={cn("my-1 h-px bg-border", props.class)} />
);
