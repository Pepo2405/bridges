import {
  createDoc,
  updateDoc,
  deleteDoc,
  listTrash,
  restoreDoc,
  purgeDoc,
  syncSince,
  getLastSeq,
  getHistory,
  getVersion,
  createVault,
  listVaults,
  getVault,
  ConflictError,
  NotFoundError,
} from "./db";
import { canDelete, recordDelete, recentDeletes, DELETE_LIMIT } from "./guard";
import { addClient, broadcastChange, clientCount } from "./events";
import { searchDocs } from "./search";
import { ensureVaultDir, isValidSlug } from "./vault";
import {
  authEnabled,
  identityForToken,
  roleCan,
  addToken,
  listTokens,
  revokeToken,
  ROLES,
  type Identity,
  type Perm,
  type Role,
} from "./auth";

const PORT = Number(process.env.PORT ?? 4321);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Author, X-Confirm-Bulk",
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

type AuthResult = { identity: Identity | null } | { denied: Response };

/**
 * Verifica el token y su permiso. Devuelve la identidad resuelta (null si la
 * auth está apagada) o la Response de error. El token va en `Authorization:
 * Bearer`, o por query `?token=` solo en /events (el EventSource del browser no
 * puede mandar headers). El vault del request sale de la identidad.
 */
function checkAuth(req: Request, url: URL): AuthResult {
  if (!authEnabled()) return { identity: null };
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const qToken = url.pathname === "/events" ? url.searchParams.get("token") : null;
  const identity = identityForToken(bearer ?? qToken);
  if (!identity) return { denied: json({ error: "unauthorized" }, 401) };
  if (!roleCan(identity.role, permFor(req.method))) return { denied: json({ error: "forbidden" }, 403) };
  return { identity };
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
      return json({ ok: true, vaults: listVaults().length, clients: clientCount() });
    }

    const auth = checkAuth(req, url);
    if ("denied" in auth) return auth.denied;
    const identity = auth.identity;
    // Vault del request: el del token (o `default` si la auth está apagada).
    const vault = identity?.vault ?? "default";

    // Autor de un cambio: si la request está autenticada, manda el nombre del token
    // (no se confía en lo que mande el cliente); sin auth, cae al valor del cliente.
    const authorFrom = (clientValue: string | null | undefined): string | null =>
      identity?.name ?? clientValue ?? null;

    // --- Identidad: GET /whoami → permisos + vault del token actual ---
    if (pathname === "/whoami" && req.method === "GET") {
      const enabled = authEnabled();
      const v = getVault(vault);
      return json({
        authEnabled: enabled,
        role: identity?.role ?? null,
        name: identity?.name ?? null,
        vault,
        vaultName: v?.name ?? vault,
        isOwner: identity?.isOwner ?? false,
      });
    }

    // --- Gestión de vaults (cross-vault): solo el owner ---
    if (pathname === "/vaults") {
      if (!identity?.isOwner) return json({ error: "forbidden" }, 403);

      if (req.method === "GET") return json({ vaults: listVaults() });

      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : slug;
        if (!isValidSlug(slug)) {
          return json({ error: "slug inválido: usá ^[a-z0-9][a-z0-9-]{0,63}$" }, 400);
        }
        try {
          const v = createVault(slug, name);
          ensureVaultDir(slug);
          const token = addToken(slug, "admin", "admin");
          return json({ vault: v, token }, 201); // el secreto se ve solo acá
        } catch (e) {
          if (e instanceof ConflictError) return json({ error: "el vault ya existe" }, 409);
          return json({ error: String(e) }, 400);
        }
      }

      return json({ error: "not found" }, 404);
    }

    // --- Gestión de tokens (API keys) del vault conectado: solo admin ---
    // Sin auth se permite: sirve para crear el primer token y arrancar la auth.
    if (pathname === "/tokens" || pathname.startsWith("/tokens/")) {
      if (authEnabled() && identity?.role !== "admin") return json({ error: "forbidden" }, 403);

      if (pathname === "/tokens" && req.method === "GET") {
        return json({ tokens: listTokens(vault) });
      }

      if (pathname === "/tokens" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const role = body?.role as Role;
        if (!name || !ROLES.includes(role)) {
          return json({ error: `name requerido y role en ${ROLES.join(" | ")}` }, 400);
        }
        try {
          const token = addToken(vault, name, role);
          return json({ name, role, token }, 201); // el secreto se ve solo acá
        } catch (e) {
          // PRIMARY KEY (vault, name) duplicado u otra constraint.
          return json({ error: `no se pudo crear el token: ${String(e)}` }, 409);
        }
      }

      const tokMatch = pathname.match(/^\/tokens\/(.+)$/);
      if (tokMatch && req.method === "DELETE") {
        const name = decodeURIComponent(tokMatch[1]);
        return revokeToken(vault, name) ? json({ ok: true }) : json({ error: "token no encontrado" }, 404);
      }

      return json({ error: "not found" }, 404);
    }

    // --- Pull incremental: GET /sync?since=<seq> ---
    if (pathname === "/sync" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      if (!Number.isFinite(since) || since < 0) return json({ error: "invalid since" }, 400);
      return json(syncSince(vault, since));
    }

    // --- Búsqueda full-text: GET /search?q=...&prefix=... ---
    if (pathname === "/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      return json({ results: searchDocs(vault, q, url.searchParams.get("prefix") || undefined) });
    }

    // --- Papelera: GET /trash (listar) ---
    if (pathname === "/trash" && req.method === "GET") {
      return json({ trash: listTrash(vault) });
    }

    // --- Papelera: DELETE /trash/:id (borrado físico, admin) ---
    const trashMatch = pathname.match(/^\/trash\/([^/]+)$/);
    if (trashMatch && req.method === "DELETE") {
      try {
        purgeDoc(vault, decodeURIComponent(trashMatch[1]));
        return json({ ok: true });
      } catch (e) {
        if (e instanceof NotFoundError) return json({ error: e.message }, 404);
        return json({ error: String(e) }, 400);
      }
    }

    // --- SSE: GET /events ---
    if (pathname === "/events" && req.method === "GET") {
      let cleanup = () => {};
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (data: string) => controller.enqueue(enc.encode(data));
          send(`data: ${JSON.stringify({ type: "hello", seq: getLastSeq(vault) })}\n\n`);
          const remove = addClient(vault, { send });
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
          vault,
          path: body.path,
          title: body.title ?? null,
          content: body.content,
          author: authorFrom(body.author),
        });
        broadcastChange(vault, doc.seq);
        return json(doc, 201);
      } catch (e) {
        if (e instanceof ConflictError) return json({ conflict: true, error: e.message, server: e.server }, 409);
        return json({ error: String(e) }, 400);
      }
    }

    // --- Historial: GET /documents/:id/history ---
    const histMatch = pathname.match(/^\/documents\/([^/]+)\/history$/);
    if (histMatch && req.method === "GET") {
      return json({ history: getHistory(vault, decodeURIComponent(histMatch[1])) });
    }

    // --- Contenido de una versión: GET /documents/:id/versions/:seq ---
    const verMatch = pathname.match(/^\/documents\/([^/]+)\/versions\/(\d+)$/);
    if (verMatch && req.method === "GET") {
      const content = getVersion(vault, decodeURIComponent(verMatch[1]), Number(verMatch[2]));
      if (content == null) return json({ error: "versión sin snapshot" }, 404);
      return json({ seq: Number(verMatch[2]), content });
    }

    // --- Restaurar: POST /documents/:id/restore ---
    const restoreMatch = pathname.match(/^\/documents\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      try {
        const doc = restoreDoc(vault, decodeURIComponent(restoreMatch[1]), authorFrom(req.headers.get("x-author")));
        broadcastChange(vault, doc.seq);
        return json(doc);
      } catch (e) {
        if (e instanceof NotFoundError) return json({ error: e.message }, 404);
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
            vault,
            id,
            path: body.path,
            title: body.title ?? null,
            content: body.content,
            base_version: body.base_version,
            author: authorFrom(body.author),
          });
          broadcastChange(vault, doc.seq);
          return json(doc);
        } catch (e) {
          if (e instanceof ConflictError) return json({ conflict: true, error: e.message, server: e.server }, 409);
          if (e instanceof NotFoundError) return json({ error: e.message }, 404);
          return json({ error: String(e) }, 400);
        }
      }

      if (req.method === "DELETE") {
        // Guardia anti-vaciado: si hay un borrado masivo en curso, frenar hasta
        // que el cliente reconfirme con x-confirm-bulk.
        const confirmBulk = req.headers.get("x-confirm-bulk") === "true";
        if (!confirmBulk && !canDelete(vault)) {
          return json(
            { error: "bulk delete guard tripped", code: "bulk_delete_guard", recent: recentDeletes(vault), limit: DELETE_LIMIT },
            429,
          );
        }
        try {
          const doc = deleteDoc(vault, id, authorFrom(req.headers.get("x-author")));
          recordDelete(vault);
          broadcastChange(vault, doc.seq);
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

console.log(`bridges-server escuchando en http://localhost:${server.port}`);
