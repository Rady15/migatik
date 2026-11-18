/**
 * MikroTik Cloud Manager — Realtime push service (socket.io, port 3003).
 *
 * Reads the shared SQLite database (written by the discovery sync engine inside
 * the Next.js process) and pushes:
 *   - devices:update      → changed NetworkDevice rows since last poll
 *   - stats:update        → device KPI counters
 *   - traffic:<deviceId>  → per-device live traffic samples (rooms)
 *   - sync:status         → discovery job completions
 *
 * Frontend connects via io("/?XTransformPort=3003", { path: "/" }) through the
 * Caddy gateway; it falls back to HTTP polling automatically if this service
 * is not reachable.
 */

import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const PORT = 3003;
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// ---- credential decryption (same AES-256-GCM scheme as src/lib/crypto.ts) ----
const CRYPTO_KEY = crypto.createHash("sha256").update(process.env.APP_SECRET || "mikrotik-cloud-manager-fallback-secret").digest();
function decryptSecret(payload: string): string {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", CRYPTO_KEY, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Build the REAL router config for an agent from the Router table (source of
 * truth). The persisted agent.config field stores MASKED passwords ("***") on
 * purpose — after a restart/reconnect the agent would otherwise receive a
 * useless "***" password. Decrypting here, over the agent's own authenticated
 * outbound socket, keeps the reconnect path working without weakening storage.
 */
async function buildAgentConfig(agentId: string): Promise<{ routers?: Array<Record<string, unknown>> } | null> {
  const managed = await (db as any).router.findMany({
    where: { agentId, connectionMethod: "agent" },
    select: { name: true, host: true, apiPort: true, apiSslPort: true, useTls: true, apiUsername: true, apiPasswordEnc: true },
  });
  if (managed.length === 0) {
    const a = await (db as any).networkAgent.findUnique({ where: { id: agentId }, select: { config: true } });
    return a?.config ? JSON.parse(a.config) : null; // fallback: env/config-only agents
  }
  return {
    routers: managed.map((r: any) => ({
      name: r.name,
      host: r.host,
      port: r.useTls ? r.apiSslPort : r.apiPort,
      useTls: !!r.useTls,
      username: r.apiUsername ?? "admin",
      password: r.apiPasswordEnc ? decryptSecret(r.apiPasswordEnc) : "",
    })),
  };
}

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards /?XTransformPort=3003 here
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ---------------- Agents namespace (outbound-only agents, token auth) ----------------
const agentNamespace = io.of("/agent");
const agentSockets = new Map<string, { socketId: string; name: string }>(); // agentId → meta

agentNamespace.use(async (socket, next) => {
  try {
    const token = String((socket.handshake.auth as { agentToken?: string })?.agentToken ?? "");
    console.log(`[realtime] agent auth attempt from ${socket.handshake.address}`);
    if (!token) return next(new Error("auth: missing agent token"));
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const agent = await db.networkAgent.findUnique({ where: { tokenHash }, select: { id: true, name: true } });
    if (!agent) {
      console.log(`[realtime] agent auth failed: invalid token from ${socket.handshake.address}`);
      return next(new Error("auth: invalid agent token"));
    }
    (socket.data as { agentId: string; name: string }) = { agentId: agent.id, name: agent.name };
    next();
  } catch (e) {
    console.log(`[realtime] agent auth error: ${(e as Error).message}`);
    next(new Error("auth failed"));
  }
});

agentNamespace.on("connection", (socket) => {
  const { agentId, name } = socket.data as { agentId: string; name: string };
  agentSockets.set(agentId, { socketId: socket.id, name });
  console.log(`[realtime] agent connected: ${name} (${agentId})`);
  db.networkAgent.update({
    where: { id: agentId },
    data: { status: "online", lastSeenAt: new Date(), remoteIp: socket.handshake.address },
  }).catch(() => {});
  // send current config on connect — rebuilt from the Router table with REAL
  // decrypted credentials (the persisted agent.config only masks passwords)
  buildAgentConfig(agentId).then((cfg) => {
    if (cfg) socket.emit("agent:config", cfg);
  }).catch(() => {});

  socket.on("agent:health", (h: Record<string, unknown>) => {
    db.networkAgent.update({
      where: { id: agentId },
      data: { lastSeenAt: new Date(), status: "online", version: String(h?.version ?? ""), capabilities: JSON.stringify(h?.routers ?? []) },
    }).catch(() => {});
  });

  socket.on("agent:command_result", async (res: { id: string; ok: boolean; error?: string; results?: unknown; health?: unknown }) => {
    if (!res?.id) return;
    await db.agentCommand.update({
      where: { id: res.id },
      data: {
        status: res.ok ? "done" : "failed",
        result: res.ok ? JSON.stringify(res.results ?? res.health ?? {}) : null,
        error: res.error ?? null,
        completedAt: new Date(),
      },
    }).catch(() => {});
  });

  socket.on("disconnect", () => {
    agentSockets.delete(agentId);
    db.networkAgent.update({ where: { id: agentId }, data: { status: "offline" } }).catch(() => {});
    console.log(`[realtime] agent left: ${name}`);
  });
});


