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
  Check,
  Boxes,
  Settings,
} from "lucide-solid";
import {
  state,
  active,
  activeApi,
  docList,
  saveDoc,
  deleteDoc,
  moveDoc,
  renameFolder,
  deleteFolder,
  connect,
  setActiveVault,
  removeConnection,
  boot,
  pull,
  browserMode,
  setNotice,
  resolveConflictKeepMine,
  resolveConflictKeepServer,
} from "~/lib/store";
import { buildTree, renderMarkdown, setWikiResolver, parseFrontmatter } from "~/lib/markdown";
import { buildBacklinks, createResolver, displayName } from "~/lib/links";
import type { Doc, SearchHit } from "~/lib/api";
import { FileTree, type TreeAction } from "~/components/FileTree";
import type { TreeNode } from "~/lib/markdown";
import { GraphView } from "~/components/GraphView";
import { Backlinks } from "~/components/Backlinks";
import { ConflictDialog, type Conflict } from "~/components/ConflictDialog";
import { TokenManager } from "~/components/TokenManager";
import { VaultManager } from "~/components/VaultManager";
import { SettingsDialog } from "~/components/SettingsDialog";
import { MarkdownEditor } from "~/components/MarkdownEditor";
import { ConfirmHost } from "~/components/ConfirmHost";
import { CommandPalette, type Command } from "~/components/CommandPalette";
import { HistoryDialog } from "~/components/HistoryDialog";
import { AddVaultDialog } from "~/components/AddVaultDialog";
import { WebIcon } from "~/components/WebIcon";
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
import { getAutostart, setAutostart } from "~/lib/tauri";
import { cn } from "~/lib/utils";

function vaultName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/**
 * Etiqueta de una conexión (local path) para el switcher/gestor: si la sesión
 * está abierta y el server reportó su vault, muestra `Vault @ host`; si no,
 * cae al basename local. OJO: `vaultName(path)` es el basename LOCAL, distinto
 * del campo `vaultName` que devuelve el server.
 */
function vaultLabel(localPath: string): string {
  const sess = state.sessions[localPath];
  if (sess?.remoteVaultName) return `${sess.remoteVaultName} @ ${hostOf(sess.serverUrl)}`;
  return vaultName(localPath);
}

/** Texto del estado de sync de un vault para el switcher. */
function vaultSyncLabel(vault: string): string {
  const sess = state.sessions[vault];
  if (!sess) return "sin abrir";
  if (sess.syncing) return "sincronizando…";
  const queued = sess.pending > 0 ? ` · ${sess.pending} en cola` : "";
  if (!sess.online) return `offline${queued}`;
  return `${sess.connected ? "en vivo" : "conectado"}${queued}`;
}

