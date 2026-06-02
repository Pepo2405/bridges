/**
 * Circuit breaker contra vaciado. Cuenta los soft-deletes recientes por vault en
 * memoria; si superan el umbral dentro de la ventana, `canDelete()` devuelve
 * false y el handler de DELETE responde 429 hasta que el cliente reconfirme
 * (header `x-confirm-bulk: true`). El estado se resetea al reiniciar el server.
 */

export const DELETE_LIMIT = Number(process.env.BRIDGES_DELETE_LIMIT ?? 10);
const WINDOW_MS = Number(process.env.BRIDGES_DELETE_WINDOW ?? 60) * 1000;

const recent = new Map<string, number[]>();

function prune(vault: string, now: number): number[] {
  const arr = (recent.get(vault) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.set(vault, arr);
  return arr;
}

/** Soft-deletes registrados en la ventana actual. */
export function recentDeletes(vault: string): number {
  return prune(vault, Date.now()).length;
}

/** ¿Se permite borrar sin reconfirmación? false si el breaker está disparado. */
export function canDelete(vault: string): boolean {
  return recentDeletes(vault) < DELETE_LIMIT;
}

/** Registra un soft-delete consumado para la ventana. */
export function recordDelete(vault: string): void {
  const now = Date.now();
  prune(vault, now).push(now);
}