// ---------------- Bridge namespace (Next.js ⇄ realtime tunnel relay) ----------------
// Same-host internal channel. Authenticated with a shared secret (BRIDGE_TOKEN);
// never exposed through the gateway. Relays raw TCP tunnel streams between the
// platform's RouterOS client and the agent sockets.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const bridgeNamespace = io.of("/bridge");
// streamId → bridge socket id
const tunnelStreams = new Map<string, string>();
// bridge socket id → Set<streamId>
const bridgeStreams = new Map<string, Set<string>>();
// streamId → agent socket id
const tunnelAgent = new Map<string, string>();

bridgeNamespace.use((socket, next) => {
  const token = String((socket.handshake.auth as { bridgeToken?: string })?.bridgeToken ?? "");
  if (!BRIDGE_TOKEN) return next(new Error("bridge: BRIDGE_TOKEN not configured on realtime service"));
  if (token.length < 16 || token !== BRIDGE_TOKEN) return next(new Error("bridge: invalid token"));
  next();
});

bridgeNamespace.on("connection", (socket) => {
  console.log(`[realtime] bridge connected: ${socket.id}`);
  const owned = new Set<string>();
  bridgeStreams.set(socket.id, owned);

  socket.on("bridge:tunnel_open", (msg: { streamId: string; agentId: string; host: string; port: number; useTls?: boolean }) => {
    if (!msg?.streamId || !msg?.agentId || typeof msg.host !== "string" || !Number.isFinite(msg.port)) {
      socket.emit("bridge:tunnel_error", { streamId: msg?.streamId ?? "", error: "معطيات النفق غير صحيحة" });
      return;
    }
    const meta = agentSockets.get(msg.agentId);
    if (!meta) {
      socket.emit("bridge:tunnel_error", { streamId: msg.streamId, error: "الوكيل غير متصل حاليًا" });
      return;
    }
    if (tunnelStreams.size >= 128) {
      socket.emit("bridge:tunnel_error", { streamId: msg.streamId, error: "تجاوز الحد الأقصى للأنفاق المتزامنة" });
      return;
    }
    tunnelStreams.set(msg.streamId, socket.id);
    tunnelAgent.set(msg.streamId, meta.socketId);
    owned.add(msg.streamId);
    agentNamespace.to(meta.socketId).emit("tunnel:open", { streamId: msg.streamId, host: msg.host, port: msg.port, useTls: !!msg.useTls });
  });

  socket.on("bridge:tunnel_data", (msg: { streamId: string; chunk: string }) => {
    if (tunnelStreams.get(msg?.streamId) !== socket.id) return;
    const agentSocketId = tunnelAgent.get(msg.streamId);
    if (agentSocketId) agentNamespace.to(agentSocketId).emit("tunnel:data", { streamId: msg.streamId, chunk: msg.chunk });
  });

  socket.on("bridge:tunnel_close", (msg: { streamId: string }) => {
    if (tunnelStreams.get(msg?.streamId) !== socket.id) return;
    const agentSocketId = tunnelAgent.get(msg.streamId);
    if (agentSocketId) agentNamespace.to(agentSocketId).emit("tunnel:close", { streamId: msg.streamId });
    tunnelStreams.delete(msg.streamId);
    tunnelAgent.delete(msg.streamId);
    owned.delete(msg.streamId);
  });

  // live router-config push to a connected agent (replaces the broken
  // /agent-config HTTP sidecar — engine.io owns every HTTP request on this port)
  socket.on("bridge:agent_config", (msg: { agentId: string; routers?: unknown }) => {
    if (!msg?.agentId) return;
    const meta = agentSockets.get(msg.agentId);
    if (!meta) return;
    agentNamespace.to(meta.socketId).emit("agent:config", msg.routers ? { routers: msg.routers } : {});
  });

  socket.on("disconnect", () => {
    for (const streamId of owned) {
      const agentSocketId = tunnelAgent.get(streamId);
      if (agentSocketId) agentNamespace.to(agentSocketId).emit("tunnel:close", { streamId });
      tunnelStreams.delete(streamId);
      tunnelAgent.delete(streamId);
    }
    bridgeStreams.delete(socket.id);
    console.log(`[realtime] bridge left: ${socket.id}`);
  });
});

