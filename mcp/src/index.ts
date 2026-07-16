#!/usr/bin/env bun
/**
 * Servidor MCP para Bridges: expone el vault del bridges-server a un agente
 * (Claude Code) con cinco tools de lectura, así no tiene que grepear el disco:
 *   - search_vault   búsqueda full-text rankeada (FTS5/BM25) con snippets
 *   - read_note      contenido completo de una nota por su path
 *   - get_backlinks  notas que enlazan a una (grafo de [[wikilinks]])
 *   - list_links     notas a las que una enlaza (con links rotos marcados)
 *   - list_vaults    vaults configurados en la app de Bridges (nombre, ruta, default)
 * Cada tool corre contra el disco local (si resolveVaultDir resuelve un vault) o por HTTP.
 *
 * Si el vault es local y BRIDGES_MCP_READONLY!=1, además registra 5 write-tools:
 *   - create_note / update_note / delete_note / restore_note / list_history
 * La escritura es local-only (nunca HTTP) y toda op destructiva es recuperable
 * (.bridges/history + .bridges/trash). Ver docs/superpowers/specs/2026-07-06-mcp-write-fase0-design.md
 *
 * Config por env:
 *   BRIDGES_URL          base del server (default http://localhost:4321)
 *   BRIDGES_TOKEN        Bearer token del vault (opcional si el server corre sin auth)
 *   BRIDGES_VAULT_DIR    override manual de la raíz del vault en disco: uno de los
 *                      inputs de la cascada resolveVaultDir() (.bridges del repo
 *                      consumidor → BRIDGES_VAULT_DIR → vault por default de la app).
 *                      Si la cascada resuelve un dir, la búsqueda corre contra un
 *                      índice FTS local (sub-ms, offline) en vez de HTTP, y los hits
 *                      incluyen el path absoluto local para abrirlos con Read.
 *   BRIDGES_LOCAL_SEARCH =0 fuerza el camino HTTP aunque se haya resuelto un vault local.
 *
 * El vault lo determina el token; sin token, el server usa `default`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchVault, readNote, allDocs, effectiveVaultDir, isLocalMode } from "./bridges";
import { getBacklinks, getOutgoingLinks } from "./graph";
import { readVaults, formatVaults } from "./config";
import { createNote, updateNote, deleteNote, restoreNote, listHistory } from "./writer";

const server = new McpServer({ name: "bridges-mcp", version: "0.1.0" });

server.registerTool(
  "search_vault",
  {
    title: "Buscar en el vault de Bridges",
    description:
      "Búsqueda full-text rankeada (BM25) sobre las notas del vault. Devuelve los " +
      "resultados más relevantes con su path, título y un snippet. Usá esto en vez " +
      "de grepear: ya viene ordenado por relevancia. Para leer una nota completa, " +
      "abrí su archivo en disco con Read (se incluye la ruta absoluta de cada hit).",
    inputSchema: {
      query: z.string().min(1).describe("Términos a buscar (texto libre)."),
      limit: z.number().int().min(1).max(50).optional().describe("Máximo de resultados (default 10)."),
      pathPrefix: z
        .string()
        .optional()
        .describe("Filtra los resultados a notas cuyo path empieza con este prefijo (p. ej. '01 - Proyectos/')."),
      vault: z
        .string()
        .optional()
        .describe("Nombre del vault donde buscar (ver list_vaults). Por defecto usa el vault del repo/default."),
    },
  },
  async ({ query, limit, pathPrefix, vault }) => {
    try {
      const hits = await searchVault(query, limit ?? 10, pathPrefix, vault);
      if (!hits.length) {
        return { content: [{ type: "text", text: `Sin resultados para "${query}".` }] };
      }
      const text = hits
        .map((h, i) => `${i + 1}. ${h.title ?? h.path}\n   ${h.localPath ?? h.path}\n   ${h.snippet}`)
        .join("\n");
      return { content: [{ type: "text", text: `${hits.length} resultado(s) para "${query}":\n\n${text}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Error al buscar: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  },
);

server.registerTool(
  "read_note",
  {
    title: "Leer una nota del vault de Bridges",
    description:
      "Devuelve el contenido completo de una nota del vault por su ruta relativa " +
      "(la que devuelve search_vault). En modo local lee del disco; en modo HTTP la " +
      "trae del server. Usalo para leer una nota entera después de encontrarla con " +
      "search_vault (en modo HTTP search_vault solo da el snippet).",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Ruta relativa de la nota dentro del vault, p. ej. '01 - Proyectos/forge/index.md'."),
      vault: z
        .string()
        .optional()
        .describe("Nombre del vault a leer (ver list_vaults). Por defecto usa el vault del repo/default."),
    },
  },
  async ({ path, vault }) => {
    try {
      const note = await readNote(path, vault);
      if (!note) {
        return { content: [{ type: "text", text: `No existe la nota "${path}".` }] };
      }
      const header = `${note.title ?? note.path}\n${note.localPath ?? note.path}\n\n`;
      return { content: [{ type: "text", text: header + note.content }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error al leer "${path}": ${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  },
);

server.registerTool(
  "get_backlinks",
  {
    title: "Backlinks de una nota",
    description:
      "Lista las notas que enlazan (con [[wikilinks]]) a la nota indicada. Es el " +
      "diferencial sobre grep: navegás el grafo del vault, no el texto. Devuelve " +
      "path y título de cada nota que la referencia.",
    inputSchema: {
      path: z.string().min(1).describe("Ruta relativa de la nota destino dentro del vault."),
      vault: z
        .string()
        .optional()
        .describe("Nombre del vault (ver list_vaults). Por defecto usa el vault del repo/default."),
    },
  },
  async ({ path, vault }) => {
    try {
      const docs = await allDocs(vault);
      if (!docs.some((d) => d.path === path)) {
        return { content: [{ type: "text", text: `No existe la nota "${path}".` }] };
      }
      const back = getBacklinks(docs, path);
      if (!back.length) {
        return { content: [{ type: "text", text: `Ninguna nota enlaza a "${path}".` }] };
      }
      const text = back.map((d, i) => `${i + 1}. ${d.title ?? d.path}\n   ${d.path}`).join("\n");
      return { content: [{ type: "text", text: `${back.length} backlink(s) a "${path}":\n\n${text}` }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error al calcular backlinks de "${path}": ${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  },
);

server.registerTool(
  "list_links",
  {
    title: "Links salientes de una nota",
    description:
      "Lista las notas a las que enlaza (con [[wikilinks]]) la nota indicada. Marca " +
      "los links rotos (sin nota destino). Útil para navegar el grafo hacia adelante.",
    inputSchema: {
      path: z.string().min(1).describe("Ruta relativa de la nota origen dentro del vault."),
      vault: z
        .string()
        .optional()
        .describe("Nombre del vault (ver list_vaults). Por defecto usa el vault del repo/default."),
    },
  },
  async ({ path, vault }) => {
    try {
      const docs = await allDocs(vault);
      if (!docs.some((d) => d.path === path)) {
        return { content: [{ type: "text", text: `No existe la nota "${path}".` }] };
      }
      const links = getOutgoingLinks(docs, path);
      if (!links.length) {
        return { content: [{ type: "text", text: `"${path}" no enlaza a ninguna nota.` }] };
      }
      const text = links
        .map((l, i) =>
          l.resolved
            ? `${i + 1}. ${l.resolved.title ?? l.resolved.path}\n   ${l.resolved.path}`
            : `${i + 1}. [[${l.target}]] (roto: sin nota destino)`,
        )
        .join("\n");
      return { content: [{ type: "text", text: `${links.length} link(s) saliente(s) de "${path}":\n\n${text}` }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error al listar links de "${path}": ${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  },
);

server.registerTool(
  "list_vaults",
  {
    title: "Listar los vaults de Bridges configurados",
    description:
      "Devuelve los vaults que el usuario tiene configurados en la app de Bridges " +
      "(nombre, ruta local y cuál es el default). Read-only, no expone tokens. Usalo " +
      "para saber a qué vault leer/escribir cuando el repo no tiene .bridges o hay ambigüedad.",
    inputSchema: {},
  },
  async () => {
    const vaults = readVaults();
    if (!vaults.length) {
      return { content: [{ type: "text", text: "No hay vaults configurados en la app de Bridges." }] };
    }
    return { content: [{ type: "text", text: `${vaults.length} vault(s):\n\n${formatVaults(vaults)}` }] };
  },
);

// ── Write-tools (Fase 0) ──────────────────────────────────────────────────
// Solo en modo local y con write habilitado (opt-out con BRIDGES_MCP_READONLY=1).
if (isLocalMode() && process.env.BRIDGES_MCP_READONLY !== "1") {
  const vaultArg = z
    .string()
    .optional()
    .describe("Nombre del vault destino (ver list_vaults). Por defecto, el vault del repo/default.");

  const json = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });
  const fail = (e: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  });
  // dir local del vault destino; lanza si el vault nombrado no existe o no es local.
  const dirFor = (vault?: string): string => {
    const d = effectiveVaultDir(vault);
    if (!d) throw new Error("no hay vault local resuelto para escribir.");
    return d;
  };
  const brokenLinksOf = async (vault: string | undefined, path: string): Promise<string[]> => {
    const docs = await allDocs(vault);
    return getOutgoingLinks(docs, path).filter((l) => !l.resolved).map((l) => l.target);
  };

  server.registerTool(
    "create_note",
    {
      title: "Crear una nota en el vault",
      description:
        "Crea una nota nueva. Con `path` la ubica ahí (agrega .md); sin `path`, usa " +
        "el slug del `title` dentro de `folder` (default 'Memoria'). Si ya existe y no " +
        "pasás overwrite:true, falla. Devuelve JSON con el path creado y links rotos.",
      inputSchema: {
        title: z.string().min(1).describe("Título de la nota (se usa para el slug si no hay path)."),
        content: z.string().describe("Contenido markdown del cuerpo."),
        path: z.string().optional().describe("Ruta relativa destino (sin .md o con .md)."),
        folder: z.string().optional().describe("Carpeta destino si no hay path (default 'Memoria')."),
        overwrite: z.boolean().optional().describe("Si true, reemplaza una nota existente en ese path."),
        vault: vaultArg,
      },
    },
    async ({ title, content, path, folder, overwrite, vault }) => {
      try {
        const r = createNote(dirFor(vault), { title, content, path, folder, overwrite });
        return json({ ...r, brokenLinks: await brokenLinksOf(vault, r.path) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Editar una nota del vault",
      description:
        "Edita una nota existente. mode='overwrite' reemplaza todo el cuerpo; 'append' " +
        "agrega al final (journal); 'patch' reemplaza el cuerpo bajo `heading` (## X) " +
        "hasta el próximo heading de nivel igual o mayor (heading inexistente falla). " +
        "Snapshotea el estado previo. Devuelve JSON con links rotos.",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota (con .md)."),
        mode: z.enum(["overwrite", "append", "patch"]).describe("Modo de edición."),
        content: z.string().describe("Contenido a escribir (cuerpo entero / a agregar / de la sección)."),
        heading: z.string().optional().describe("Requerido en mode='patch': heading de la sección (texto sin #)."),
        vault: vaultArg,
      },
    },
    async ({ path, mode, content, heading, vault }) => {
      try {
        const r = updateNote(dirFor(vault), { path, mode, content, heading });
        return json({ ...r, brokenLinks: await brokenLinksOf(vault, r.path) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "delete_note",
    {
      title: "Borrar una nota del vault (a la papelera)",
      description:
        "Mueve la nota a .bridges/trash (recuperable con restore_note). Devuelve JSON " +
        "con el trashPath y qué notas quedaron con backlinks huérfanos hacia ella.",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota a borrar (con .md)."),
        vault: vaultArg,
      },
    },
    async ({ path, vault }) => {
      try {
        const docs = await allDocs(vault);
        const orphanedBacklinks = getBacklinks(docs, path).map((d) => d.path);
        const r = deleteNote(dirFor(vault), path);
        return json({ ...r, orphanedBacklinks });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "restore_note",
    {
      title: "Restaurar una nota borrada o revertir una edición",
      description:
        "Recupera una nota de la papelera (from='trash') o revierte a un snapshot " +
        "(from='history'). Sin `from`: usa trash si existe, si no el snapshot más reciente. " +
        "`timestamp` opcional elige una versión puntual (ver list_history).",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota (con .md)."),
        from: z.enum(["trash", "history"]).optional().describe("Fuente de la restauración."),
        timestamp: z.string().optional().describe("Timestamp puntual (de list_history)."),
        vault: vaultArg,
      },
    },
    async ({ path, from, timestamp, vault }) => {
      try {
        return json(restoreNote(dirFor(vault), { path, from, timestamp }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "list_history",
    {
      title: "Historial de una nota (snapshots + papelera)",
      description:
        "Lista los snapshots (ediciones previas) y entradas de papelera de una nota, " +
        "con su timestamp, para elegir qué restaurar con restore_note.",
      inputSchema: {
        path: z.string().min(1).describe("Ruta relativa de la nota (con .md)."),
        vault: vaultArg,
      },
    },
    async ({ path, vault }) => {
      try {
        return json({ path, entries: listHistory(dirFor(vault), path) });
      } catch (e) { return fail(e); }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
