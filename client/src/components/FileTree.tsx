import { type Component, For, Show, createSignal } from "solid-js";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  MoreVertical,
  Pencil,
  Trash2,
  FilePlus,
} from "lucide-solid";
import type { TreeNode } from "~/lib/markdown";
import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";

export type TreeAction = "rename" | "delete" | "new-in-folder" | "rename-folder" | "delete-folder";
export type Perms = { write: boolean; delete: boolean };

const ItemMenu: Component<{
  node: TreeNode;
  open: boolean;
  setOpen: (v: boolean) => void;
  perms: Perms;
  onAction: (action: TreeAction, node: TreeNode) => void;
}> = (props) => {
  const act = (a: TreeAction) => props.onAction(a, props.node);
  return (
    <DropdownMenu open={props.open} onOpenChange={props.setOpen}>
      <DropdownMenuTrigger
        class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[expanded]:opacity-100"
        onClick={(e: MouseEvent) => e.stopPropagation()}
        aria-label="Acciones"
      >
        <MoreVertical class="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <Show
          when={props.node.isDir}
          fallback={
            <>
              <DropdownMenuItem disabled={!props.perms.write} onSelect={() => act("rename")}>
                <Pencil class="h-4 w-4" /> Renombrar / mover
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive disabled={!props.perms.delete} onSelect={() => act("delete")}>
                <Trash2 class="h-4 w-4" /> Eliminar
              </DropdownMenuItem>
            </>
          }
        >
          <DropdownMenuItem disabled={!props.perms.write} onSelect={() => act("new-in-folder")}>
            <FilePlus class="h-4 w-4" /> Nueva nota aquí
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!props.perms.write} onSelect={() => act("rename-folder")}>
            <Pencil class="h-4 w-4" /> Renombrar carpeta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={!props.perms.delete} onSelect={() => act("delete-folder")}>
            <Trash2 class="h-4 w-4" /> Eliminar carpeta
          </DropdownMenuItem>
        </Show>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const TreeItem: Component<{
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  perms: Perms;
  onSelect: (docId: string) => void;
  onAction: (action: TreeAction, node: TreeNode) => void;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(true);
  const [menuOpen, setMenuOpen] = createSignal(false);

  const rowClass = "group flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-accent";

  return (
    <Show
      when={props.node.isDir}
      fallback={
        <div
          class={cn(rowClass, props.selectedId === props.node.docId && "bg-accent text-accent-foreground")}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
        >
          <button
            onClick={() => props.onSelect(props.node.docId!)}
            class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left text-sm"
            style={{ "padding-left": `${props.depth * 12 + 8}px` }}
          >
            <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="truncate">{props.node.name.replace(/\.md$/i, "")}</span>
          </button>
          <ItemMenu node={props.node} open={menuOpen()} setOpen={setMenuOpen} perms={props.perms} onAction={props.onAction} />
        </div>
      }
    >
      <div
        class={rowClass}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        <button
          onClick={() => setExpanded((o) => !o)}
          class="flex min-w-0 flex-1 items-center gap-1 py-1 pl-1 text-left text-sm font-medium"
          style={{ "padding-left": `${props.depth * 12 + 4}px` }}
        >
          {expanded() ? <ChevronDown class="h-3.5 w-3.5 shrink-0" /> : <ChevronRight class="h-3.5 w-3.5 shrink-0" />}
          {expanded() ? (
            <FolderOpen class="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder class="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span class="truncate">{props.node.name}</span>
        </button>
        <ItemMenu node={props.node} open={menuOpen()} setOpen={setMenuOpen} perms={props.perms} onAction={props.onAction} />
      </div>
      <Show when={expanded()}>
        <For each={props.node.children}>
          {(child) => (
            <TreeItem
              node={child}
              depth={props.depth + 1}
              selectedId={props.selectedId}
              perms={props.perms}
              onSelect={props.onSelect}
              onAction={props.onAction}
            />
          )}
        </For>
      </Show>
    </Show>
  );
};

export const FileTree: Component<{
  nodes: TreeNode[];
  selectedId: string | null;
  perms: Perms;
  onSelect: (docId: string) => void;
  onAction: (action: TreeAction, node: TreeNode) => void;
}> = (props) => {
  return (
    <div class="flex flex-col gap-0.5">
      <For each={props.nodes}>
        {(node) => (
          <TreeItem node={node} depth={0} selectedId={props.selectedId} perms={props.perms} onSelect={props.onSelect} onAction={props.onAction} />
        )}
      </For>
    </div>
  );
};
