import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

// Tests de integración: levantan el server real como subproceso con DB y vault
// temporales (BRIDGES_DB/BRIDGES_VAULT) y lo ejercitan por HTTP. Evita importar
// db.ts/auth.ts directo, que abrirían la DB real al importarse.

const ADMIN = "bg_test_admin";

async function waitHealth(base: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* todavía no levantó */
    }
    await Bun.sleep(50);
  }
  throw new Error("el server no levantó a tiempo");
}

function spawnServer(port: number, extraEnv: Record<string, string> = {}, paths?: { db: string; vault: string }) {
  const stamp = `${port}-${Date.now()}`;
  const db = paths?.db ?? join(tmpdir(), `bridges-test-${stamp}.db`);
  const vault = paths?.vault ?? join(tmpdir(), `bridges-test-vault-${stamp}`);
  const proc = Bun.spawn({
    cmd: ["bun", "run", join(import.meta.dir, "..", "src", "index.ts")],
    env: { ...process.env, ...extraEnv, PORT: String(port), BRIDGES_DB: db, BRIDGES_VAULT: vault },
    stdout: "ignore",
    stderr: "ignore",
  });
  const cleanup = () => {
    proc.kill();
    for (const f of [db, `${db}-shm`, `${db}-wal`]) rmSync(f, { force: true });
    rmSync(vault, { recursive: true, force: true });
  };
  return { base: `http://localhost:${port}`, cleanup, db, vault };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jsonHeaders = (t?: string) => ({ "content-type": "application/json", ...(t ? bearer(t) : {}) });

/** Abre /events con un token y junta los eventos durante `ms`, luego corta. */
async function collectEvents(base: string, token: string, ms: number): Promise<any[]> {
  const ctrl = new AbortController();
  const events: any[] = [];
  const stop = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${base}/events`, { headers: bearer(token), signal: ctrl.signal });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const evt = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of evt.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            events.push(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ping u otro */
          }
        }
      }
    }
  } catch {
    /* abort esperado */
  } finally {
    clearTimeout(stop);
  }
  return events;
}

describe("server con auth (admin bootstrap)", () => {
  let base: string;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ base, cleanup } = spawnServer(4501, { BRIDGES_TOKEN: ADMIN }));
    await waitHealth(base);
  });
  afterAll(() => cleanup());

  test("whoami devuelve rol, nombre y vault del token (owner → default)", async () => {
    const r = await fetch(`${base}/whoami`, { headers: bearer(ADMIN) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      authEnabled: true,
      role: "admin",
      name: "admin",
      vault: "default",
      vaultName: "default",
      isOwner: true,
    });
  });

  test("whoami sin token → 401", async () => {
    expect((await fetch(`${base}/whoami`)).status).toBe(401);
  });

  test("crear documento asigna seq y aparece en sync", async () => {
    const r = await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "a.md", content: "# A", author: "t" }),
    });
    expect(r.status).toBe(201);
    const doc = await r.json();
    expect(doc.version).toBe(1);
    expect(doc.seq).toBeGreaterThan(0);
    expect(doc.vault).toBe("default");

    const sync = await (await fetch(`${base}/sync?since=0`, { headers: bearer(ADMIN) })).json();
    expect(sync.documents.map((d: any) => d.path)).toContain("a.md");
  });

  test("update con base_version vieja → 409 conflict", async () => {
    const created = await (
      await fetch(`${base}/documents`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ path: "conf.md", content: "v1", author: "t" }),
      })
    ).json();

    const ok = await fetch(`${base}/documents/${created.id}`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "conf.md", content: "v2", base_version: 1, author: "t" }),
    });
    expect(ok.status).toBe(200);

    const stale = await fetch(`${base}/documents/${created.id}`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "conf.md", content: "v2-bis", base_version: 1, author: "t" }),
    });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.conflict).toBe(true);
    expect(body.server.content).toBe("v2");
  });

  test("history registra create + update (más reciente primero)", async () => {
    const created = await (
      await fetch(`${base}/documents`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ path: "hist.md", content: "v1", author: "t" }),
      })
    ).json();
    await fetch(`${base}/documents/${created.id}`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "hist.md", content: "v2", base_version: 1, author: "t" }),
    });
    const { history } = await (
      await fetch(`${base}/documents/${created.id}/history`, { headers: bearer(ADMIN) })
    ).json();
    expect(history.length).toBe(2);
    expect(history[0].action).toBe("update");
    expect(history[1].action).toBe("create");
    // El author sale del token (admin), no del body ("t") — ver test "no spoofing".
    expect(history[0].author).toBe("admin");
  });

  test("el author del historial sale del token, no del body (no spoofing)", async () => {
    const created = await (
      await fetch(`${base}/documents`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ path: "spoof.md", content: "v1", author: "victima" }),
      })
    ).json();
    const { history } = await (
      await fetch(`${base}/documents/${created.id}/history`, { headers: bearer(ADMIN) })
    ).json();
    expect(history[0].author).toBe("admin"); // el nombre del token, no "victima"
    expect(history[0].author).not.toBe("victima");
    // updated_by del doc también debe ser el del token
    const sync = await (await fetch(`${base}/sync?since=0`, { headers: bearer(ADMIN) })).json();
    const doc = sync.documents.find((d: any) => d.path === "spoof.md");
    expect(doc.updated_by).toBe("admin");
  });

  test("versions devuelve el snapshot de contenido de cada cambio", async () => {
    const created = await (
      await fetch(`${base}/documents`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ path: "ver.md", content: "uno", author: "t" }),
      })
    ).json();
    await fetch(`${base}/documents/${created.id}`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "ver.md", content: "dos", base_version: 1, author: "t" }),
    });
    const { history } = await (
      await fetch(`${base}/documents/${created.id}/history`, { headers: bearer(ADMIN) })
    ).json();
    const seqOf = (a: string) => history.find((h: any) => h.action === a).seq;
    const v1 = await (
      await fetch(`${base}/documents/${created.id}/versions/${seqOf("create")}`, { headers: bearer(ADMIN) })
    ).json();
    const v2 = await (
      await fetch(`${base}/documents/${created.id}/versions/${seqOf("update")}`, { headers: bearer(ADMIN) })
    ).json();
    expect(v1.content).toBe("uno");
    expect(v2.content).toBe("dos");
  });

  test("admin gestiona tokens; editor queda bloqueado donde corresponde", async () => {
    const created = await (
      await fetch(`${base}/tokens`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ name: "ed", role: "editor" }),
      })
    ).json();
    expect(created.role).toBe("editor");
    expect(created.token).toStartWith("bg_");
    const editor = created.token;

    const who = await (await fetch(`${base}/whoami`, { headers: bearer(editor) })).json();
    expect(who).toEqual({
      authEnabled: true,
      role: "editor",
      name: "ed",
      vault: "default",
      vaultName: "default",
      isOwner: false,
    });

    const dup = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ name: "ed", role: "viewer" }),
    });
    expect(dup.status).toBe(409);

    expect((await fetch(`${base}/tokens`, { headers: bearer(editor) })).status).toBe(403);

    const create = await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(editor),
      body: JSON.stringify({ path: "ed.md", content: "# ed", author: "ed" }),
    });
    expect(create.status).toBe(201);
    const edDoc = await create.json();

    expect((await fetch(`${base}/documents/${edDoc.id}`, { method: "DELETE", headers: bearer(editor) })).status).toBe(403);
    expect((await fetch(`${base}/documents/${edDoc.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);

    expect((await fetch(`${base}/tokens/ed`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
    expect((await fetch(`${base}/whoami`, { headers: bearer(editor) })).status).toBe(401);
  });
});

describe("multi-vault (owner crea y aísla vaults)", () => {
  let base: string;
  let cleanup: () => void;
  let trabajo: string; // token admin del vault "trabajo"

  beforeAll(async () => {
    ({ base, cleanup } = spawnServer(4503, { BRIDGES_TOKEN: ADMIN }));
    await waitHealth(base);
    const r = await fetch(`${base}/vaults`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ slug: "trabajo", name: "Trabajo" }),
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.vault.slug).toBe("trabajo");
    expect(body.token).toStartWith("bg_");
    trabajo = body.token;
  });
  afterAll(() => cleanup());

  test("el token del vault nuevo reporta su slug en whoami", async () => {
    const who = await (await fetch(`${base}/whoami`, { headers: bearer(trabajo) })).json();
    expect(who).toEqual({
      authEnabled: true,
      role: "admin",
      name: "admin",
      vault: "trabajo",
      vaultName: "Trabajo",
      isOwner: false,
    });
  });

  test("docs y seq aislados entre vaults", async () => {
    await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "solo-default.md", content: "d" }),
    });
    await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(trabajo),
      body: JSON.stringify({ path: "solo-trabajo.md", content: "t" }),
    });

    const defDocs = (await (await fetch(`${base}/sync?since=0`, { headers: bearer(ADMIN) })).json()).documents.map(
      (d: any) => d.path,
    );
    const trabDocs = (await (await fetch(`${base}/sync?since=0`, { headers: bearer(trabajo) })).json()).documents.map(
      (d: any) => d.path,
    );
    expect(defDocs).toContain("solo-default.md");
    expect(defDocs).not.toContain("solo-trabajo.md");
    expect(trabDocs).toContain("solo-trabajo.md");
    expect(trabDocs).not.toContain("solo-default.md");
  });

  test("búsqueda aislada por vault", async () => {
    const trab = (await (await fetch(`${base}/search?q=solo`, { headers: bearer(trabajo) })).json()).results.map(
      (r: any) => r.path,
    );
    expect(trab).toEqual(["solo-trabajo.md"]);
  });

  test("un id de un vault no se toca con el token de otro → 404", async () => {
    const doc = await (
      await fetch(`${base}/documents`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ path: "cross.md", content: "x" }),
      })
    ).json();
    // update con token de trabajo
    const upd = await fetch(`${base}/documents/${doc.id}`, {
      method: "POST",
      headers: jsonHeaders(trabajo),
      body: JSON.stringify({ path: "cross.md", content: "y", base_version: 1 }),
    });
    expect(upd.status).toBe(404);
    // delete con token de trabajo
    expect((await fetch(`${base}/documents/${doc.id}`, { method: "DELETE", headers: bearer(trabajo) })).status).toBe(404);
    // history vacío para el token ajeno
    const { history } = await (await fetch(`${base}/documents/${doc.id}/history`, { headers: bearer(trabajo) })).json();
    expect(history).toEqual([]);
  });

  test("SSE por vault: un cambio en default no llega a trabajo", async () => {
    const defP = collectEvents(base, ADMIN, 600);
    const trabP = collectEvents(base, trabajo, 600);
    await Bun.sleep(120);
    await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "sse.md", content: "x" }),
    });
    const [defEvents, trabEvents] = await Promise.all([defP, trabP]);
    expect(defEvents.some((e) => e.type === "change")).toBe(true);
    expect(trabEvents.some((e) => e.type === "change")).toBe(false);
  });

  test("/vaults RBAC: token no-owner → 403", async () => {
    expect((await fetch(`${base}/vaults`, { headers: bearer(trabajo) })).status).toBe(403);
  });

  test("/vaults validación de slug → 400 y duplicado → 409", async () => {
    const bad = await fetch(`${base}/vaults`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ slug: "MAYÚS no", name: "x" }),
    });
    expect(bad.status).toBe(400);

    const dup = await fetch(`${base}/vaults`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ slug: "trabajo", name: "otra" }),
    });
    expect(dup.status).toBe(409);
  });

  test("tokens scopeados: el admin de trabajo solo ve los suyos", async () => {
    await fetch(`${base}/tokens`, {
      method: "POST",
      headers: jsonHeaders(trabajo),
      body: JSON.stringify({ name: "trab-editor", role: "editor" }),
    });
    const trabTokens = (await (await fetch(`${base}/tokens`, { headers: bearer(trabajo) })).json()).tokens.map(
      (t: any) => t.name,
    );
    expect(trabTokens).toContain("trab-editor");
    expect(trabTokens).toContain("admin"); // el admin emitido al crear el vault

    const defTokens = (await (await fetch(`${base}/tokens`, { headers: bearer(ADMIN) })).json()).tokens.map(
      (t: any) => t.name,
    );
    expect(defTokens).not.toContain("trab-editor");
  });
});

