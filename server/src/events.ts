/** Hub de Server-Sent Events. Mantiene los clientes suscritos y emite `seq` en cada cambio. */

type Client = {
  send: (data: string) => void;
};

const clients = new Set<Client>();

export function addClient(client: Client): () => void {
  clients.add(client);
  return () => clients.delete(client);
}

export function broadcastChange(seq: number): void {
  const payload = `data: ${JSON.stringify({ type: "change", seq })}\n\n`;
  for (const c of clients) {
    try {
      c.send(payload);
    } catch {
      clients.delete(c);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
