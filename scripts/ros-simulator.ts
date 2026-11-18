/**
 * TEST HARNESS — minimal RouterOS API protocol simulator.
 *
 * ⚠️ NOT a router. This exists ONLY to prove the agent-tunnel plumbing end to
 * end inside the cloud sandbox (which has no MikroTik). It speaks just enough
 * of the RouterOS binary API protocol to answer /login and a few prints.
 * Any claim about REAL router integration must come from running against a
 * physical RouterOS device on-site — never from this simulator.
 */
import net from "node:net";
import http from "node:http";

export interface SimOptions {
  apiPort: number;
  httpPort: number;
  identity?: string;
}

const loggedUsers = new Set<string>();
let activeSessions: Record<string, string>[] = [];

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([((len >> 8) & 0x3f) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([((len >> 16) & 0x1f) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([((len >> 24) & 0x0f) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function sentence(words: string[]): Buffer {
  const parts = words.map((w) => {
    const d = Buffer.from(w, "utf8");
    return Buffer.concat([encodeLength(d.length), d]);
  });
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function startSimulator(opts: SimOptions) {
  const identity = opts.identity ?? "MT-SIM-LAN";

  // --- RouterOS API (binary) ---
  const api = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve(); // serialize sentence processing

    const respond = async (words: string[]) => {
      const cmd = words[0] ?? "";
      const out: Buffer[] = [];
      const pushRe = (attrs: Record<string, string>) => out.push(sentence(["!re", ...Object.entries(attrs).map(([k, v]) => `=${k}=${v}`)]));
      if (cmd === "/login") {
        out.push(sentence(["!done"]));
      } else if (cmd === "/system/resource/print" || cmd === "/system/identity/print") {
        pushRe({
          identity,
          version: "7.14-sim",
          "board-name": "SIM-BOARD",
          uptime: "1d2h3m",
          "cpu-load": "7",
          "free-memory": "104857600",
          "total-memory": "536870912",
        });
        out.push(sentence(["!done"]));
      } else if (cmd.startsWith("/ip/hotspot/active/print")) {
        for (const sess of activeSessions) pushRe(sess);
        out.push(sentence(["!done"]));
      } else if (cmd.startsWith("/ip/dhcp-server/lease/print")) {
        pushRe({ address: "192.168.88.101", "mac-address": "AA:BB:CC:DD:EE:01", host: "sim-host-1", status: "bound" });
        out.push(sentence(["!done"]));
      } else {
        out.push(sentence(["!trap", "=message=simulator: unsupported command (harness only)"]));
        out.push(sentence(["!done"]));
      }
      socket.write(Buffer.concat(out));
    };

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const words: string[] = [];
        let off = 0;
        let complete = false;
        for (;;) {
          if (off >= buf.length) break;
          const b = buf[off];
          let len = 0;
          let n = 0;
          if ((b & 0x80) === 0) { len = b; n = 1; }
          else if ((b & 0xc0) === 0x80) { len = ((b & 0x3f) << 8) | buf[off + 1]; n = 2; }
          else if ((b & 0xe0) === 0xc0) { len = ((b & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2]; n = 3; }
          else { len = ((b & 0x0f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]; n = 4; }
          if (off + n + len > buf.length) break;
          if (len === 0) { off += n; complete = true; break; }
          words.push(buf.subarray(off + n, off + n + len).toString("utf8"));
          off += n + len;
        }
        buf = buf.subarray(off);
        if (complete) {
          const w = words;
          chain = chain.then(() => respond(w));
        }
        if (!complete) break;
      }
    });
  });

  // --- Hotspot web login (HTTP-PAP shape) ---
  const web = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/login") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>hotspot login page (simulator)</body></html>");
      return;
    }
    const username = u.searchParams.get("username") ?? "";
    const password = u.searchParams.get("password") ?? "";
    const ok = username === "testuser1" && password === "testpass1"; // mode: user_pass
    if (ok) {
      activeSessions = activeSessions.filter((s) => s.user !== username);
      activeSessions.push({ user: username, address: "192.168.88.101", uptime: "0s", "bytes-in": "0", "bytes-out": "0" });
      res.writeHead(302, { Location: "/status", "Set-Cookie": "hotspot_session=1; Path=/" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>invalid username or password (simulator)</body></html>");
    }
  });

  api.listen(opts.apiPort, "127.0.0.1");
  web.listen(opts.httpPort, "127.0.0.1");
  return {
    close: () => { api.close(); web.close(); },
    apiPort: opts.apiPort,
    httpPort: opts.httpPort,
    identity,
  };
}
