#!/usr/bin/env bun
/**
 * Servidor MCP para Forge: expone la búsqueda full-text (FTS5/BM25) del
 * forge-server como una tool `search_vault` que un agente (Claude Code) puede
 * llamar en vez de grepear el vault en disco. Devuelve los resultados ya
 * rankeados por relevancia con snippets, así el agente abre pocos archivos
 * pertinentes en lugar de cientos de hits sin ordenar.
 *
 * Config por env:
 *   FORGE_URL          base del server (default http://localhost:4321)
 *   FORGE_TOKEN        Bearer token del vault (opcional si el server corre sin auth)
 *   FORGE_VAULT_DIR    raíz del vault en disco. Si está, la búsqueda corre contra
 *                      un índice FTS local (sub-ms, offline) en vez de HTTP, y los
 *                      hits incluyen el path absoluto local para abrirlos con Read.
 *   FORGE_LOCAL_SEARCH =0 fuerza el camino HTTP aunque haya FORGE_VAULT_DIR.
 *
 * El vault lo determina el token; sin token, el server usa `default`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchVault } from "./forge";

const server = new McpServer({ name: "forge-mcp", version: "0.1.0" });

server.registerTool(
  "search_vault",
  {
    title: "Buscar en el vault de Forge",
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

const transport = new StdioServerTransport();
await server.connect(transport);