/** Punto de color (o spinner) con el estado de sync de un vault. */
const VaultSyncDot: Component<{ vault: string }> = (props) => {
  const sess = () => state.sessions[props.vault];
  return (
    <Show when={sess()} fallback={<span class="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />}>
      <Show
        when={sess()!.syncing}
        fallback={
          <span
            class={cn(
              "h-2 w-2 shrink-0 rounded-full",
              !sess()!.online ? "bg-destructive" : sess()!.connected ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
        }
      >
        <RefreshCw class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
      </Show>
    </Show>
  );
};

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
    <WebIcon class="h-7 w-7 text-primary" />
    <RefreshCw class="h-4 w-4 animate-spin" />
    <span class="text-sm">Conectando…</span>
  </div>
);

const ConnectionManager: Component<{ onAddVault: () => void }> = (props) => {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [autostart, setAutostartState] = createSignal(false);

  onMount(async () => {
    if (!browserMode()) setAutostartState(await getAutostart());
  });
  const toggleAutostart = async () => {
    const next = !autostart();
    setAutostartState(next);
    try {
      await setAutostart(next);
    } catch (e) {
      setAutostartState(!next); // revertir si falla
      setErr(`No se pudo cambiar el inicio automático: ${e}`);
    }
  };

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

  return (
    <div class="flex h-full items-center justify-center p-6">
      <div class="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <div class="mb-1 flex items-center gap-2">
          <WebIcon class="h-5 w-5 text-primary" />
          <h1 class="text-2xl font-semibold">Bridges</h1>
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

        <div class="border-t pt-4">
          <Button class="w-full" onClick={props.onAddVault} disabled={!!busy()}>
            <Plus class="h-4 w-4" />
            Agregar vault
          </Button>
        </div>

        <Show when={err()}>
          <p class="mt-3 text-sm text-destructive">{err()}</p>
        </Show>

        <Show when={!browserMode()}>
          <label class="mt-4 flex cursor-pointer items-center gap-2 border-t pt-4 text-sm text-muted-foreground">
            <input type="checkbox" class="h-4 w-4 accent-primary" checked={autostart()} onChange={toggleAutostart} />
            Iniciar Bridges automáticamente al iniciar sesión
          </label>
        </Show>
      </div>
    </div>
  );
};

const SyncStatus: Component = () => {
  const s = () => active();
  return (
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Show when={s()?.syncing}>
        <RefreshCw class="h-3.5 w-3.5 animate-spin" />
        <span>Sincronizando…</span>
      </Show>
      <Show when={s() && !s()!.syncing}>
        <Show
          when={s()!.online}
          fallback={
            <>
              <WifiOff class="h-3.5 w-3.5 text-destructive" />
              <span>
                Offline{s()!.pending > 0 ? ` · ${s()!.pending} sin sincronizar` : ""}
              </span>
            </>
          }
        >
          <Wifi class="h-3.5 w-3.5 text-emerald-500" />
          <span>
            {s()!.connected ? "En vivo" : "Conectado"} · seq {s()!.lastSeq}
            {s()!.pending > 0 ? ` · ${s()!.pending} en cola` : ""}
          </span>
        </Show>
      </Show>
    </div>
  );
};

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
  const [showVaults, setShowVaults] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showPalette, setShowPalette] = createSignal(false);
  const [historyDocId, setHistoryDocId] = createSignal<string | null>(null);
  const [newPrefill, setNewPrefill] = createSignal("");
  const [renameTarget, setRenameTarget] = createSignal<RenameTarget | null>(null);
  const [mode, setMode] = createSignal<"edit" | "preview">("edit");
  const [editorApi, setEditorApi] = createSignal<{ scrollToLine: (line: number) => void } | null>(null);
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [view, setView] = createSignal<"editor" | "graph">("editor");
  const [showAddVault, setShowAddVault] = createSignal(false);

  // Sesión enfocada: la UI lee todo de acá. Permisos plenos por defecto cuando
  // aún no hay sesión (no debería renderizarse el cuerpo en ese caso).
  const s = () => active();
  const perms = () => s()?.perms ?? { write: false, delete: false };

  const docs = createMemo(() => docList());
  const tree = createMemo(() => buildTree(docs().map((d) => ({ id: d.id, path: d.path }))));
  const current = createMemo<Doc | null>(() => {
    const id = selectedId();
    return id ? s()?.docs[id] ?? null : null;
  });

  // Cargar el doc en el editor. Reacciona a `current()` (cambio de selección) y
  // también a su `content`/`version`: los leemos en el scope reactivo para que el
  // efecto se dispare cuando una edición externa (SSE/pull/watcher) muta el doc
  // abierto en su lugar, no solo al elegir otra nota. Distinguimos ambos casos
  // para no pisar el borrador.
  let loadedId: string | null = null;
  createEffect(() => {
    const doc = current();
    // Tracked: suscribe el efecto a los cambios de contenido/versión del doc
    // abierto (si está montado el mismo id), aunque la referencia no cambie.
    const content = doc?.content;
    const version = doc?.version;
    untrack(() => {
      if (!doc) {
        loadedId = null;
        return;
      }
      if (doc.id !== loadedId) {
        // Cambió la selección -> cargar fresco.
        loadedId = doc.id;
        setDraft(content!);
        setBaseVersion(version!);
        setDirty(false);
        return;
      }
      // Mismo doc: llegó una versión nueva desde afuera.
      if (version === baseVersion()) return; // nada que reflejar
      if (dirty()) {
        // Hay borrador sin guardar: no lo pisamos, ofrecemos resolver.
        setConflict({ local: draft(), server: doc });
      } else {
        // Sin cambios locales: reflejar la edición externa.
        setDraft(content!);
        setBaseVersion(version!);
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
      const res = await saveDoc({ id: doc.id, path: doc.path, content: draft(), base_version: baseVersion() });
      if ("conflict" in res) {
        setConflict({ local: draft(), server: res.server });
      } else if ("ok" in res) {
        setBaseVersion(res.doc.version);
        setDirty(false);
      } else if ("queued" in res) {
        // Offline: quedó en disco y en cola; se sincroniza al reconectar.
        setDirty(false);
        setNotice("Sin conexión: guardado local, se sincronizará al reconectar.");
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
    await deleteDoc(doc.id);
    setSelectedId(null);
  };

  const onCreate = async (path: string) => {
    setShowNew(false);
    const res = await saveDoc({ path, content: `# ${path.split("/").pop()!.replace(/\.md$/, "")}\n\n` });
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
      deleteDoc(node.docId!);
      if (selectedId() === node.docId) setSelectedId(null);
    } else if (action === "delete-folder") {
      const count = docs().filter((d) => d.path.startsWith(node.path + "/")).length;
      if (!(await askConfirm({ title: "Eliminar carpeta", description: `"${node.path}" y sus ${count} nota${count === 1 ? "" : "s"} se borran para todo el equipo.`, confirmText: "Eliminar", destructive: true }))) return;
      deleteFolder(node.path);
      const sel = selectedId();
      if (sel && s()?.docs[sel]?.path.startsWith(node.path + "/")) setSelectedId(null);
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
    const res = await saveDoc({ id: doc.id, path: doc.path, content: c.local, base_version: c.server.version });
    if ("ok" in res) {
      setBaseVersion(res.doc.version);
      setDirty(false);
    } else if ("conflict" in res) {
      setConflict({ local: c.local, server: res.server });
    } else if ("queued" in res) {
      setDirty(false);
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
        setHits((await activeApi()?.search(q)) ?? []);
      } catch {
        setHits([]);
      }
    }, 300);
  };

  // Conflictos de sync de TODAS las sesiones, etiquetados con su vault, para el
  // diálogo de fondo (se resuelven uno a uno aunque sean de un vault no enfocado).
  const allConflicts = createMemo(() =>
    Object.values(state.sessions).flatMap((sess) =>
      sess.conflicts.map((c) => ({ vault: sess.vault, path: c.path, local: c.local, server: c.server })),
    ),
  );

  const backlinksIndex = createMemo(() => buildBacklinks(docs()));
  const currentBacklinks = createMemo(() => (selectedId() ? backlinksIndex().get(selectedId()!) ?? [] : []));

  const preview = createMemo(() => {
    setWikiResolver(createResolver(docs())); // resolver al día antes de parsear
    return renderMarkdown(draft());
  });

  // Frontmatter de la nota actual, mostrado como panel de propiedades (como Obsidian).
  const properties = createMemo(() => parseFrontmatter(draft()));

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

  // Click en el preview: un #tag busca por ese tag; un [[wikilink]] navega a la nota.
  const onPreviewClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const tagEl = target.closest("[data-tag]");
    if (tagEl) {
      e.preventDefault();
      onSearch("#" + tagEl.getAttribute("data-tag"));
      return;
    }
    const el = target.closest("[data-doc-id]");
    const id = el?.getAttribute("data-doc-id");
    if (id) {
      e.preventDefault();
      select(id);
    }
  };

  // Comandos para la paleta (Cmd+K): acciones + abrir notas. Se lee en vivo.
  const commands = (): Command[] => {
    const cmds: Command[] = [];
    if (perms().write)
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
    cmds.push({ id: "settings", label: "Configuración / Tema", group: "Acciones", run: () => setShowSettings(true) });
    if (!s()?.authEnabled || s()?.role === "admin")
      cmds.push({ id: "tokens", label: "API keys", group: "Acciones", run: () => setShowTokens(true) });
    if (s()?.isOwner)
      cmds.push({ id: "vaults", label: "Vaults (gestionar)", group: "Acciones", run: () => setShowVaults(true) });
    cmds.push({ id: "add-vault", label: "Agregar vault", group: "Acciones", run: () => setShowAddVault(true) });

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
      <>
      {/* AddVaultDialog vive afuera del Show de "ready" para estar disponible
          tanto en el estado vacío como en el switcher. */}
      <AddVaultDialog open={showAddVault()} onOpenChange={setShowAddVault} />
      <Show when={s()?.ready} fallback={<ConnectionManager onAddVault={() => setShowAddVault(true)} />}>
      <div class="flex h-full flex-col">
        {/* Topbar */}
        <header class="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <div class="flex items-center gap-1.5">
            <WebIcon class="h-4 w-4 text-primary" />
            <span class="text-sm font-semibold">Bridges</span>
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
            <Show when={s()?.authEnabled && s()?.role}>
              <span
                class="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground"
                title="Tu rol en este vault"
              >
                {s()?.role}
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
            <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)} title="Configuración">
              <Settings class="h-4 w-4" />
            </Button>
            <Show when={s()?.isOwner}>
              <Button size="sm" variant="ghost" onClick={() => setShowVaults(true)} title="Vaults">
                <Boxes class="h-4 w-4" />
              </Button>
            </Show>
            <Show when={!s()?.authEnabled || s()?.role === "admin"}>
              <Button size="sm" variant="ghost" onClick={() => setShowTokens(true)} title="API keys">
                <KeyRound class="h-4 w-4" />
              </Button>
            </Show>
            <Button size="sm" variant="ghost" onClick={() => pull()} title="Sincronizar ahora">
              <RefreshCw class="h-4 w-4" />
            </Button>
            <Gated when={perms().write} reason={NO_WRITE}>
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
                        when={perms().write}
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
                  <FileTree nodes={tree()} selectedId={selectedId()} perms={perms()} onSelect={select} onAction={onTreeAction} />
                </Show>
              </Show>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                class="flex w-full shrink-0 items-center gap-2 border-t px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Cambiar de vault"
              >
                <FolderOpen class="h-3.5 w-3.5 shrink-0" />
                <span class="min-w-0 flex-1 truncate">{s() ? vaultLabel(s()!.vault) : ""}</span>
                <ChevronsUpDown class="h-3.5 w-3.5 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-64">
                <For each={state.connections}>
                  {(conn) => (
                    <DropdownMenuItem
                      class="gap-2"
                      onSelect={() =>
                        state.sessions[conn.vault]
                          ? setActiveVault(conn.vault)
                          : connect(conn).catch((e) => setNotice(`No se pudo abrir "${vaultName(conn.vault)}": ${e}`))
                      }
                    >
                      <VaultSyncDot vault={conn.vault} />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate">{vaultLabel(conn.vault)}</span>
                        <span class="block truncate text-xs text-muted-foreground">{vaultSyncLabel(conn.vault)}</span>
                      </span>
                      <Show when={state.activeVault === conn.vault}>
                        <Check class="h-3.5 w-3.5 shrink-0 text-primary" />
                      </Show>
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuItem class="gap-2 border-t text-muted-foreground" onSelect={() => setShowAddVault(true)}>
                  <Plus class="h-3.5 w-3.5 shrink-0" />
                  Agregar vault…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
                      <Gated when={perms().delete} reason={NO_DELETE}>
                        <Button size="sm" variant="ghost" onClick={onDelete} title="Eliminar">
                          <Trash2 class="h-4 w-4 text-destructive" />
                        </Button>
                      </Gated>
                      <Gated when={perms().write} reason={NO_WRITE}>
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
                          <div class="mx-auto max-w-3xl px-5 py-7">
                            <Show when={properties().length}>
                              <div class="note-properties">
                                <For each={properties()}>
                                  {(p) => (
                                    <div class="note-prop">
                                      <span class="note-prop-key">{p.key}</span>
                                      <div class="note-prop-val">
                                        <Show
                                          when={Array.isArray(p.value)}
                                          fallback={<span>{p.value as string}</span>}
                                        >
                                          <For each={p.value as string[]}>
                                            {(v) =>
                                              p.key === "tags" ? (
                                                <a class="tag" onClick={() => onSearch("#" + v)}>
                                                  #{v}
                                                </a>
                                              ) : (
                                                <span class="note-prop-item">{v}</span>
                                              )
                                            }
                                          </For>
                                        </Show>
                                      </div>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                            <div class="prose-forge" innerHTML={preview()} onClick={onPreviewClick} />
                          </div>
                        </div>
                      }
                    >
                      <MarkdownEditor
                        value={draft()}
                        readOnly={!perms().write}
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
      <VaultManager open={showVaults()} onOpenChange={setShowVaults} />
      <SettingsDialog open={showSettings()} onOpenChange={setShowSettings} />
      <CommandPalette open={showPalette()} onOpenChange={setShowPalette} commands={commands} />
      <HistoryDialog
        docId={historyDocId()}
        path={historyDocId() ? s()?.docs[historyDocId()!]?.path : undefined}
        currentContent={draft()}
        onRestore={(content) => {
          setDraft(content);
          setDirty(true);
          setMode("edit");
          setHistoryDocId(null);
        }}
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
      {/* Conflictos de sync de fondo (de cualquier vault, etiquetados con su
          vault): se resuelven uno a uno aunque no haya editor abierto en ese doc. */}
      <ConflictDialog
        conflict={allConflicts()[0] ? { local: allConflicts()[0].local, server: allConflicts()[0].server } : null}
        label={allConflicts()[0] ? `${vaultName(allConflicts()[0].vault)}/${allConflicts()[0].path}` : undefined}
        onKeepMine={() => resolveConflictKeepMine(allConflicts()[0]!.vault, allConflicts()[0]!.path)}
        onKeepServer={() => resolveConflictKeepServer(allConflicts()[0]!.vault, allConflicts()[0]!.path)}
        onClose={() => {}}
      />

    </Show>
      <Show when={state.notice}>
        <div class="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm shadow-lg">
          <Info class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>{state.notice}</span>
          <button onClick={() => setNotice(null)} class="ml-1 text-muted-foreground hover:text-foreground">
            <X class="h-4 w-4" />
          </button>
        </div>
      </Show>
      </>
    </Show>
  );
};

export default App;
