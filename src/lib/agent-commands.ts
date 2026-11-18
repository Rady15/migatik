import { db } from "@/lib/db";

/**
 * v4 — enqueue an agent command and wait for the result.
 * The realtime service (port 3003) dispatches queued AgentCommands over the
 * agent's outbound socket and writes the result back into the row.
 */
export async function enqueueAgentCommand<T = unknown>(
  agentId: string,
  type: string,
  payload: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string; result?: T }> {
  const timeoutMs = opts?.timeoutMs ?? 30000;
  const row = await db.agentCommand.create({
    data: { agentId, command: JSON.stringify({ type, payload }) },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = await db.agentCommand.findUnique({ where: { id: row.id } });
    if (!cur) return { ok: false, error: "agent command row vanished" };
    if (cur.status === "done") {
      try {
        return { ok: true, result: cur.result ? (JSON.parse(cur.result) as T) : ({} as T) };
      } catch {
        return { ok: false, error: "agent result not parseable", result: (cur.result as unknown) ?? undefined };
      }
    }
    if (cur.status === "failed") return { ok: false, error: cur.error ?? "agent command failed" };
    if (cur.status === "expired") return { ok: false, error: cur.error ?? "agent offline — command expired" };
  }
  return { ok: false, error: "انتهت مهلة انتظار استجابة الوكيل" };
}
