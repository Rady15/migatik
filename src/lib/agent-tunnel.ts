import { Duplex } from "node:stream";
import { io, Socket } from "socket.io-client";
import crypto from "node:crypto";
import { db } from "@/lib/db";

/**
 * v4 — Agent TCP tunnel.
 *
 * When a Router row has connectionMethod="agent", the platform does NOT dial
 * the router directly (it cannot — the router sits behind NAT/CGNAT in the
 * customer LAN). Instead the platform opens a byte-level TCP tunnel:
 *
 *   Next.js (RouterOS client) ──socket.io(/bridge, localhost:3003)──▶ Realtime
 *   service ──existing agent socket(/agent, outbound from LAN)──▶ Agent ──TCP──▶
 *   router:8728
 *
 * The agent listens on NO ports; everything travels inside the agent's own
 * outbound TLS WebSocket — which is exactly why this works from behind
 * NAT/CGNAT with zero port forwarding.
 */

const REALTIME_URL = process.env.REALTIME_URL || "http://127.0.0.1:3003";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";

let bridge: Socket | null = null;
let connecting: Promise<Socket> | null = null;

export function bridgeConfigured(): boolean {
  return BRIDGE_TOKEN.length > 0;
}

/**
 * Push router config to a CONNECTED agent over the internal bridge socket.
 * Replaces the old /agent-config HTTP sidecar, which could never work because
 * engine.io owns every HTTP request on the realtime port.
 */
export async function pushAgentConfig(agentId: string, routers: unknown): Promise<{ ok: boolean; detail: string }> {
  if (!bridgeConfigured()) return { ok: false, detail: "deferred — BRIDGE_TOKEN غير مضبوط، الوكيل يستلم الإعدادات عند إعادة الاتصال" };
  try {
    const s = await getBridge();
    s.emit("bridge:agent_config", { agentId, routers });
    return { ok: true, detail: "sent" };
  } catch (e) {
    return { ok: false, detail: `deferred — ${(e as Error).message}` };
  }
}

function getBridge(): Promise<Socket> {
  if (bridge?.connected) return Promise.resolve(bridge);
  if (connecting) return connecting;
  connecting = new Promise<Socket>((resolve, reject) => {
    if (!BRIDGE_TOKEN) {
      reject(new Error("BRIDGE_TOKEN غير مضبوط — لا يمكن استخدام نفق الوكيل"));
      return;
    }
    const s = io(`${REALTIME_URL}/bridge`, {
      path: "/",
      transports: ["websocket"],
      auth: { bridgeToken: BRIDGE_TOKEN },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 5000,
    });
    const fail = (e: Error) => { connecting = null; try { s.close(); } catch {} reject(e); };
    s.on("connect_error", (e: Error) => fail(new Error(`تعذر الاتصال بخدمة الوقت الحقيقي: ${e.message}`)));
    s.on("connect_timeout", () => fail(new Error("مهلة الاتصال بخدمة الوقت الحقيقي")));
    s.on("disconnect", () => { bridge = null; });
    s.on("connect", () => {
      bridge = s;
      connecting = null;
      resolve(s);
    });
  });
  return connecting;
}

export interface AgentTunnelInfo {
  agentId: string;
  agentName: string;
  host: string;
  port: number;
  useTls: boolean;
}

/**
 * Resolve the transport for a Router row. Returns tunnel info when the router
 * is agent-managed and its agent is online, otherwise null (direct dial).
 * Throws with an honest Arabic message when an agent-managed router cannot be
 * reached (agent offline / not configured) — never silently falls back to a
 * direct dial that cannot succeed behind NAT.
 */
export async function resolveAgentTunnel(router: {
  id: string; name: string; host: string; connectionMethod: string; agentId?: string | null;
}): Promise<AgentTunnelInfo | null> {
  if (router.connectionMethod !== "agent") return null;
  const agentId = router.agentId;
  if (!agentId) {
    throw new Error(`السيرفر «${router.name}» مضبوط للاتصال عبر وكيل لكن لا وكيل معيَّن له — عيِّن وكيلًا أولاً`);
  }
  const agent = await (db as any).networkAgent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true, status: true, lastSeenAt: true },
  });
  if (!agent) throw new Error("الوكيل المعيَّن غير موجود");
  const online = agent.lastSeenAt ? Date.now() - new Date(agent.lastSeenAt).getTime() < 60_000 : false;
  if (agent.status !== "online" || !online) {
    throw new Error(`الوكيل «${agent.name}» غير متصل حاليًا — لا يمكن الوصول لسيرفرات شبكة العميل عبره`);
  }
  return { agentId: agent.id, agentName: agent.name, host: router.host, port: 0, useTls: false };
}

/** Open a raw TCP stream to (host, port) through the agent. Resolves only when the agent confirms the stream. */
export async function openAgentTunnel(info: AgentTunnelInfo & { port: number; useTls: boolean }, openTimeoutMs = 10000): Promise<Duplex> {
  const s = await getBridge();
  const streamId = crypto.randomUUID();
  return new Promise<Duplex>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupOpenPhase();
      detachAll();
      reject(new Error("مهلة فتح النفق عبر الوكيل (timeout)"));
    }, openTimeoutMs);

    // open-phase listeners (removed once the stream is established)
    const onReady = (d: { streamId: string }) => {
      if (d.streamId === streamId) {
        cleanupOpenPhase();
        duplex.resume(); // start flowing — RosConnection listens via "data" events
        resolve(duplex);
      }
    };
    const onError = (d: { streamId: string; error: string }) => {
      if (d.streamId !== streamId) return;
      cleanupOpenPhase();
      detachAll();
      reject(new Error(d.error || "فشل فتح النفق عبر الوكيل"));
    };
    // data-phase listeners (live for the whole stream lifetime)
    const onData = (d: { streamId: string; chunk: string }) => {
      if (d.streamId !== streamId) return;
      duplex.push(Buffer.from(d.chunk, "base64"));
    };
    const onClose = (d: { streamId: string }) => {
      if (d.streamId !== streamId) return;
      detachAll();
      duplex.push(null);
      duplex.destroy();
    };
    const cleanupOpenPhase = () => {
      clearTimeout(timer);
      s.off("bridge:tunnel_ready", onReady);
      s.off("bridge:tunnel_error", onError);
    };
    const detachAll = () => {
      s.off("bridge:tunnel_data", onData);
      s.off("bridge:tunnel_close", onClose);
    };

    const duplex = new Duplex({
      write(chunk, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, _enc as BufferEncoding);
        s.emit("bridge:tunnel_data", { streamId, chunk: buf.toString("base64") });
        cb();
      },
      final(cb) {
        s.emit("bridge:tunnel_close", { streamId });
        cb();
      },
      read() { /* data pushed via bridge:tunnel_data */ },
    });

    duplex.on("close", () => { s.emit("bridge:tunnel_close", { streamId }); detachAll(); });
    duplex._destroy = (_err, cb) => { s.emit("bridge:tunnel_close", { streamId }); detachAll(); cb(_err); };

    s.on("bridge:tunnel_ready", onReady);
    s.on("bridge:tunnel_error", onError);
    s.on("bridge:tunnel_data", onData);
    s.on("bridge:tunnel_close", onClose);

    s.emit("bridge:tunnel_open", { streamId, agentId: info.agentId, host: info.host, port: info.port, useTls: info.useTls });
  });
}
