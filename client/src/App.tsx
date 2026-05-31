import { type Component, type ParentProps, Show, For, createSignal, createMemo, createEffect, onMount, onCleanup, untrack } from "solid-js";
import {
  Search,
  Plus,
  Save,
  Trash2,
  FolderOpen,
  Wifi,
  WifiOff,
  RefreshCw,
  Hammer,
  Eye,
  Pencil,
  Network,
  FileText,
  Info,
  X,
  ChevronsUpDown,
  KeyRound,
  Sun,
  Moon,
  List,
  History,
} from "lucide-solid";
import {
  state,
  docList,
  saveDoc,
  deleteDoc,
  moveDoc,
  renameFolder,
  deleteFolder,
  pickVaultAndInspect,
  importLocalDocs,
  type VaultInspection,
  connect,
  disconnect,
  removeConnection,
  boot,
  pull,
  api,
  browserMode,
  setNotice,
} from "~/lib/store";
import { buildTree, renderMarkdown, setWikiResolver } from "~/lib/markdown";
import { buildBacklinks, createResolver, displayName } from "~/lib/links";
import type { Doc, SearchHit } from "~/lib/api";
import { FileTree, type TreeAction } from "~/components/FileTree";
import type { TreeNode } from "~/lib/markdown";
import { GraphView } from "~/components/GraphView";
import { Backlinks } from "~/components/Backlinks";
import { ConflictDialog, type Conflict } from "~/components/ConflictDialog";
import { TokenManager } from "~/components/TokenManager";
import { MarkdownEditor } from "~/components/MarkdownEditor";
import { ConfirmHost } from "~/components/ConfirmHost";
import { CommandPalette, type Command } from "~/components/CommandPalette";
import { HistoryDialog } from "~/components/HistoryDialog";
import { relativeTime } from "~/lib/time";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/ui/dropdown-menu";
import { askConfirm } from "~/lib/confirm";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "~/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { theme, toggleTheme } from "~/lib/theme";
import { cn } from "~/lib/utils";

function vaultName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

// Mensajes de permiso insuficiente (tooltip de los controles bloqueados).
const NO_WRITE = "Tu token no tiene permiso de escritura en este vault.";
const NO_DELETE = "Tu token no tiene permiso para borrar en este vault.";

/**
 * Envuelve un control: si `when` es falso, lo muestra deshabilitado con un
 * tooltip explicando por qué. El trigger es un <span> (no el botón) porque un
 * botón con pointer-events cortados no recibe el hover que dispara el tooltip.
 */
const Gated: Component<ParentProps<{ when: boolean; reason: string }>> = (props) => (
  <Show when={props.when} fallback={
    <Tooltip openDelay={150}>
      <TooltipTrigger as="span" class="inline-flex cursor-not-allowed">
        <span class="pointer-events-none opacity-50">{props.children}</span>
      </TooltipTrigger>
      <TooltipContent>{props.reason}</TooltipContent>
    </Tooltip>
  }>
    {props.children}
  </Show>
);

const BootSplash: Component = () => (
  <div class="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
    <Hammer class="h-7 w-7 text-primary" />
    <RefreshCw class="h-4 w-4 animate-spin" />
    <span class="text-sm">Conectando…</span>
  </div>
);

