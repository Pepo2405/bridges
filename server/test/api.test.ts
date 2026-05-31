import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// Tests de integración: levantan el server real como subproceso con DB y vault
// temporales (FORGE_DB/FORGE_VAULT) y lo ejercitan por HTTP. Evita importar
// db.ts/auth.ts directo, que abrirían la DB real al importarse.

const ADMIN = "fg_test_admin";

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

function spawnServer(port: number, extraEnv: Record<string, string> = {}) {
  const stamp = `${port}-${Date.now()}`;
  const db = join(tmpdir(), `forge-test-${stamp}.db`);
  const vault = join(tmpdir(), `forge-test-vault-${stamp}`);
  const proc = Bun.spawn({
    cmd: ["bun", "run", join(import.meta.dir, "..", "src", "index.ts")],
    env: { ...process.env, ...extraEnv, PORT: String(port), FORGE_DB: db, FORGE_VAULT: vault },
    stdout: "ignore",
    stderr: "ignore",
  });
  const cleanup = () => {
    proc.kill();
    for (const f of [db, `${db}-shm`, `${db}-wal`]) rmSync(f, { force: true });
    rmSync(vault, { recursive: true, force: true });
  };
  return { base: `http://localhost:${port}`, cleanup };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jsonHeaders = (t?: string) => ({ "content-type": "application/json", ...(t ? bearer(t) : {}) });

describe("server con auth (admin bootstrap)", () => {
  let base: string;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ base, cleanup } = spawnServer(4501, { FORGE_TOKEN: ADMIN }));
    await waitHealth(base);
  });
  afterAll(() => cleanup());

  test("whoami devuelve rol y nombre del token", async () => {
    const r = await fetch(`${base}/whoami`, { headers: bearer(ADMIN) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ authEnabled: true, role: "admin", name: "admin" });
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

    // primer update OK (base_version=1 → version pasa a 2)
    const ok = await fetch(`${base}/documents/${created.id}`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ path: "conf.md", content: "v2", base_version: 1, author: "t" }),
    });
    expect(ok.status).toBe(200);

    // segundo update con base_version vieja (1) → conflict
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

  test("admin gestiona tokens; editor queda bloqueado donde corresponde", async () => {
    // crear token editor
    const created = await (
      await fetch(`${base}/tokens`, {
        method: "POST",
        headers: jsonHeaders(ADMIN),
        body: JSON.stringify({ name: "ed", role: "editor" }),
      })
    ).json();
    expect(created.role).toBe("editor");
    expect(created.token).toStartWith("fg_");
    const editor = created.token;

    // whoami con el editor devuelve su nombre (identidad para el historial)
    const who = await (await fetch(`${base}/whoami`, { headers: bearer(editor) })).json();
    expect(who).toEqual({ authEnabled: true, role: "editor", name: "ed" });

    // nombre duplicado → 409
    const dup = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ name: "ed", role: "viewer" }),
    });
    expect(dup.status).toBe(409);

    // editor NO puede listar tokens (solo admin)
    expect((await fetch(`${base}/tokens`, { headers: bearer(editor) })).status).toBe(403);

    // editor puede crear documentos (write)…
    const create = await fetch(`${base}/documents`, {
      method: "POST",
      headers: jsonHeaders(editor),
      body: JSON.stringify({ path: "ed.md", content: "# ed", author: "ed" }),
    });
    expect(create.status).toBe(201);
    const edDoc = await create.json();

    // …pero NO borrar (delete es solo admin)
    expect((await fetch(`${base}/documents/${edDoc.id}`, { method: "DELETE", headers: bearer(editor) })).status).toBe(403);

    // admin sí borra
    expect((await fetch(`${base}/documents/${edDoc.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);

    // revocar token editor
    expect((await fetch(`${base}/tokens/ed`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
    // ya revocado: el token deja de valer
    expect((await fetch(`${base}/whoami`, { headers: bearer(editor) })).status).toBe(401);
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

  test("whoami informa authEnabled=false", async () => {
    expect(await (await fetch(`${base}/whoami`)).json()).toEqual({ authEnabled: false, role: null, name: null });
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