// agent → relay → bridge (tunnel data plane)
for (const ev of ["tunnel:ready", "tunnel:data", "tunnel:error", "tunnel:close"] as const) {
  agentNamespace.on("connection", (agentSocket) => {
    agentSocket.on(ev, (msg: { streamId: string }) => {
      if (!msg?.streamId) return;
      const bridgeSocketId = tunnelStreams.get(msg.streamId);
      if (!bridgeSocketId) return;
      if (ev === "tunnel:close") {
        tunnelStreams.delete(msg.streamId);
        tunnelAgent.delete(msg.streamId);
        const owned = bridgeStreams.get(bridgeSocketId);
        owned?.delete(msg.streamId);
      }
      const clientEv = "bridge:" + ev.replace("tunnel:", "tunnel_"); // tunnel:ready → bridge:tunnel_ready
      bridgeNamespace.to(bridgeSocketId).emit(clientEv, msg);
    });
  });
}

// command dispatcher: queued AgentCommands → connected agents (every 3s)
setInterval(async () => {
  try {
    const queued = await db.agentCommand.findMany({ where: { status: "queued" }, take: 20, include: { agent: { select: { id: true } } } });
    for (const cmd of queued) {
      const meta = agentSockets.get(cmd.agentId);
      if (!meta) {
        // expire commands for agents offline > 10 minutes
        if (Date.now() - cmd.createdAt.getTime() > 10 * 60_000) {
          await db.agentCommand.update({ where: { id: cmd.id }, data: { status: "expired", error: "agent offline" } }).catch(() => {});
        }
        continue;
      }
      agentNamespace.to(meta.socketId).emit("agent:command", { id: cmd.id, type: JSON.parse(cmd.command).type, payload: JSON.parse(cmd.command).payload });
      await db.agentCommand.update({ where: { id: cmd.id }, data: { status: "sent" } }).catch(() => {});
    }
  } catch { /* dispatcher tick */ }
}, 3000);

// HTTP sidecar endpoint: POST /agent-config pushes config to a connected agent.
// MUST only handle exactly /agent-config — engine.io owns every other request
// (both listeners fire for the same event; touching engine URLs crashes it).
httpServer.on("request", (req, res) => {
  if (req.method === "POST" && req.url === "/agent-config") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { agentId, routers } = JSON.parse(body);
        const meta = agentSockets.get(agentId);
        if (!meta) { res.writeHead(404).end("agent not connected"); return; }
        agentNamespace.to(meta.socketId).emit("agent:config", { routers });
        res.writeHead(200).end("ok");
      } catch {
        res.writeHead(400).end("bad json");
      }
    });
  }
  // anything else: do NOT write a response — engine.io handles it
});

let lastDevicePoll = new Date(Date.now() - 5000);
let lastJobPoll = new Date();
let lastStatsEmit = 0;

// ---- org-scoped event emission (v4 multi-tenant) ----
// Each dashboard socket authenticates with { orgId } (org users) and joins room
// `org:<id>`; platform staff sockets (no orgId) join `platform`. Events carry
// only rows belonging to the target room's organization — org users never see
// another organization's devices or counters.
function emitOrgScoped(event: string, rows: Array<Record<string, unknown>>) {
  const byOrg = new Map<string, Array<Record<string, unknown>>>();
  const platformRows: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const org = typeof r.organizationId === "string" ? r.organizationId : "";
    if (org) { const a = byOrg.get(org) ?? []; a.push(r); byOrg.set(org, a); }
    platformRows.push(r);
  }
  for (const [org, list] of byOrg) io.to(`org:${org}`).emit(event, list);
  io.to("platform").emit(event, platformRows);
}

function emitOrgScopedStats(all: Record<string, number>, orgStats: Record<string, Record<string, number>>) {
  for (const [org, stats] of Object.entries(orgStats)) io.to(`org:${org}`).emit("stats:update", stats);
  io.to("platform").emit("stats:update", all);
}

