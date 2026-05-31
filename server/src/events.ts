/** Hub de Server-Sent Events, scopeado por vault. Mantiene los clientes
 * suscritos por vault y emite `seq` solo a los del vault que cambió. */

type Client = {
  send: (data: string) => void;
};

const clients = new Map<string, Set<Client>>();

export function addClient(vault: string, client: Client): () => void {
  let set = clients.get(vault);
  if (!set) clients.set(vault, (set = new Set()));
  set.add(client);
  return () => {
    const s = clients.get(vault);
    if (!s) return;
    s.delete(client);
    if (s.size === 0) clients.delete(vault);
  };
}

export function broadcastChange(vault: string, seq: number): void {
  const set = clients.get(vault);
  if (!set) return;
  const payload = `data: ${JSON.stringify({ type: "change", seq })}\n\n`;
  for (const c of set) {
    try {
      c.send(payload);
    } catch {
      set.delete(c);
    }
  }
}

export function clientCount(): number {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}