describe("migración del esquema viejo a multi-vault", () => {
  let base: string;
  let cleanup: () => void;
  let db: string;
  let vault: string;
  const LEGACY = "bg_legacy_token";

  function buildOldDb(dbPath: string, vaultDir: string) {
    const d = new Database(dbPath, { create: true });
    d.exec("PRAGMA journal_mode = WAL;");
    d.exec(`
      CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), last_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE changes (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
        author TEXT, action TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT);
      CREATE TABLE tokens (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO meta (id, last_seq) VALUES (1, 2);
    `);
    const now = new Date().toISOString();
    d.query(
      "INSERT INTO documents (id, path, title, content, version, seq, deleted, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("doc-1", "old.md", "Old", "# Old", 1, 1, 0, "t", now);
    d.query("INSERT INTO changes (doc_id, seq, author, action, created_at, content) VALUES (?,?,?,?,?,?)").run(
      "doc-1",
      1,
      "t",
      "create",
      now,
      "# Old",
    );
    d.query("INSERT INTO tokens (name, token_hash, role, created_at) VALUES (?,?,?,?)").run(
      "legacy",
      createHash("sha256").update(LEGACY).digest("hex"),
      "admin",
      now,
    );
    d.close();
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "old.md"), "# Old");
  }

  beforeAll(async () => {
    const stamp = `mig-${Date.now()}`;
  db = join(tmpdir(), `bridges-test-${stamp}.db`);
  vault = join(tmpdir(), `bridges-test-vault-${stamp}`);
    buildOldDb(db, vault);
    ({ base, cleanup } = spawnServer(4504, {}, { db, vault }));
    await waitHealth(base);
  });
  afterAll(() => {
    cleanup();
    // limpiar backups generados por la migración
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith(`${db.split("/").pop()}`) && f.includes(".bak")) rmSync(join(tmpdir(), f), { force: true });
    }
  });

  test("el token viejo sigue valiendo y cae en el vault default", async () => {
    const who = await (await fetch(`${base}/whoami`, { headers: bearer(LEGACY) })).json();
    expect(who.vault).toBe("default");
    expect(who.role).toBe("admin");
    expect(who.authEnabled).toBe(true);
  });

  test("los docs viejos quedan en default con su last_seq", async () => {
    const sync = await (await fetch(`${base}/sync?since=0`, { headers: bearer(LEGACY) })).json();
    expect(sync.documents.map((d: any) => d.path)).toContain("old.md");
    expect(sync.documents[0].vault).toBe("default");
    expect(sync.last_seq).toBe(2);
  });

  test("el archivo viejo se movió a default/ y existe el backup", async () => {
    expect(existsSync(join(vault, "default", "old.md"))).toBe(true);
    expect(existsSync(join(vault, "old.md"))).toBe(false);
    const baks = readdirSync(tmpdir()).filter(
      (f) => f.startsWith(`${db.split("/").pop()}`) && f.includes(".bak-pre-multivault"),
    );
    expect(baks.length).toBeGreaterThan(0);
  });

  test("re-arranque idempotente: nuevo seq sobre el migrado", async () => {
    const { base: base2, cleanup: cleanup2 } = spawnServer(4505, {}, { db, vault });
    try {
      await waitHealth(base2);
      const created = await (
        await fetch(`${base2}/documents`, {
          method: "POST",
          headers: jsonHeaders(LEGACY),
          body: JSON.stringify({ path: "nuevo.md", content: "n" }),
        })
      ).json();
      expect(created.seq).toBe(3); // last_seq venía en 2
      expect(created.vault).toBe("default");
    } finally {
      cleanup2();
    }
  });
});