async function pollOnce(): Promise<void> {
  const now = new Date();

  // changed devices
  const changed = await db.networkDevice.findMany({
    where: { updatedAt: { gt: lastDevicePoll } },
    orderBy: { updatedAt: "asc" },
    take: 300,
    include: { router: { select: { name: true } } },
  });
  if (changed.length > 0) {
    lastDevicePoll = now;
    emitOrgScoped("devices:update", changed.map((d) => ({
      id: d.id,
      mac: d.macAddress,
      ip: d.ipAddress,
      hostname: d.hostname,
      customName: d.customName,
      manufacturer: d.manufacturer,
      category: d.deviceCategory,
      connectionType: d.connectionType,
      interface: d.interfaceName,
      vlan: d.vlanId,
      ap: d.accessPoint,
      status: d.status,
      trustStatus: d.trustStatus,
      sources: JSON.parse(d.sources || "[]"),
      isNew: d.isNew,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      lastActive: d.lastActive,
      router: d.router,
      organizationId: d.organizationId,
    })));
  }

  // KPI counts every ~5 s
  if (now.getTime() - lastStatsEmit > 5000) {
    lastStatsEmit = now.getTime();
    const orgRows = await db.networkDevice.groupBy({ by: ["organizationId"], _count: { _all: true } });
    const orgStats: Record<string, Record<string, number>> = {};
    for (const o of orgRows) {
      if (!o.organizationId) continue;
      const [total, online, offline, idle, unknown, blocked, wireless, wired, hotspot, pppoe, newDev] = await Promise.all([
        db.networkDevice.count({ where: { organizationId: o.organizationId } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, status: "online" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, status: "offline" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, status: "idle" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, status: "unknown" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, status: "blocked" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, connectionType: "wireless" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, connectionType: "wired" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, connectionType: "hotspot" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, connectionType: "pppoe" } }),
        db.networkDevice.count({ where: { organizationId: o.organizationId, isNew: true } }),
      ]);
      orgStats[o.organizationId] = { total, online, offline, idle, unknown, blocked, wireless, wired, hotspot, pppoe, newDevices: newDev };
    }
    const [total, online, offline, idle, unknown, blocked, wireless, wired, hotspot, pppoe, newDev] = await Promise.all([
      db.networkDevice.count(),
      db.networkDevice.count({ where: { status: "online" } }),
      db.networkDevice.count({ where: { status: "offline" } }),
      db.networkDevice.count({ where: { status: "idle" } }),
      db.networkDevice.count({ where: { status: "unknown" } }),
      db.networkDevice.count({ where: { status: "blocked" } }),
      db.networkDevice.count({ where: { connectionType: "wireless" } }),
      db.networkDevice.count({ where: { connectionType: "wired" } }),
      db.networkDevice.count({ where: { connectionType: "hotspot" } }),
      db.networkDevice.count({ where: { connectionType: "pppoe" } }),
      db.networkDevice.count({ where: { isNew: true } }),
    ]);
    emitOrgScopedStats({ total, online, offline, idle, unknown, blocked, wireless, wired, hotspot, pppoe, newDevices: newDev }, orgStats);
  }

  // traffic rooms — push latest samples to subscribed clients
  for (const [room, sockets] of io.of("/").adapter.rooms) {
    if (!room.startsWith("traffic:")) continue;
    const deviceId = room.slice("traffic:".length);
    if (sockets.size === 0) continue;
    const samples = await db.deviceTrafficSample.findMany({
      where: { deviceId, ts: { gte: new Date(Date.now() - 15000) } },
      orderBy: { ts: "asc" },
    });
    // room membership is already org-validated at subscribe time
    if (samples.length > 0) io.to(room).emit("traffic:sample", { deviceId, samples });
  }

  // discovery jobs
  const jobs = await db.discoveryJob.findMany({
    where: { finishedAt: { gt: lastJobPoll } },
    orderBy: { finishedAt: "asc" },
    take: 5,
  });
  if (jobs.length > 0) {
    lastJobPoll = now;
    io.emit("sync:status", jobs.map((j) => ({ id: j.id, routerId: j.routerId, status: j.status, stats: j.stats, error: j.error, finishedAt: j.finishedAt })));
  }
}

io.on("connection", (socket) => {
  console.log(`[realtime] client connected: ${socket.id}`);
  const auth = (socket.handshake.auth ?? {}) as { orgId?: string };
  const orgId = typeof auth.orgId === "string" && auth.orgId.length > 0 && auth.orgId.length < 64 ? auth.orgId : "";
  socket.join(orgId ? `org:${orgId}` : "platform");
  socket.on("subscribe:traffic", async (deviceId: string) => {
    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 64) return;
    if (orgId) {
      // org users may only subscribe to their own devices
      const dev = await db.networkDevice.findUnique({ where: { id: deviceId }, select: { organizationId: true } });
      if (!dev || dev.organizationId !== orgId) return;
    }
    socket.join(`traffic:${deviceId}`);
  });
  socket.on("unsubscribe:traffic", (deviceId: string) => {
    if (typeof deviceId === "string") socket.leave(`traffic:${deviceId}`);
  });
  socket.on("ping", (cb?: () => void) => {
    if (typeof cb === "function") cb();
  });
  socket.on("disconnect", () => console.log(`[realtime] client left: ${socket.id}`));
});

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await pollOnce();
  } catch (e) {
    console.error("[realtime] poll error:", (e as Error).message);
  } finally {
    busy = false;
  }
}, 2000);

httpServer.listen(PORT, () => console.log(`[realtime] listening on :${PORT}`));
