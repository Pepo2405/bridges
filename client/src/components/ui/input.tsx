import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import { cn } from "~/lib/utils";

export const Input: Component<ComponentProps<"input">> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <input
      class={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        local.class,
      )}
      {...rest}
    />
  );
};