describe("server sin auth", () => {
  let base: string;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ base, cleanup } = spawnServer(4502));
    await waitHealth(base);
  });
  afterAll(() => cleanup());

  test("whoami informa authEnabled=false (vault default)", async () => {
    expect(await (await fetch(`${base}/whoami`)).json()).toEqual({
      authEnabled: false,
      role: null,
      name: null,
      vault: "default",
      vaultName: "default",
      isOwner: false,
    });
  });

  test("cualquiera puede crear en un vault vacío", async () => {
    expect((await fetch(`${base}/sync?since=0`)).status).toBe(200);
    const r = await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ path: "libre.md", content: "# libre" }),
    });
    expect(r.status).toBe(201);
  });
});

describe("búsqueda FTS5 (ranking, snippets, borrados)", () => {
  let base: string;
  let cleanup: () => void;

  const post = (path: string, content: string) =>
    fetch(`${base}/documents`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ path, content }) });
  const search = async (q: string) =>
    (await (await fetch(`${base}/search?q=${encodeURIComponent(q)}`)).json()).results as {
      path: string;
      title: string | null;
      snippet: string;
    }[];

  beforeAll(async () => {
    ({ base, cleanup } = spawnServer(4503));
    await waitHealth(base);
    await post("relevante.md", "# Kubernetes\nkubernetes kubernetes kubernetes cluster deployment namespace");
    await post("incidental.md", "# Notas varias\nuna mención de kubernetes al pasar, nada más");
    await post("acentos.md", "# Biología\nla mitocondría produce energía en la célula");
    await post("ruido.md", "# Otro\ntexto sin relación alguna con el resto");
  });
  afterAll(() => cleanup());

  test("BM25 rankea el doc relevante por encima de la mención incidental", async () => {
    const hits = await search("kubernetes");
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("relevante.md");
    expect(paths).toContain("incidental.md");
    expect(paths.indexOf("relevante.md")).toBeLessThan(paths.indexOf("incidental.md"));
  });

  test("el snippet contiene el término buscado", async () => {
    const [top] = await search("kubernetes");
    expect(top.snippet.toLowerCase()).toContain("kubernetes");
  });

  test("prefix match: 'kuber' encuentra 'kubernetes'", async () => {
    expect((await search("kuber")).map((h) => h.path)).toContain("relevante.md");
  });

  test("sin match de todos los términos, cae a OR", async () => {
    const paths = (await search("kubernetes inexistentezz")).map((h) => h.path);
    expect(paths[0]).toBe("relevante.md");
  });

  test("insensible a acentos: 'mitocondria' encuentra 'mitocondría'", async () => {
    expect((await search("mitocondria")).map((h) => h.path)).toContain("acentos.md");
  });

  test("los borrados quedan fuera de la búsqueda", async () => {
    const doc = await (await post("efimero.md", "# Efímero\ncontenido kubernetes borrable")).json();
    expect((await search("efímero")).map((h) => h.path)).toContain("efimero.md");
    expect((await fetch(`${base}/documents/${doc.id}`, { method: "DELETE", headers: jsonHeaders() })).status).toBe(200);
    expect((await search("efímero")).map((h) => h.path)).not.toContain("efimero.md");
  });

  test("query vacía o sin tokens → sin resultados, sin error", async () => {
    expect(await search("")).toEqual([]);
    expect(await search("   ")).toEqual([]);
    expect(await search('"')).toEqual([]);
  });

  test("caracteres especiales de FTS5 no rompen la query", async () => {
    for (const q of ["foo:bar", "AND OR NOT", "a* b(c)", '"quoted"', "kubernetes -cluster"]) {
      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(Array.isArray((await r.json()).results)).toBe(true);
    }
  });
});