const ConnectionManager: Component = () => {
  const [serverUrl, setServerUrl] = createSignal(state.connections[0]?.serverUrl ?? state.serverUrl);
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const openSaved = async (conn: { vault: string; serverUrl: string; token?: string }) => {
    setBusy(conn.vault);
    setErr(null);
    try {
      await connect({ vault: conn.vault, serverUrl: conn.serverUrl, token: conn.token });
    } catch (e) {
      setErr(`No se pudo abrir "${vaultName(conn.vault)}": ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const [pending, setPending] = createSignal<VaultInspection | null>(null);

  const addNew = async () => {
    setBusy("new");
    setErr(null);
    try {
      const insp = await pickVaultAndInspect(serverUrl(), token().trim() || undefined);
      if (!insp) {
        setErr("No elegiste ninguna carpeta.");
      } else if (insp.localOnly.length || insp.conflicts.length) {
        setPending(insp); // hay notas locales o colisiones: que el usuario decida
      } else {
        await connect({ vault: insp.vault, serverUrl: insp.serverUrl, token: insp.token });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const finishConnect = async (doImport: boolean) => {
    const p = pending();
    if (!p) return;
    setBusy("new");
    setPending(null);
    try {
      await connect({ vault: p.vault, serverUrl: p.serverUrl, token: p.token });
      if (doImport) await importLocalDocs(p.localOnly);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <div class="flex h-full items-center justify-center p-6">
      <div class="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <div class="mb-1 flex items-center gap-2">
          <Hammer class="h-5 w-5 text-primary" />
          <h1 class="text-2xl font-semibold">Forge</h1>
        </div>
        <p class="mb-5 text-sm text-muted-foreground">
          {browserMode()
            ? "Modo browser: los archivos no se escriben a disco."
            : "Elegí un vault para abrir. La carpeta también la lee Claude Code."}
        </p>

        <Show when={state.connections.length}>
          <div class="mb-4 flex flex-col gap-1">
            <span class="mb-1 text-xs font-medium text-muted-foreground">Conexiones guardadas</span>
            <For each={state.connections}>
              {(conn) => (
                <div class="group flex items-center gap-2 rounded-md border p-2 transition-colors hover:bg-accent">
                  <button class="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => openSaved(conn)} disabled={!!busy()}>
                    <FolderOpen class="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium">{vaultName(conn.vault)}</span>
                      <span class="block truncate text-xs text-muted-foreground">{conn.serverUrl}</span>
                    </span>
                    <Show when={busy() === conn.vault}>
                      <RefreshCw class="ml-auto h-3.5 w-3.5 shrink-0 animate-spin" />
                    </Show>
                  </button>
                  <button
                    class="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    title="Quitar de la lista"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeConnection(conn.vault);
                    }}
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="space-y-2 border-t pt-4">
          <label class="text-xs font-medium text-muted-foreground" for="server">
            Agregar vault — servidor
          </label>
          <Input id="server" value={serverUrl()} onInput={(e) => setServerUrl(e.currentTarget.value)} placeholder="http://localhost:4321" />
          <label class="text-xs font-medium text-muted-foreground" for="token">
            Token <span class="font-normal">(si el server lo pide)</span>
          </label>
          <Input
            id="token"
            type="password"
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
            placeholder="fg_…"
          />
          <Button class="w-full" onClick={addNew} disabled={!!busy()}>
            <FolderOpen class="h-4 w-4" />
            {browserMode() ? "Conectar (modo browser)" : "Elegir carpeta y conectar"}
          </Button>
        </div>

        <Show when={err()}>
          <p class="mt-3 text-sm text-destructive">{err()}</p>
        </Show>
      </div>
    </div>

    <Dialog open={!!pending()} onOpenChange={(o) => !o && setPending(null)}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Esta carpeta ya tiene notas</DialogTitle>
          <DialogDescription>
            Antes de conectar, decidí qué hacer con los archivos que ya están en la carpeta.
          </DialogDescription>
        </DialogHeader>

        <Show when={pending()?.localOnly.length}>
          <div class="rounded-md border p-3 text-sm">
            <p class="mb-1 font-medium">
              {pending()!.localOnly.length} nota{pending()!.localOnly.length === 1 ? "" : "s"} local
              {pending()!.localOnly.length === 1 ? "" : "es"} que no está
              {pending()!.localOnly.length === 1 ? "" : "n"} en el server.
            </p>
            <p class="text-xs text-muted-foreground">
              Importalas (se suben al server) o dejalas como están (no aparecen en Forge hasta editarlas).
            </p>
          </div>
        </Show>

        <Show when={pending()?.conflicts.length}>
          <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p class="mb-1 font-medium text-amber-600">
              {pending()!.conflicts.length} archivo{pending()!.conflicts.length === 1 ? "" : "s"} se
              reemplazará{pending()!.conflicts.length === 1 ? "" : "n"} con la versión del server:
            </p>
            <ul class="mt-1 max-h-24 overflow-auto text-xs text-muted-foreground">
              <For each={pending()!.conflicts}>{(c) => <li class="truncate">· {c.path}</li>}</For>
            </ul>
          </div>
        </Show>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setPending(null)} disabled={!!busy()}>
            Cancelar
          </Button>
          <Show
            when={pending()?.localOnly.length}
            fallback={
              <Button onClick={() => finishConnect(false)} disabled={!!busy()}>
                Conectar
              </Button>
            }
          >
            <Button variant="outline" onClick={() => finishConnect(false)} disabled={!!busy()}>
              Conectar sin importar
            </Button>
            <Button onClick={() => finishConnect(true)} disabled={!!busy()}>
              Importar y conectar
            </Button>
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
};

const SyncStatus: Component = () => (
  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <Show when={state.syncing}>
      <RefreshCw class="h-3.5 w-3.5 animate-spin" />
      <span>Sincronizando…</span>
    </Show>
    <Show when={!state.syncing}>
      <Show
        when={state.connected}
        fallback={
          <>
            <WifiOff class="h-3.5 w-3.5 text-destructive" />
            <span>Sin conexión</span>
          </>
        }
      >
        <Wifi class="h-3.5 w-3.5 text-emerald-500" />
        <span>En vivo · seq {state.lastSeq}</span>
      </Show>
    </Show>
  </div>
);

const NewDocDialog: Component<{
  open: boolean;
  initial?: string;
  onOpenChange: (o: boolean) => void;
  onCreate: (path: string) => void;
}> = (props) => {
  const [path, setPath] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);

  // Al abrir, prefijar con la carpeta (si vino) y limpiar errores.
  createEffect(() => {
    if (props.open) {
      setPath(props.initial ?? "");
      setErr(null);
    }
  });

  const submit = () => {
    let p = path().trim().replace(/^\/+/, "");
    if (!p) return setErr("Escribí una ruta.");
    if (!p.endsWith(".md")) p += ".md";
    if (p.includes("..")) return setErr("La ruta no puede salir del vault.");
    props.onCreate(p);
    setPath("");
    setErr(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo documento</DialogTitle>
          <DialogDescription>Ruta relativa dentro del vault, ej: pixel/setup.md</DialogDescription>
        </DialogHeader>
        <Input
          autofocus
          value={path()}
          onInput={(e) => setPath(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Ej: pixel/setup.md"
        />
        <Show when={err()}>
          <p class="text-sm text-destructive">{err()}</p>
        </Show>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit}>Crear</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

type RenameTarget = { kind: "file" | "folder"; path: string; docId?: string };

const RenameDialog: Component<{
  target: RenameTarget | null;
  onClose: () => void;
  onSubmit: (target: RenameTarget, newPath: string) => void;
}> = (props) => {
  const [value, setValue] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.target) {
      setValue(props.target.path);
      setErr(null);
    }
  });

  const submit = () => {
    const t = props.target;
    if (!t) return;
    let p = value().trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!p) return setErr("La ruta no puede estar vacía.");
    if (p.includes("..")) return setErr("La ruta no puede salir del vault.");
    if (t.kind === "file" && !p.endsWith(".md")) p += ".md";
    props.onSubmit(t, p);
  };

  return (
    <Dialog open={!!props.target} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{props.target?.kind === "folder" ? "Renombrar carpeta" : "Renombrar / mover"}</DialogTitle>
          <DialogDescription>
            {props.target?.kind === "folder"
              ? "Cambiá el nombre o la ubicación. Se actualizan todas las notas adentro."
              : "Cambiá el nombre o movela a otra carpeta (ruta relativa dentro del vault)."}
          </DialogDescription>
        </DialogHeader>
        <Input
          autofocus
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Show when={err()}>
          <p class="text-sm text-destructive">{err()}</p>
        </Show>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button onClick={submit}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const App: Component = () => {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [baseVersion, setBaseVersion] = createSignal(1);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [conflict, setConflict] = createSignal<Conflict | null>(null);
  const [showNew, setShowNew] = createSignal(false);
  const [showTokens, setShowTokens] = createSignal(false);
  const [showPalette, setShowPalette] = createSignal(false);
  const [historyDocId, setHistoryDocId] = createSignal<string | null>(null);
  const [newPrefill, setNewPrefill] = createSignal("");
  const [renameTarget, setRenameTarget] = createSignal<RenameTarget | null>(null);
  const [mode, setMode] = createSignal<"edit" | "preview">("edit");
  const [editorApi, setEditorApi] = createSignal<{ scrollToLine: (line: number) => void } | null>(null);
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [view, setView] = createSignal<"editor" | "graph">("editor");

  const docs = createMemo(() => docList());
  const tree = createMemo(() => buildTree(docs().map((d) => ({ id: d.id, path: d.path }))));
  const current = createMemo<Doc | null>(() => {
    const id = selectedId();
    return id ? state.docs[id] ?? null : null;
  });

  // Cargar el doc en el editor. Reacciona a `current()`, que cambia tanto al
  // elegir otro doc como cuando el store reemplaza el doc actual por una edición
  // externa (SSE/pull/watcher). Distinguimos ambos casos para no pisar el borrador.
  let loadedId: string | null = null;
  createEffect(() => {
    const doc = current();
    untrack(() => {
      if (!doc) {
        loadedId = null;
        return;
      }
      if (doc.id !== loadedId) {
        // Cambió la selección -> cargar fresco.
        loadedId = doc.id;
        setDraft(doc.content);
        setBaseVersion(doc.version);
        setDirty(false);
        return;
      }
      // Mismo doc: llegó una versión nueva desde afuera.
      if (doc.version === baseVersion()) return; // nada que reflejar
      if (dirty()) {
        // Hay borrador sin guardar: no lo pisamos, ofrecemos resolver.
        setConflict({ local: draft(), server: doc });
      } else {
        // Sin cambios locales: reflejar la edición externa.
        setDraft(doc.content);
        setBaseVersion(doc.version);
      }
    });
  });

  const select = async (id: string) => {
    if (dirty() && !(await askConfirm({ title: "Cambios sin guardar", description: "Si seguís, se descartan los cambios de esta nota.", confirmText: "Descartar", destructive: true }))) return;
    setSelectedId(id);
    setQuery("");
    setHits([]);
  };

  const onSave = async () => {
    const doc = current();
    if (!doc) return;
    setSaving(true);
    try {
      const res = await saveDoc(
        { id: doc.id, path: doc.path, content: draft(), base_version: baseVersion() },
        state.author,
      );
      if ("conflict" in res) {
        setConflict({ local: draft(), server: res.server });
      } else if ("ok" in res) {
        setBaseVersion(res.doc.version);
        setDirty(false);
      }
      // "denied": el aviso ya lo mostró el store; no tocamos el borrador.
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    const doc = current();
    if (!doc) return;
    if (!(await askConfirm({ title: "Eliminar nota", description: `"${doc.path}" se borra para todo el equipo.`, confirmText: "Eliminar", destructive: true }))) return;
    await deleteDoc(doc.id, state.author);
    setSelectedId(null);
  };

  const onCreate = async (path: string) => {
    setShowNew(false);
    const res = await saveDoc({ path, content: `# ${path.split("/").pop()!.replace(/\.md$/, "")}\n\n` }, state.author);
    if ("ok" in res) setSelectedId(res.doc.id);
  };

  // Operaciones de archivos desde el árbol.
  const onTreeAction = async (action: TreeAction, node: TreeNode) => {
    if (action === "rename") setRenameTarget({ kind: "file", path: node.path, docId: node.docId });
    else if (action === "rename-folder") setRenameTarget({ kind: "folder", path: node.path });
    else if (action === "new-in-folder") {
      setNewPrefill(node.path + "/");
      setShowNew(true);
    } else if (action === "delete") {
      if (!(await askConfirm({ title: "Eliminar nota", description: `"${node.path}" se borra para todo el equipo.`, confirmText: "Eliminar", destructive: true }))) return;
      deleteDoc(node.docId!, state.author);
      if (selectedId() === node.docId) setSelectedId(null);
    } else if (action === "delete-folder") {
      const count = docs().filter((d) => d.path.startsWith(node.path + "/")).length;
      if (!(await askConfirm({ title: "Eliminar carpeta", description: `"${node.path}" y sus ${count} nota${count === 1 ? "" : "s"} se borran para todo el equipo.`, confirmText: "Eliminar", destructive: true }))) return;
      deleteFolder(node.path);
      const sel = selectedId();
      if (sel && state.docs[sel]?.path.startsWith(node.path + "/")) setSelectedId(null);
    }
  };

  const onRenameSubmit = async (t: RenameTarget, newPath: string) => {
    setRenameTarget(null);
    if (t.kind === "file" && t.docId) await moveDoc(t.docId, newPath);
    else if (t.kind === "folder") await renameFolder(t.path, newPath);
  };

  // Resolución de conflicto.
  const keepMine = async () => {
    const c = conflict();
    const doc = current();
    if (!c || !doc) return;
    setConflict(null);
    setBaseVersion(c.server.version); // re-basar sobre lo del server
    const res = await saveDoc({ id: doc.id, path: doc.path, content: c.local, base_version: c.server.version }, state.author);
    if ("ok" in res) {
      setBaseVersion(res.doc.version);
      setDirty(false);
    } else if ("conflict" in res) {
      setConflict({ local: c.local, server: res.server });
    }
  };
  const keepServer = () => {
    const c = conflict();
    if (!c) return;
    setDraft(c.server.content);
    setBaseVersion(c.server.version);
    setDirty(false);
    setConflict(null);
  };

  // Búsqueda con debounce.
  let searchTimer: ReturnType<typeof setTimeout>;
  const onSearch = (q: string) => {
    setQuery(q);
    clearTimeout(searchTimer);
    if (!q.trim()) return setHits([]);
    searchTimer = setTimeout(async () => {
      try {
        setHits(await api.search(q));
      } catch {
        setHits([]);
      }
    }, 300);
  };

  const backlinksIndex = createMemo(() => buildBacklinks(docs()));
  const currentBacklinks = createMemo(() => (selectedId() ? backlinksIndex().get(selectedId()!) ?? [] : []));

  const preview = createMemo(() => {
    setWikiResolver(createResolver(docs())); // resolver al día antes de parsear
    return renderMarkdown(draft());
  });

  // Encabezados de la nota actual para el outline (ignora bloques de código).
  const outline = createMemo(() => {
    const out: { level: number; text: string; line: number }[] = [];
    let inFence = false;
    draft().split("\n").forEach((ln, i) => {
      if (/^```/.test(ln)) inFence = !inFence;
      else if (!inFence) {
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
        if (m) out.push({ level: m[1].length, text: m[2], line: i });
      }
    });
    return out;
  });

  // Click en un [[wikilink]] del preview navega a la nota destino.
  const onPreviewClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-doc-id]");
    const id = el?.getAttribute("data-doc-id");
    if (id) {
      e.preventDefault();
      select(id);
    }
  };

  // Comandos para la paleta (Cmd+K): acciones + abrir notas. Se lee en vivo.
  const commands = (): Command[] => {
    const cmds: Command[] = [];
    if (state.perms.write)
      cmds.push({ id: "new", label: "Nueva nota", group: "Acciones", run: () => (setNewPrefill(""), setShowNew(true)) });
    if (current())
      cmds.push({
        id: "toggle-mode",
        label: mode() === "edit" ? "Ver vista previa" : "Volver a editar",
        group: "Acciones",
        run: () => setMode(mode() === "edit" ? "preview" : "edit"),
      });
    cmds.push({
      id: "view",
      label: view() === "editor" ? "Ir al grafo" : "Ir al editor",
      group: "Acciones",
      run: () => setView(view() === "editor" ? "graph" : "editor"),
    });
    cmds.push({ id: "sync", label: "Sincronizar ahora", group: "Acciones", run: () => pull() });
    cmds.push({ id: "theme", label: "Cambiar tema (claro/oscuro)", group: "Acciones", run: toggleTheme });
    if (!state.authEnabled || state.role === "admin")
      cmds.push({ id: "tokens", label: "API keys", group: "Acciones", run: () => setShowTokens(true) });
    cmds.push({ id: "disconnect", label: "Cambiar de vault", group: "Acciones", run: disconnect });

    for (const d of docs())
      cmds.push({
        id: `doc:${d.id}`,
        label: displayName(d.path),
        hint: d.path.includes("/") ? d.path.replace(/\/[^/]+$/, "") : undefined,
        group: "Notas",
        run: () => select(d.id),
      });
    return cmds;
  };

  // Al arrancar: autoconectar a la última conexión usada (o mostrar el gestor).
  onMount(() => {
    boot();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={!state.booting} fallback={<BootSplash />}>
      <Show when={state.ready} fallback={<ConnectionManager />}>
      <div class="flex h-full flex-col">
        {/* Topbar */}
        <header class="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <div class="flex items-center gap-1.5">
            <Hammer class="h-4 w-4 text-primary" />
            <span class="text-sm font-semibold">Forge</span>
          </div>
          <Show when={browserMode()}>
            <span class="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">modo browser</span>
          </Show>
          <div class="relative ml-2 w-72">
            <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              class="h-8 pl-8"
              placeholder="Buscar en el vault…"
              value={query()}
              onInput={(e) => onSearch(e.currentTarget.value)}
            />
          </div>
          <div class="ml-2 flex items-center rounded-md border p-0.5">
            <button
              onClick={() => setView("editor")}
              class={cn(
                "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                view() === "editor" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FileText class="h-3.5 w-3.5" />
              Editor
            </button>
            <button
              onClick={() => setView("graph")}
              class={cn(
                "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                view() === "graph" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Network class="h-3.5 w-3.5" />
              Grafo
            </button>
          </div>
          <div class="ml-auto flex items-center gap-3">
            <Show when={state.authEnabled && state.role}>
              <span
                class="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground"
                title="Tu rol en este vault"
              >
                {state.role}
              </span>
            </Show>
            <SyncStatus />
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleTheme}
              title={theme() === "dark" ? "Tema claro" : "Tema oscuro"}
            >
              {theme() === "dark" ? <Sun class="h-4 w-4" /> : <Moon class="h-4 w-4" />}
            </Button>
            <Show when={!state.authEnabled || state.role === "admin"}>
              <Button size="sm" variant="ghost" onClick={() => setShowTokens(true)} title="API keys">
                <KeyRound class="h-4 w-4" />
              </Button>
            </Show>
            <Button size="sm" variant="ghost" onClick={() => pull()} title="Sincronizar ahora">
              <RefreshCw class="h-4 w-4" />
            </Button>
            <Gated when={state.perms.write} reason={NO_WRITE}>
              <Button
                size="sm"
                onClick={() => {
                  setNewPrefill("");
                  setShowNew(true);
                }}
              >
                <Plus class="h-4 w-4" />
                Nuevo
              </Button>
            </Gated>
          </div>
        </header>

        <div class="flex min-h-0 flex-1">
          {/* Sidebar */}
          <aside class="flex w-64 shrink-0 flex-col border-r">
            <div class="min-h-0 flex-1 overflow-auto p-2">
              <Show
                when={!query().trim()}
                fallback={
                  <div class="flex flex-col gap-1">
                    <p class="px-2 py-1 text-xs text-muted-foreground">
                      {hits().length} resultado{hits().length === 1 ? "" : "s"}
                    </p>
                    <For
                      each={hits()}
                      fallback={<p class="px-2 py-4 text-center text-xs text-muted-foreground">Sin resultados</p>}
                    >
                      {(hit) => (
                        <button
                          onClick={() => select(hit.id)}
                          class="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                        >
                          <span class="truncate text-sm">{hit.title || hit.path}</span>
                          <span class="truncate text-xs text-muted-foreground">{hit.snippet}</span>
                        </button>
                      )}
                    </For>
                  </div>
                }
              >
                <Show
                  when={docs().length}
                  fallback={
                    <div class="flex flex-col items-center gap-3 px-2 py-8 text-center">
                      <p class="text-sm text-muted-foreground">Vault vacío.</p>
                      <Show
                        when={state.perms.write}
                        fallback={<p class="text-xs text-muted-foreground">Tu token es de solo lectura.</p>}
                      >
                        <Button
                          size="sm"
                          onClick={() => {
                            setNewPrefill("");
                            setShowNew(true);
                          }}
                        >
                          <Plus class="h-4 w-4" />
                          Crear primer documento
                        </Button>
                      </Show>
                    </div>
                  }
                >
                  <FileTree nodes={tree()} selectedId={selectedId()} perms={state.perms} onSelect={select} onAction={onTreeAction} />
                </Show>
              </Show>
            </div>
            <button
              onClick={disconnect}
              class="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Cambiar de vault"
            >
              <FolderOpen class="h-3.5 w-3.5 shrink-0" />
              <span class="min-w-0 flex-1 truncate">{state.vault ? vaultName(state.vault) : ""}</span>
              <ChevronsUpDown class="h-3.5 w-3.5 shrink-0" />
            </button>
          </aside>

          {/* Editor + Preview / Grafo */}
          <main class="flex min-w-0 flex-1 flex-col">
            <Show when={view() === "editor"} fallback={
              <Show
                when={docs().length}
                fallback={
                  <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    No hay notas para graficar.
                  </div>
                }
              >
                <GraphView
                  docs={docs()}
                  selectedId={selectedId()}
                  onSelect={(id) => {
                    setSelectedId(id);
                    setView("editor");
                  }}
                />
              </Show>
            }>
            <Show
              when={current()}
              fallback={
                <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Elegí un documento o creá uno nuevo.
                </div>
              }
            >
              {(doc) => (
                <>
                  <div class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
                    <span class="truncate text-sm font-medium">{doc().path}</span>
                    <Show when={dirty()}>
                      <span class="h-1.5 w-1.5 rounded-full bg-amber-500" title="Cambios sin guardar" />
                    </Show>
                    <span class="text-xs text-muted-foreground">v{baseVersion()}</span>
                    <Show when={doc().updated_by}>
                      <span class="hidden text-xs text-muted-foreground md:inline">
                        · {doc().updated_by} · {relativeTime(doc().updated_at)}
                      </span>
                    </Show>
                    <div class="ml-auto flex items-center gap-1.5">
                      <Show when={mode() === "edit" && outline().length}>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            class="inline-flex h-8 items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title="Índice de la nota"
                          >
                            <List class="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent class="max-h-80 overflow-auto">
                            <For each={outline()}>
                              {(h) => (
                                <DropdownMenuItem onSelect={() => editorApi()?.scrollToLine(h.line)}>
                                  <span class="truncate" style={{ "padding-left": `${(h.level - 1) * 12}px` }}>
                                    {h.text}
                                  </span>
                                </DropdownMenuItem>
                              )}
                            </For>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </Show>
                      <div class="flex items-center rounded-md border p-0.5">
                        <button
                          onClick={() => setMode("edit")}
                          class={cn(
                            "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                            mode() === "edit" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Pencil class="h-3.5 w-3.5" />
                          Editar
                        </button>
                        <button
                          onClick={() => setMode("preview")}
                          class={cn(
                            "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                            mode() === "preview" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Eye class="h-3.5 w-3.5" />
                          Vista previa
                        </button>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setHistoryDocId(doc().id)} title="Historial">
                        <History class="h-4 w-4" />
                      </Button>
                      <Gated when={state.perms.delete} reason={NO_DELETE}>
                        <Button size="sm" variant="ghost" onClick={onDelete} title="Eliminar">
                          <Trash2 class="h-4 w-4 text-destructive" />
                        </Button>
                      </Gated>
                      <Gated when={state.perms.write} reason={NO_WRITE}>
                        <Button size="sm" onClick={onSave} disabled={saving() || !dirty()}>
                          <Save class="h-4 w-4" />
                          Guardar
                        </Button>
                      </Gated>
                    </div>
                  </div>

                  <div class="flex min-h-0 flex-1">
                    <Show
                      when={mode() === "edit"}
                      fallback={
                        <div class="min-h-0 flex-1 overflow-auto">
                          <div
                            class="prose-forge mx-auto max-w-3xl px-5 py-7"
                            innerHTML={preview()}
                            onClick={onPreviewClick}
                          />
                        </div>
                      }
                    >
                      <MarkdownEditor
                        value={draft()}
                        readOnly={!state.perms.write}
                        linkTargets={() => docs().map((d) => ({ label: displayName(d.path), path: d.path }))}
                        onChange={(v) => {
                          setDraft(v);
                          setDirty(true);
                        }}
                        onSave={onSave}
                        onReady={(a) => setEditorApi(a)}
                      />
                    </Show>
                  </div>
                  <Backlinks backlinks={currentBacklinks()} onSelect={select} />
                </>
              )}
            </Show>
            </Show>
          </main>
        </div>
      </div>

      <NewDocDialog open={showNew()} initial={newPrefill()} onOpenChange={setShowNew} onCreate={onCreate} />
      <TokenManager open={showTokens()} onOpenChange={setShowTokens} />
      <CommandPalette open={showPalette()} onOpenChange={setShowPalette} commands={commands} />
      <HistoryDialog
        docId={historyDocId()}
        path={historyDocId() ? state.docs[historyDocId()!]?.path : undefined}
        onClose={() => setHistoryDocId(null)}
      />
      <ConfirmHost />
      <RenameDialog target={renameTarget()} onClose={() => setRenameTarget(null)} onSubmit={onRenameSubmit} />
      <ConflictDialog
        conflict={conflict()}
        onKeepMine={keepMine}
        onKeepServer={keepServer}
        onClose={() => setConflict(null)}
      />

      <Show when={state.notice}>
        <div class="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm shadow-lg">
          <Info class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>{state.notice}</span>
          <button onClick={() => setNotice(null)} class="ml-1 text-muted-foreground hover:text-foreground">
            <X class="h-4 w-4" />
          </button>
        </div>
      </Show>
    </Show>
    </Show>
  );
};

export default App;
