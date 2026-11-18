import { withRouter, runCommand, type RosConnection, type TunnelTransport, type RosResult } from "@/lib/routeros";
import { resolveAgentTunnel, openAgentTunnel } from "@/lib/agent-tunnel";
import { decryptSecret } from "@/lib/crypto";
import type { Router } from "@prisma/client";

/**
 * v4 — transport-aware one-shot helpers.
 *
 * All feature code (vouchers, tools, subscribers, ROS manager, discovery) goes
 * through these instead of dialing directly, so an agent-managed router
 * (connectionMethod="agent") is automatically reached through the customer-LAN
 * agent's outbound tunnel. Direct-dial routers behave exactly as before.
 */

export type RouterLike = Pick<Router, "id" | "name" | "host" | "apiPort" | "apiSslPort" | "useTls" | "apiUsername" | "apiPasswordEnc" | "connectionMethod" | "agentId">;

async function buildTransport(router: RouterLike, port: number): Promise<TunnelTransport | undefined> {
  const tunnelInfo = await resolveAgentTunnel(router); // may throw with honest Arabic error
  if (!tunnelInfo) return undefined;
  return {
    describe: () => `agent tunnel (${tunnelInfo.agentName} → ${router.host}:${port})`,
    open: () => openAgentTunnel({ ...tunnelInfo, port, useTls: router.useTls }),
  };
}

/** Run commands against a router row (tunneled when agent-managed). */
export async function withRouterRow<T>(
  router: RouterLike,
  fn: (conn: RosConnection) => Promise<T>,
  opts?: { connectTimeoutMs?: number; commandTimeoutMs?: number },
): Promise<{ ok: boolean; error?: string; value?: T }> {
  const port = router.useTls ? router.apiSslPort : router.apiPort;
  let password = "";
  try {
    password = decryptSecret(router.apiPasswordEnc);
  } catch {
    return { ok: false, error: "تعذر فك تشفير بيانات الدخول (APP_SECRET mismatch)" };
  }
  let transport: TunnelTransport | undefined;
  try {
    transport = await buildTransport(router, port);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return withRouter(
    {
      host: router.host,
      port,
      useTls: router.useTls,
      username: router.apiUsername,
      password,
      connectTimeoutMs: opts?.connectTimeoutMs,
      commandTimeoutMs: opts?.commandTimeoutMs,
      transport,
    },
    fn,
  );
}

/** Single-command convenience over withRouterRow. */
export async function runOnRouter(router: RouterLike, command: string[], timeoutMs?: number): Promise<RosResult> {
  const res = await withRouterRow(router, (conn) => runCommand(conn, command, timeoutMs), { commandTimeoutMs: timeoutMs });
  if (!res.ok || !res.value) return { ok: false, error: res.error ?? "فشل الاتصال", data: [] };
  return res.value;
}
