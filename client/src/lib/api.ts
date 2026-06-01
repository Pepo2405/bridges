/** Cliente del server Forge: REST + suscripción SSE. */

export type Doc = {
  id: string;
  path: string;
  title: string | null;
  content: string;
  version: number;
  seq: number;
  deleted: number;
  updated_by: string | null;
  updated_at: string;
};

export type Change = { seq: number; author: string | null; action: string; created_at: string };

export type SyncResponse = { documents: Doc[]; last_seq: number };
export type SearchHit = { id: string; path: string; title: string | null; snippet: string };
export type TrashItem = {
  id: string;
  path: string;
  title: string | null;
  updated_by: string | null;
  updated_at: string;
  seq: number;
};
export type TokenInfo = { name: string; role: string; created_at: string };
export type VaultInfo = { slug: string; name: string; last_seq: number; created_at: string };

export type WhoAmI = {
  authEnabled: boolean;
  role: string | null;
  name: string | null;
  // Opcionales: un server viejo (pre-multivault) no los manda.
  vault?: string;
  vaultName?: string;
  isOwner?: boolean;
};

export type ConflictResult = { conflict: true; server: Doc };
export type SaveResult = { ok: true; doc: Doc } | ConflictResult;

/** Error de la API que conserva el status HTTP (para distinguir 401/403/409…). */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class ForgeApi {
  private token: string | null = null;

  constructor(private base: string) {}

  setBase(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  setToken(token: string | null) {
    this.token = token || null;
  }

  private url(p: string) {
    return `${this.base.replace(/\/$/, "")}${p}`;
  }

  /** Headers con auth (y los extra que se pasen). */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  async health(): Promise<{ ok: boolean }> {
    const r = await fetch(this.url("/health"));
    if (!r.ok) throw new ApiError(r.status, `health ${r.status}`);
    return r.json();
  }

  async whoami(): Promise<WhoAmI> {
    const r = await fetch(this.url("/whoami"), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `whoami ${r.status}`);
    return r.json();
  }

  /** Lista los vaults del server (solo el owner). */
  async listVaults(): Promise<VaultInfo[]> {
    const r = await fetch(this.url("/vaults"), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `vaults ${r.status}`);
    return (await r.json()).vaults;
  }

  /** Crea un vault y devuelve su token admin (solo se ve una vez). */
  async createVault(slug: string, name: string): Promise<{ vault: VaultInfo; token: string }> {
    const r = await fetch(this.url("/vaults"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ slug, name }),
    });
    if (!r.ok) throw new ApiError(r.status, `create vault ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async listTokens(): Promise<TokenInfo[]> {
    const r = await fetch(this.url("/tokens"), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `tokens ${r.status}`);
    return (await r.json()).tokens;
  }

  /** Crea un token y devuelve el secreto en claro (solo se ve una vez). */
  async createToken(name: string, role: string): Promise<{ name: string; role: string; token: string }> {
    const r = await fetch(this.url("/tokens"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ name, role }),
    });
    if (!r.ok) throw new ApiError(r.status, `create token ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async revokeToken(name: string): Promise<void> {
    const r = await fetch(this.url(`/tokens/${encodeURIComponent(name)}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok) throw new ApiError(r.status, `revoke token ${r.status}`);
  }

  async sync(since: number): Promise<SyncResponse> {
    // Timeout para que un pull no quede colgado indefinidamente (p.ej. pool de conexiones saturado).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(this.url(`/sync?since=${since}`), { signal: ctrl.signal, headers: this.headers() });
      if (!r.ok) throw new ApiError(r.status, `sync ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async history(id: string): Promise<Change[]> {
    const r = await fetch(this.url(`/documents/${encodeURIComponent(id)}/history`), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `history ${r.status}`);
    return (await r.json()).history;
  }

  /** Contenido del doc tal como quedó en un cambio (seq). */
  async version(id: string, seq: number): Promise<string> {
    const r = await fetch(this.url(`/documents/${encodeURIComponent(id)}/versions/${seq}`), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `version ${r.status}`);
    return (await r.json()).content;
  }

  async search(q: string): Promise<SearchHit[]> {
    const r = await fetch(this.url(`/search?q=${encodeURIComponent(q)}`), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `search ${r.status}`);
    return (await r.json()).results;
  }

  async create(input: { path: string; title?: string; content: string; author?: string }): Promise<SaveResult> {
    const r = await fetch(this.url("/documents"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(input),
    });
    if (r.status === 409) return { conflict: true, server: (await r.json()).server };
    if (!r.ok) throw new ApiError(r.status, `create ${r.status}: ${await r.text()}`);
    return { ok: true, doc: await r.json() };
  }

  async update(
    id: string,
    input: { path: string; title?: string; content: string; base_version: number; author?: string },
  ): Promise<SaveResult> {
    const r = await fetch(this.url(`/documents/${id}`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(input),
    });
    if (r.status === 409) return { conflict: true, server: (await r.json()).server };
    if (!r.ok) throw new ApiError(r.status, `update ${r.status}: ${await r.text()}`);
    return { ok: true, doc: await r.json() };
  }

  /** Borra (soft) un doc. Si la guardia anti-vaciado dispara, tira ApiError 429;
   *  reintentar con confirmBulk=true para destrabar. */
  async remove(id: string, author?: string, confirmBulk = false): Promise<Doc> {
    const extra: Record<string, string> = {};
    if (author) extra["x-author"] = author;
    if (confirmBulk) extra["x-confirm-bulk"] = "true";
    const r = await fetch(this.url(`/documents/${id}`), {
      method: "DELETE",
      headers: this.headers(extra),
    });
    if (!r.ok) throw new ApiError(r.status, `delete ${r.status}`);
    return r.json();
  }

  /** Lista la papelera (docs borrados del vault). */
  async trash(): Promise<TrashItem[]> {
    const r = await fetch(this.url("/trash"), { headers: this.headers() });
    if (!r.ok) throw new ApiError(r.status, `trash ${r.status}`);
    return (await r.json()).trash;
  }

  /** Restaura un doc borrado. */
  async restore(id: string, author?: string): Promise<Doc> {
    const r = await fetch(this.url(`/documents/${encodeURIComponent(id)}/restore`), {
      method: "POST",
      headers: this.headers(author ? { "x-author": author } : {}),
    });
    if (!r.ok) throw new ApiError(r.status, `restore ${r.status}`);
    return r.json();
  }

  /** Borra físicamente un doc de la papelera (admin). */
  async purge(id: string): Promise<void> {
    const r = await fetch(this.url(`/trash/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok) throw new ApiError(r.status, `purge ${r.status}`);
  }

  /** Se suscribe a /events. Llama onChange(seq) por cada evento de cambio. Devuelve un cleanup. */
  subscribe(onChange: (seq: number) => void, onStatus?: (connected: boolean) => void): () => void {
    // No usamos EventSource: en el WKWebView de macOS no entrega eventos cuando el
    // stream va sobre HTTP/2 (abre la conexión pero nunca dispara onopen/onmessage).
    // Leemos el stream con fetch + ReadableStream, que sí funciona sobre h2; además
    // el token viaja por header Authorization (no por query param).
    const ctrl = new AbortController();
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        const r = await fetch(this.url("/events"), {
          headers: this.headers({ accept: "text/event-stream" }),
          signal: ctrl.signal,
        });
        if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
        onStatus?.(true);

        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // Eventos SSE separados por línea en blanco.
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const evt = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            for (const line of evt.split("\n")) {
              if (!line.startsWith("data:")) continue; // ": ping" u otros: ignorar
              try {
                const data = JSON.parse(line.slice(5).trim());
                if (data.type === "change") onChange(data.seq);
              } catch {
                /* no-JSON: ignorar */
              }
            }
          }
        }
      } catch {
        /* error de red / abort: cae a reconexión */
      }
      if (closed) return;
      onStatus?.(false);
      retry = setTimeout(run, 3000); // reconectar
    };

    run();
    return () => {
      closed = true;
      clearTimeout(retry);
      ctrl.abort();
    };
  }
}
