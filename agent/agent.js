#!/usr/bin/env node
/**
 * MikroTik Cloud Manager — Remote Network Agent (v3)
 *
 * Lightweight Linux agent deployed INSIDE the customer LAN. It reaches routers
 * that the cloud platform cannot see (behind NAT / private addressing).
 *
 * SECURITY MODEL:
 * - OUTBOUND-ONLY: the agent opens a persistent socket.io connection to the
 *   platform. It listens on NO ports — nothing can connect to it.
 * - Every connection authenticates with a bearer token; the platform stores
 *   only its SHA-256 hash (NetworkAgent.tokenHash).
 * - Traffic can run over TLS (wss://) via the platform HTTPS endpoint.
 * - Automatic reconnection with exponential backoff (1s -> 60s).
 * - Local capability: RouterOS API binary client (login + read/exec commands),
 *   health heartbeat, remote config updates.
 *
 * ENV:
 *   AGENT_URL     wss://platform-host  (or http://host:3003)   [required]
 *   AGENT_TOKEN   token generated in the platform Agents panel   [required]
 *   AGENT_NAME    display name                                   [default: hostname]
 *   ROUTER_HOST / ROUTER_PORT / ROUTER_USER / ROUTER_PASS / ROUTER_TLS
 *                 default router the agent manages (can also be set remotely)
 *   AGENT_TLS_INSECURE=1  accept self-signed platform TLS (lab only)
 *
 * Run: node agent.js   (or: systemd mtcm-agent / docker)
 */

const io = require("socket.io-client");
const net = require("net");
const tls = require("tls");
const http = require("http");
const crypto = require("crypto");
const os = require("os");

const AGENT_URL = process.env.AGENT_URL || "";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const AGENT_VERSION = "1.0.0";

if (!AGENT_URL || !AGENT_TOKEN) {
  console.error("AGENT_URL and AGENT_TOKEN are required (token is generated in the platform -> Agents)");
  process.exit(1);
}

