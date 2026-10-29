/**
 * Modo hook (CLI): `bridges-mcp hook session-start` lee el JSON que Claude Code pasa
 * por stdin (`{cwd, source, ...}`) e imprime el contexto del proyecto como
 * `additionalContext`. Con `source: "compact"` además pide guardar la Bitácora.
 * Nunca falla: si no hay .bridges o algo sale mal, no imprime nada (no bloquea la sesión).
 */
import { resolveProject, projectContext } from "./memory";

export function runHook(event: string | undefined, stdin: string, now?: Date): string {
  if (event !== "session-start") return "";
  try {
    const data = JSON.parse(stdin || "{}") as { cwd?: string; source?: string };
    const p = resolveProject({ cwd: data.cwd || process.cwd() });
    const ctx = projectContext(p, { now, compacted: data.source === "compact", maxChars: 3500 });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } });
  } catch {
    return "";
  }
}
