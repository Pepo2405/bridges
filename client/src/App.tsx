import { type Component, Show, For, createSignal, createMemo, createEffect, onMount, untrack } from "solid-js";
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
} from "lucide-solid";
import {
  state,
  docList,
  saveDoc,
  deleteDoc,
  moveDoc,
  renameFolder,
  deleteFolder,
  chooseVaultAndConnect,
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
import { buildBacklinks, createResolver } from "~/lib/links";
import type { Doc, SearchHit } from "~/lib/api";
import { FileTree, type TreeAction } from "~/components/FileTree";
import type { TreeNode } from "~/lib/markdown";
import { GraphView } from "~/components/GraphView";
import { Backlinks } from "~/components/Backlinks";
import { ConflictDialog, type Conflict } from "~/components/ConflictDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

const AUTHOR = "yo"; // MVP: sin auth real

function vaultName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

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

  const addNew = async () => {
    setBusy("new");
    setErr(null);
    try {
      const ok = await chooseVaultAndConnect(serverUrl(), token().trim() || undefined);
      if (!ok) setErr("No elegiste ninguna carpeta.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
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
  const [newPrefill, setNewPrefill] = createSignal("");
  const [renameTarget, setRenameTarget] = createSignal<RenameTarget | null>(null);
  const [showPreview, setShowPreview] = createSignal(true);
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

  const select = (id: string) => {
    if (dirty() && !confirm("Tenés cambios sin guardar. ¿Descartarlos?")) return;
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
        AUTHOR,
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
    if (!confirm(`¿Eliminar "${doc.path}"? Se borra para todo el equipo.`)) return;
    await deleteDoc(doc.id, AUTHOR);
    setSelectedId(null);
  };

  const onCreate = async (path: string) => {
    setShowNew(false);
    const res = await saveDoc({ path, content: `# ${path.split("/").pop()!.replace(/\.md$/, "")}\n\n` }, AUTHOR);
    if ("ok" in res) setSelectedId(res.doc.id);
  };

  // Operaciones de archivos desde el árbol.
  const onTreeAction = (action: TreeAction, node: TreeNode) => {
    if (action === "rename") setRenameTarget({ kind: "file", path: node.path, docId: node.docId });
    else if (action === "rename-folder") setRenameTarget({ kind: "folder", path: node.path });
    else if (action === "new-in-folder") {
      setNewPrefill(node.path + "/");
      setShowNew(true);
    } else if (action === "delete") {
      if (!confirm(`¿Eliminar "${node.path}"? Se borra para todo el equipo.`)) return;
      deleteDoc(node.docId!, AUTHOR);
      if (selectedId() === node.docId) setSelectedId(null);
    } else if (action === "delete-folder") {
      const count = docs().filter((d) => d.path.startsWith(node.path + "/")).length;
      if (!confirm(`¿Eliminar la carpeta "${node.path}" y sus ${count} nota${count === 1 ? "" : "s"}? Se borra para todo el equipo.`)) return;
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
    const res = await saveDoc({ id: doc.id, path: doc.path, content: c.local, base_version: c.server.version }, AUTHOR);
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

  // Click en un [[wikilink]] del preview navega a la nota destino.
  const onPreviewClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-doc-id]");
    const id = el?.getAttribute("data-doc-id");
    if (id) {
      e.preventDefault();
      select(id);
    }
  };

  // Al arrancar: autoconectar a la última conexión usada (o mostrar el gestor).
  onMount(() => {
    boot();
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
            <SyncStatus />
            <Button size="sm" variant="ghost" onClick={() => pull()} title="Sincronizar ahora">
              <RefreshCw class="h-4 w-4" />
            </Button>
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
                    <div class="flex flex-col gap-2 p-2">
                      <Skeleton class="h-6 w-full" />
                      <Skeleton class="h-6 w-4/5" />
                      <p class="mt-2 text-center text-xs text-muted-foreground">
                        Vault vacío. Creá el primer documento.
                      </p>
                    </div>
                  }
                >
                  <FileTree nodes={tree()} selectedId={selectedId()} onSelect={select} onAction={onTreeAction} />
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
              <GraphView
                docs={docs()}
                selectedId={selectedId()}
                onSelect={(id) => {
                  setSelectedId(id);
                  setView("editor");
                }}
              />
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
                    <div class="ml-auto flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowPreview((p) => !p)}
                        title={showPreview() ? "Ocultar preview" : "Mostrar preview"}
                      >
                        {showPreview() ? <Pencil class="h-4 w-4" /> : <Eye class="h-4 w-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={onDelete} title="Eliminar">
                        <Trash2 class="h-4 w-4 text-destructive" />
                      </Button>
                      <Button size="sm" onClick={onSave} disabled={saving() || !dirty()}>
                        <Save class="h-4 w-4" />
                        Guardar
                      </Button>
                    </div>
                  </div>

                  <div class="flex min-h-0 flex-1">
                    <textarea
                      class={cn(
                        "min-h-0 flex-1 resize-none bg-background p-4 font-mono text-sm leading-relaxed outline-none",
                        showPreview() && "border-r",
                      )}
                      value={draft()}
                      spellcheck={false}
                      onInput={(e) => {
                        setDraft(e.currentTarget.value);
                        setDirty(true);
                      }}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                          e.preventDefault();
                          onSave();
                        }
                      }}
                    />
                    <Show when={showPreview()}>
                      <div class="min-h-0 flex-1 overflow-auto p-4">
                        <div class="prose-forge" innerHTML={preview()} onClick={onPreviewClick} />
                      </div>
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