// ---------------- RouterOS API client (minimal, binary protocol) ----------------
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([((len >> 8) & 0x3f) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([((len >> 16) & 0x1f) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([((len >> 24) & 0x0f) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}
function encodeSentence(words) {
  const parts = words.map((w) => { const d = Buffer.from(w, "utf8"); return Buffer.concat([encodeLength(d.length), d]); });
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function readLength(buf, off) {
  const b = buf[off];
  if (b === undefined) return null;
  if ((b & 0x80) === 0) return { len: b, n: 1 };
  if ((b & 0xc0) === 0x80) return buf.length >= off + 2 ? { len: ((b & 0x3f) << 8) | buf[off + 1], n: 2 } : null;
  if ((b & 0xe0) === 0xc0) return buf.length >= off + 3 ? { len: ((b & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], n: 3 } : null;
  if ((b & 0xf0) === 0xe0) return buf.length >= off + 4 ? { len: ((b & 0x0f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3], n: 4 } : null;
  return { len: -1, n: 1 }; // control byte
}

/** Open a RouterOS API session. Returns { ok, error?, conn? } */
function rosConnect(opts, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let socket, buf = Buffer.alloc(0), pending = [], closed = false;
    const fail = (error) => { if (!closed) { closed = true; resolve({ ok: false, error }); try { socket && socket.destroy(); } catch {} } };
    const ok = () => resolve({
      ok: true,
      conn: {
        run(words, cmdTimeout = 12000) {
          return new Promise((res) => {
            const t = setTimeout(() => res([{ type: "!timeout", attrs: {} }]), cmdTimeout);
            pending.push((reply) => { clearTimeout(t); res(reply); });
            socket.write(encodeSentence(words));
          });
        },
        close() { try { socket.write(encodeSentence(["/quit"])); } catch {} try { socket.destroy(); } catch {} },
      },
    });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const words = []; let off = 0, complete = false;
        for (;;) {
          const rl = readLength(buf, off);
          if (!rl) break;
          if (rl.len === 0) { off += rl.n; complete = true; break; }
          if (rl.len < 0) { off += rl.n; continue; }
          if (off + rl.n + rl.len > buf.length) break;
          words.push(buf.subarray(off + rl.n, off + rl.n + rl.len).toString("utf8"));
          off += rl.n + rl.len;
        }
        if (!complete) break;
        buf = buf.subarray(off);
        const reply = [];
        for (const w of words) {
          if (w.startsWith("!")) reply.push({ type: w, attrs: {} });
          else if (reply.length) { const i = w.indexOf("="); if (i === 0) { const rest = w.slice(1); const j = rest.indexOf("="); if (j >= 0) reply[reply.length - 1].attrs[rest.slice(0, j)] = rest.slice(j + 1); } }
        }
        const res = pending.shift();
        if (res) res(reply);
      }
    };
    const onConnect = () => {
      socket.setTimeout(0); // connected — disable inactivity auto-kill
      socket.on("data", onData);
      (async () => {
        const send = (words) => new Promise((res) => { pending.push(res); socket.write(encodeSentence(words)); });
        const r1 = await send(["/login", `=name=${opts.username}`, `=password=${opts.password}`]);
        const done = r1.find((x) => x.type === "!done"), trap = r1.find((x) => x.type === "!trap");
        if (done && !trap) return ok();
        if (trap) return fail(`login failed: ${trap.attrs.message ?? "bad credentials"}`);
        const challenge = done && done.attrs.ret;
        if (challenge) {
          const md5 = crypto.createHash("md5");
          md5.update(Buffer.from([0])); md5.update(Buffer.from(opts.password, "utf8")); md5.update(Buffer.from(challenge, "hex"));
          const r2 = await send(["/login", `=name=${opts.username}`, `=response=00${md5.digest("hex")}`]);
          if (r2.find((x) => x.type === "!done") && !r2.find((x) => x.type === "!trap")) return ok();
          return fail("login failed (challenge): bad credentials");
        }
        fail("unexpected login response");
      })().catch((e) => fail(e.message));
    };
    try {
      if (opts.useTls) {
        socket = tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: false, timeout: timeoutMs }, onConnect);
      } else {
        socket = net.connect({ host: opts.host, port: opts.port, timeout: timeoutMs }, onConnect);
      }
      socket.setTimeout(timeoutMs, () => fail("connect timeout — router unreachable"));
      socket.on("error", (e) => fail(e.message));
      socket.on("close", () => fail("connection closed"));
    } catch (e) { fail(e.message); }
  });
}

// ---------------- agent state ----------------
const state = {
  config: {},
  routers: [],
  busy: 0,
  tunnels: new Map(), // streamId → net/tls socket
  startedAt: Date.now(),
};
const MAX_TUNNELS = 16;

function loadEnvRouters() {
  if (process.env.ROUTER_HOST) {
    state.routers.push({
      name: process.env.ROUTER_NAME || "env-router",
      host: process.env.ROUTER_HOST,
      port: parseInt(process.env.ROUTER_PORT ?? "8728", 10),
      useTls: process.env.ROUTER_TLS === "1",
      username: process.env.ROUTER_USER || "admin",
      password: process.env.ROUTER_PASS || "",
    });
  }
}
loadEnvRouters();

function backoffDelay(attempt) {
  return Math.min(60000, 1000 * Math.pow(2, attempt));
}

/** Execute an api-commands payload on one of the configured routers. */
async function runRouterCommands(payload) {
  const { routerName, commands } = payload;
  const router = state.routers.find((r) => r.name === routerName) || state.routers[0];
  if (!router) return { ok: false, error: "no router configured on this agent" };
  // command validation on the agent side too: never allow destructive system paths
  const FORBIDDEN = /(\/quit|\/system\/reboot|\/system\/shutdown|\/system\/format|\/system\/reset-configuration|\/file\/remove)/i;
  for (const c of commands) {
    if (FORBIDDEN.test(c[0])) return { ok: false, error: `forbidden command: ${c[0]}` };
  }
  const session = await rosConnect(router);
  if (!session.ok) return { ok: false, error: session.error };
  try {
    const results = [];
    for (const words of commands) {
      const reply = await session.conn.run(words, 15000);
      const trap = reply.find((r) => r.type === "!trap" || r.type === "!fatal");
      results.push(trap
        ? { ok: false, error: trap.attrs.message ?? "router error" }
        : { ok: true, rows: reply.filter((r) => r.type === "!re" || (r.type === "!done" && Object.keys(r.attrs).length > 0)).map((r) => r.attrs) });
    }
    return { ok: true, results };
  } finally {
    session.conn.close();
  }
}

/** Health snapshot sent with every heartbeat. */
function health() {
  const m = process.memoryUsage();
  return {
    version: AGENT_VERSION,
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    routers: state.routers.map((r) => ({ name: r.name, host: r.host, port: r.port })),
    memoryMb: Math.round(m.rss / 1024 / 1024),
    busy: state.busy,
    platform: "ok",
  };
}

// ---------------- outbound connection (no listening ports at all) ----------------
let attempt = 0;

// When the platform is served behind a one-port gateway (Caddy preview / single-port
// deployments), socket.io for the realtime service is selected with the
// XTransformPort query param. Connecting DIRECTLY to :3003 ignores the extra param,
// so it is always safe to send it (AGENT_GATEWAY_PORT, set by install.sh).
const GATEWAY_QUERY = process.env.AGENT_GATEWAY_PORT
  ? { XTransformPort: String(process.env.AGENT_GATEWAY_PORT) }
  : {};

function connect() {
  console.log(`[agent] connecting to ${AGENT_URL} (outbound only - no listening ports)`);
  const socket = io(`${AGENT_URL.replace(/\/$/, "")}/agent`, {
    path: "/",
    transports: ["websocket"],
    auth: { agentToken: AGENT_TOKEN, name: AGENT_NAME, version: AGENT_VERSION, capabilities: ["routeros_api", "lan_probe"] },
    query: GATEWAY_QUERY,
    rejectUnauthorized: process.env.AGENT_TLS_INSECURE !== "1",
    reconnection: false, // manual backoff below
    timeout: 10000,
  });

  socket.on("connect", () => {
    attempt = 0;
    console.log(`[agent] connected - authenticated as ${AGENT_NAME}`);
    socket.emit("agent:health", health());
  });

  socket.on("connect_error", (err) => {
    const msg = String((err && err.message) || err);
    console.error(`[agent] connect error: ${msg}`);
    if (/auth/i.test(msg)) {
      console.error("[agent] authentication rejected - check AGENT_TOKEN. Retry in 60s.");
      attempt = Math.max(attempt, 5);
    }
    scheduleReconnect();
  });

  socket.on("disconnect", (reason) => {
    console.warn(`[agent] disconnected: ${reason}`);
    for (const [streamId, ts] of state.tunnels) { try { ts.destroy(); } catch {} state.tunnels.delete(streamId); }
    scheduleReconnect();
  });

  socket.on("agent:config", (cfg) => {
    state.config = cfg || {};
    if (Array.isArray(cfg && cfg.routers)) {
      state.routers = cfg.routers.map((r) => ({
        name: String(r.name || r.host), host: String(r.host),
        port: parseInt(r.port ?? 8728, 10), useTls: !!r.useTls,
        username: String(r.username ?? "admin"), password: String(r.password ?? ""),
      }));
      console.log(`[agent] config update - ${state.routers.length} router(s) configured remotely`);
    }
  });

  socket.on("agent:command", async (cmd) => {
    const { id, type, payload } = cmd || {};
    if (!id) return;
    state.busy++;
    try {
      let result;
      if (type === "ros_commands") result = await runRouterCommands(payload || {});
      else if (type === "health") result = { ok: true, health: health() };
      else if (type === "hotspot_login_test") {
        const r = await hotspotLoginTest(payload || {});
        result = { ok: r.ok, error: r.error, results: { ok: r.ok, verdict: r.verdict, evidence: r.evidence, error: r.error } };
      }
      else result = { ok: false, error: `unknown command type: ${type}` };
      socket.emit("agent:command_result", { id, ...result });
    } catch (e) {
      socket.emit("agent:command_result", { id, ok: false, error: e.message });
    } finally {
      state.busy--;
    }
  });

  // ---------------- TCP tunnel (v4) ----------------
  // Byte-level relay: platform ⇄ agent ⇄ router:8728. Lets the FULL RouterOS
  // binary client (discovery, DHCP, vouchers, subscriber ops) run against
  // routers behind NAT/CGNAT with zero port forwarding.
  socket.on("tunnel:open", (msg) => {
    const { streamId, host, port, useTls } = msg || {};
    if (!streamId || typeof host !== "string" || !Number.isFinite(port)) {
      socket.emit("tunnel:error", { streamId: streamId || "", error: "invalid tunnel request" });
      return;
    }
    if (state.tunnels.size >= MAX_TUNNELS) {
      socket.emit("tunnel:error", { streamId, error: "too many concurrent tunnels on this agent" });
      return;
    }
    try {
      const ts = useTls
        ? tls.connect({ host, port, rejectUnauthorized: false, timeout: 8000 })
        : net.connect({ host, port, timeout: 8000 });
      ts.setTimeout(8000, () => {
        socket.emit("tunnel:error", { streamId, error: `connect timeout — ${host}:${port} unreachable from agent LAN` });
        try { ts.destroy(); } catch {}
        state.tunnels.delete(streamId);
      });
      ts.once("connect", () => {
        ts.setTimeout(0);
        state.tunnels.set(streamId, ts);
        socket.emit("tunnel:ready", { streamId });
      });
      ts.on("data", (chunk) => {
        socket.emit("tunnel:data", { streamId, chunk: chunk.toString("base64") });
      });
      ts.on("error", (e) => {
        socket.emit("tunnel:error", { streamId, error: `router tcp error: ${e.message}` });
        state.tunnels.delete(streamId);
      });
      ts.on("close", () => {
        socket.emit("tunnel:close", { streamId });
        state.tunnels.delete(streamId);
      });
    } catch (e) {
      socket.emit("tunnel:error", { streamId, error: e.message });
    }
  });

  socket.on("tunnel:data", (msg) => {
    const ts = state.tunnels.get(msg?.streamId);
    if (!ts) return;
    try { ts.write(Buffer.from(msg.chunk, "base64")); } catch {}
  });

  socket.on("tunnel:close", (msg) => {
    const ts = state.tunnels.get(msg?.streamId);
    if (ts) { try { ts.destroy(); } catch {} state.tunnels.delete(msg.streamId); }
  });

  const hb = setInterval(() => {
    if (!socket.connected) { clearInterval(hb); return; }
    socket.emit("agent:health", health());
  }, 15000);
}

function scheduleReconnect() {
  attempt++;
  const delay = backoffDelay(attempt);
  console.log(`[agent] reconnecting in ${delay / 1000}s (attempt ${attempt})`);
  setTimeout(connect, delay);
}

/**
 * Real hotspot login test from INSIDE the customer LAN (v4).
 * Performs an actual HTTP-PAP login against the router's hotspot web port and
 * reports the raw HTTP evidence — the platform separately verifies the created
 * active session via the RouterOS API. Never fabricates a success.
 */
function hotspotLoginTest(payload) {
  return new Promise((resolve) => {
    const { host, httpPort = 80, username, password, dst = "http://192.168.88.254/" , timeoutMs = 8000 } = payload;
    if (!host || !username) return resolve({ ok: false, error: "hotspot_login_test: host and username are required" });
    const startedAt = Date.now();
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; resolve(res); } };
    const req = http.request(
      {
        host,
        port: parseInt(httpPort, 10),
        path: `/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password ?? "")}&dst=${encodeURIComponent(dst)}&popup=true`,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => { if (body.length < 64000) body += c.toString("utf8"); });
        res.on("end", () => {
          const location = res.headers.location || "";
          const setCookie = res.headers["set-cookie"] || [];
          const success =
            (res.statusCode >= 300 && res.statusCode < 400 && /status|dst/i.test(location) && !/error|login/i.test(location)) ||
            (res.statusCode === 200 && /logged[- ]in|status: logged/i.test(body) && !/invalid|cannot find|wrong/i.test(body));
          done({
            ok: true,
            evidence: {
              statusCode: res.statusCode,
              location,
              cookieReceived: setCookie.length > 0,
              errorPageSignals: [/invalid/i, /cannot find/i, /wrong/i, /error/i].map((r) => (r.test(body) ? String(r) : null)).filter(Boolean),
              durationMs: Date.now() - startedAt,
            },
            verdict: success ? "login-accepted" : "login-rejected",
          });
        });
      },
    );
    req.on("timeout", () => { req.destroy(); done({ ok: false, error: `hotspot http timeout — ${host}:${httpPort} unreachable from agent LAN` }); });
    req.on("error", (e) => done({ ok: false, error: `hotspot http error: ${e.message}` }));
    req.end();
  });
}

connect();
