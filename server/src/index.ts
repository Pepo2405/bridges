import {
  createDoc,
  updateDoc,
  deleteDoc,
  syncSince,
  getLastSeq,
  ConflictError,
  NotFoundError,
} from "./db";
import { addClient, broadcastChange, clientCount } from "./events";
import { searchDocs } from "./search";
import { authEnabled, roleForToken, roleCan, type Perm } from "./auth";

const PORT = Number(process.env.PORT ?? 4321);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

/** Permiso requerido según el método (DELETE→delete, POST→write, resto→read). */
function permFor(method: string): Perm {
  if (method === "DELETE") return "delete";
  if (method === "POST") return "write";
  return "read";
}

/**
 * Verifica el token y su permiso. Devuelve null si pasa, o la Response de error.
 * El token va en `Authorization: Bearer`, o por query `?token=` solo en /events
 * (el EventSource del browser no puede mandar headers).
 */
function checkAuth(req: Request, url: URL): Response | null {
  if (!authEnabled()) return null;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const qToken = url.pathname === "/events" ? url.searchParams.get("token") : null;
  const role = roleForToken(bearer ?? qToken);
  if (!role) return json({ error: "unauthorized" }, 401);
  if (!roleCan(role, permFor(req.method))) return json({ error: "forbidden" }, 403);
  return null;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE: no cerrar conexiones inactivas
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // --- Health: público, para el healthcheck de Coolify ---
    if (pathname === "/health") {
      return json({ ok: true, last_seq: getLastSeq(), clients: clientCount() });
    }

    const denied = checkAuth(req, url);
    if (denied) return denied;

    // --- Pull incremental: GET /sync?since=<seq> ---
    if (pathname === "/sync" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      if (!Number.isFinite(since) || since < 0) return json({ error: "invalid since" }, 400);
      return json(syncSince(since));
    }

    // --- Búsqueda full-text: GET /search?q=... ---
    if (pathname === "/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      return json({ results: searchDocs(q) });
    }

    // --- SSE: GET /events ---
    if (pathname === "/events" && req.method === "GET") {
      let cleanup = () => {};
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (data: string) => controller.enqueue(enc.encode(data));
          send(`data: ${JSON.stringify({ type: "hello", seq: getLastSeq() })}\n\n`);
          const remove = addClient({ send });
          // keep-alive: comentario SSE cada 25s para que no muera el proxy
          const ping = setInterval(() => {
            try {
              send(`: ping\n\n`);
            } catch {
              /* noop */
            }
          }, 25000);
          cleanup = () => {
            clearInterval(ping);
            remove();
          };
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
        },
      });
    }

    // --- Crear: POST /documents ---
    if (pathname === "/documents" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body?.path || typeof body.content !== "string") {
        return json({ error: "path and content required" }, 400);
      }
      try {
        const doc = createDoc({
          path: body.path,
          title: body.title ?? null,
          content: body.content,
          author: body.author ?? null,
        });
        broadcastChange(doc.seq);
        return json(doc, 201);
      } catch (e) {
        if (e instanceof ConflictError) return json({ conflict: true, error: e.message, server: e.server }, 409);
        return json({ error: String(e) }, 400);
      }
    }

    // --- Update / Delete sobre /documents/:id ---
    const docMatch = pathname.match(/^\/documents\/([^/]+)$/);
    if (docMatch) {
      const id = decodeURIComponent(docMatch[1]);

      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.content !== "string" || typeof body.base_version !== "number") {
          return json({ error: "content and base_version required" }, 400);
        }
        try {
          const doc = updateDoc({
            id,
            path: body.path,
            title: body.title ?? null,
            content: body.content,
            base_version: body.base_version,
            author: body.author ?? null,
          });
          broadcastChange(doc.seq);
          return json(doc);
        } catch (e) {
          if (e instanceof ConflictError) return json({ conflict: true, error: e.message, server: e.server }, 409);
          if (e instanceof NotFoundError) return json({ error: e.message }, 404);
          return json({ error: String(e) }, 400);
        }
      }

      if (req.method === "DELETE") {
        try {
          const doc = deleteDoc(id, req.headers.get("x-author"));
          broadcastChange(doc.seq);
          return json(doc);
        } catch (e) {
          if (e instanceof NotFoundError) return json({ error: e.message }, 404);
          return json({ error: String(e) }, 400);
        }
      }
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`forge-server escuchando en http://localhost:${server.port}`);