describe("papelera: restaurar y borrado definitivo", () => {
  let base: string;
  let cleanup: () => void;
  let vault: string;
  let viewer: string;
  let editor: string;

  const create = async (path: string, content = "x") =>
    await (
      await fetch(`${base}/documents`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ path, content, author: "t" }),
      })
    ).json();
  const del = (id: string, token = ADMIN) =>
    fetch(`${base}/documents/${id}`, { method: "DELETE", headers: bearer(token) });
  const mkToken = async (name: string, role: string) =>
    (
      await (
        await fetch(`${base}/tokens`, { method: "POST", headers: jsonHeaders(ADMIN), body: JSON.stringify({ name, role }) })
      ).json()
    ).token;

  beforeAll(async () => {
    ({ base, cleanup, vault } = spawnServer(4506, { BRIDGES_TOKEN: ADMIN }));
    await waitHealth(base);
    viewer = await mkToken("v", "viewer");
    editor = await mkToken("e", "editor");
  });
  afterAll(() => cleanup());

  test("restore trae el doc de vuelta (deleted=0, .md reescrito, seq nuevo, change restore)", async () => {
    const doc = await create("restore-me.md", "hola");
    expect((await del(doc.id)).status).toBe(200);
    // está en la papelera y su .md ya no está en disco
    const trash = (await (await fetch(`${base}/trash`, { headers: bearer(ADMIN) })).json()).trash;
    expect(trash.map((t: any) => t.id)).toContain(doc.id);
    expect(existsSync(join(vault, "default", "restore-me.md"))).toBe(false);

    const r = await fetch(`${base}/documents/${doc.id}/restore`, { method: "POST", headers: bearer(ADMIN) });
    expect(r.status).toBe(200);
    const restored = await r.json();
    expect(restored.deleted).toBe(0);
    expect(restored.content).toBe("hola");
    expect(restored.seq).toBeGreaterThan(doc.seq);
    expect(existsSync(join(vault, "default", "restore-me.md"))).toBe(true);

    const trash2 = (await (await fetch(`${base}/trash`, { headers: bearer(ADMIN) })).json()).trash;
    expect(trash2.map((t: any) => t.id)).not.toContain(doc.id);
    const { history } = await (await fetch(`${base}/documents/${doc.id}/history`, { headers: bearer(ADMIN) })).json();
    expect(history[0].action).toBe("restore");
  });

  test("restore de doc inexistente → 404", async () => {
    const r = await fetch(`${base}/documents/no-existe/restore`, { method: "POST", headers: bearer(ADMIN) });
    expect(r.status).toBe(404);
  });

  test("borrado definitivo saca el doc de la papelera y ya no se restaura", async () => {
    const doc = await create("purge-me.md");
    await del(doc.id);
    expect((await fetch(`${base}/trash/${doc.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
    const trash = (await (await fetch(`${base}/trash`, { headers: bearer(ADMIN) })).json()).trash;
    expect(trash.map((t: any) => t.id)).not.toContain(doc.id);
    expect((await fetch(`${base}/documents/${doc.id}/restore`, { method: "POST", headers: bearer(ADMIN) })).status).toBe(404);
  });

  test("permisos: viewer no restaura (403), editor no purga (403)", async () => {
    const doc = await create("perm.md");
    await del(doc.id);
    expect((await fetch(`${base}/documents/${doc.id}/restore`, { method: "POST", headers: bearer(viewer) })).status).toBe(403);
    expect((await fetch(`${base}/trash/${doc.id}`, { method: "DELETE", headers: bearer(editor) })).status).toBe(403);
  });
});

describe("guardia anti-vaciado (circuit breaker)", () => {
  let base: string;
  let cleanup: () => void;

  const create = async (path: string) =>
    await (
      await fetch(`${base}/documents`, { method: "POST", headers: jsonHeaders(ADMIN), body: JSON.stringify({ path, content: "x" }) })
    ).json();

  beforeAll(async () => {
    ({ base, cleanup } = spawnServer(4507, { BRIDGES_TOKEN: ADMIN, BRIDGES_DELETE_LIMIT: "3", BRIDGES_DELETE_WINDOW: "60" }));
    await waitHealth(base);
  });
  afterAll(() => cleanup());

  test("tras superar el umbral el delete → 429; x-confirm-bulk lo saltea", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await create(`b${i}.md`)).id);

    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${base}/documents/${ids[i]}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
    }
    const tripped = await fetch(`${base}/documents/${ids[3]}`, { method: "DELETE", headers: bearer(ADMIN) });
    expect(tripped.status).toBe(429);
    expect((await tripped.json()).code).toBe("bulk_delete_guard");

    const bypass = await fetch(`${base}/documents/${ids[3]}`, {
      method: "DELETE",
      headers: { ...bearer(ADMIN), "x-confirm-bulk": "true" },
    });
    expect(bypass.status).toBe(200);
  });
});
