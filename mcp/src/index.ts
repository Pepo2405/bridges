#!/usr/bin/env bun
/**
 * Servidor MCP para Bridges: expone la búsqueda full-text (FTS5/BM25) del
 * bridges-server como una tool `search_vault` que un agente (Claude Code) puede
 * llamar en vez de grepear el vault en disco. Devuelve los resultados ya
 * rankeados por relevancia con snippets, así el agente abre pocos archivos
 * pertinentes en lugar de cientos de hits sin ordenar.
 *
 * Config por env:
 *   BRIDGES_URL          base del server (default http://localhost:4321)
 *   BRIDGES_TOKEN        Bearer token del vault (opcional si el server corre sin auth)
 *   BRIDGES_VAULT_DIR    raíz del vault en disco. Si está, la búsqueda corre contra
 *                      un índice FTS local (sub-ms, offline) en vez de HTTP, y los
 *                      hits incluyen el path absoluto local para abrirlos con Read.
 *   BRIDGES_LOCAL_SEARCH =0 fuerza el camino HTTP aunque haya BRIDGES_VAULT_DIR.
 *
 * El vault lo determina el token; sin token, el server usa `default`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchVault, readNote, allDocs } from "./bridges";
import { getBacklinks, getOutgoingLinks } from "./graph";

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
    },
  },
  async ({ query, limit }) => {
    try {
      const hits = await searchVault(query, limit ?? 10);
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
    },
  },
  async ({ path }) => {
    try {
      const note = await readNote(path);
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
    },
  },
  async ({ path }) => {
    try {
      const docs = await allDocs();
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
    },
  },
  async ({ path }) => {
    try {
      const docs = await allDocs();
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

const transport = new StdioServerTransport();
await server.connect(transport);
