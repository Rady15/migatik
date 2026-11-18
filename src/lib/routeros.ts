import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { Duplex } from "node:stream";

/**
 * Real MikroTik RouterOS API client (binary protocol over TCP / TLS).
 * Supports RouterOS v6.43+ plain login and legacy challenge login (v6.x).
 * Docs: https://wiki.mikrotik.com/wiki/Manual:API
 *
 * v4: `transport` allows the same binary client to run over the agent TCP
 * tunnel (router behind NAT/CGNAT — reached through the customer-LAN agent's
 * outbound socket instead of a direct dial). The protocol layer is identical;
 * only the byte pipe changes.
 */

export interface TunnelTransport {
  /** Opens the byte pipe; resolves only after the far end confirms. */
  open(): Promise<Duplex>;
  /** Human-readable description used in honest error reporting. */
  describe(): string;
}

export interface RosReplyWord {
  type: string; // "!done" | "!re" | "!trap" | "!fatal"
  attrs: Record<string, string>;
}

interface ConnectOptions {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** When set, the TCP connection is tunneled (e.g. via the LAN agent) instead of dialed directly. */
  transport?: TunnelTransport;
}

const LEN_1 = 0x80;
const LEN_2 = 0xc0;
const LEN_3 = 0xe0;

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) {
    return Buffer.from([((len >> 8) & 0x3f) | LEN_1, len & 0xff]);
  }
  if (len < 0x200000) {
    return Buffer.from([((len >> 16) & 0x1f) | LEN_2, (len >> 8) & 0xff, len & 0xff]);
  }
  if (len < 0x10000000) {
    return Buffer.from([((len >> 24) & 0x0f) | LEN_3, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function encodeWord(word: string): Buffer {
  const data = Buffer.from(word, "utf8");
  return Buffer.concat([encodeLength(data.length), data]);
}

export function encodeSentence(words: string[]): Buffer {
  const parts = words.map(encodeWord);
  parts.push(Buffer.from([0x00])); // end of sentence
  return Buffer.concat(parts);
}

function readLength(buf: Buffer, offset: number): { len: number; byteLen: number } | null {
  if (offset >= buf.length) return null;
  const b = buf[offset];
  if ((b & 0x80) === 0x00) return { len: b, byteLen: 1 };
  if ((b & 0xc0) === LEN_1) {
    if (offset + 1 >= buf.length) return null;
    return { len: ((b & 0x3f) << 8) | buf[offset + 1], byteLen: 2 };
  }
  if ((b & 0xe0) === LEN_2) {
    if (offset + 2 >= buf.length) return null;
    return { len: ((b & 0x1f) << 16) | (buf[offset + 1] << 8) | buf[offset + 2], byteLen: 3 };
  }
  if ((b & 0xf0) === LEN_3) {
    if (offset + 3 >= buf.length) return null;
    return { len: ((b & 0x0f) << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3], byteLen: 4 };
  }
  if (b === 0xf0) {
    if (offset + 4 >= buf.length) return null;
    return {
      len: (buf[offset + 1] << 24) | (buf[offset + 2] << 16) | (buf[offset + 3] << 8) | buf[offset + 4],
      byteLen: 5,
    };
  }
  // control word (0xef..0xff) — skip single byte
  return { len: -1, byteLen: 1 };
}

class RosConnection {
  private socket: net.Socket | tls.TLSSocket | Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingResolvers: ((words: RosReplyWord[]) => void)[] = [];
  /** All sentences accumulated for the command currently in flight.
   *  RouterOS replies with N `!re` rows followed by ONE terminal `!done`. */
  private currentReply: RosReplyWord[] = [];
  private closed = false;
  readonly opts: ConnectOptions;

  constructor(socket: net.Socket | tls.TLSSocket | Duplex, opts: ConnectOptions) {
    this.socket = socket;
    this.opts = opts;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.fail());
    socket.on("close", () => this.fail());
    socket.on("end", () => this.fail());
  }

  private fail() {
    if (this.closed) return;
    this.closed = true;
    this.currentReply = [];
    for (const res of this.pendingResolvers.splice(0)) res([]);
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // try to parse complete sentences
    while (true) {
      const words: string[] = [];
      let offset = 0;
      let complete = false;
      while (true) {
        const rl = readLength(this.buffer, offset);
        if (!rl) break;
        if (rl.len === 0) {
          offset += rl.byteLen;
          complete = true;
          break;
        }
        if (rl.len < 0) {
          offset += rl.byteLen;
          continue;
        }
        if (offset + rl.byteLen + rl.len > this.buffer.length) break;
        words.push(this.buffer.subarray(offset + rl.byteLen, offset + rl.byteLen + rl.len).toString("utf8"));
        offset += rl.byteLen + rl.len;
      }
      if (!complete) break;
      this.buffer = this.buffer.subarray(offset);

      // Parse this single sentence into reply words.
      const sentence: RosReplyWord[] = [];
      for (const w of words) {
        if (w.startsWith("!")) {
          sentence.push({ type: w, attrs: {} });
        } else if (sentence.length > 0) {
          const eq = w.indexOf("=");
          if (eq === 0) {
            const rest = w.slice(1);
            const eq2 = rest.indexOf("=");
            if (eq2 >= 0) {
              sentence[sentence.length - 1].attrs[rest.slice(0, eq2)] = rest.slice(eq2 + 1);
            }
          }
        }
      }

      // Accumulate every sentence of the in-flight command. Resolving on the
      // first !re silently loses all remaining rows (the terminal !done comes
      // last). !trap is also accumulated so callers can see the error message.
      this.currentReply.push(...sentence);

      const terminal = sentence.find((r) => r.type === "!done" || r.type === "!fatal");
      if (terminal) {
        const resolver = this.pendingResolvers.shift();
        const fullReply = this.currentReply;
        this.currentReply = [];
        if (resolver) resolver(fullReply);
      }
    }
  }

  async sendSentence(words: string[], timeoutMs?: number): Promise<RosReplyWord[]> {
    if (this.closed) return [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pendingResolvers.indexOf(resolver);
        if (idx >= 0) this.pendingResolvers.splice(idx, 1);
        resolve([{ type: "!timeout", attrs: {} }]);
      }, timeoutMs ?? this.opts.commandTimeoutMs ?? 10000);
      const resolver = (reply: RosReplyWord[]) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.pendingResolvers.push(resolver);
      this.socket.write(encodeSentence(words));
    });
  }

  close() {
    this.closed = true;
    try {
      this.socket.write(encodeSentence(["/quit"]));
    } catch {}
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {}
  }
}

export interface RosResult {
  ok: boolean;
  error?: string;
  data: Record<string, string>[];
  raw?: string;
}

/** Connect + authenticate to a RouterOS device. */
export async function connectRouterOS(opts: ConnectOptions): Promise<{ ok: boolean; error?: string; conn?: RosConnection }> {
  const connectTimeout = opts.connectTimeoutMs ?? 6000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: { ok: boolean; error?: string; conn?: RosConnection }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "انتهت مهلة الاتصال بالسيرفر (timeout)" }), connectTimeout);

    const onConnect = (socket: net.Socket | tls.TLSSocket | Duplex) => {
      const conn = new RosConnection(socket, opts);
      // RouterOS 6.43+ plain login
      (async () => {
        const reply = await conn.sendSentence(["/login", `=name=${opts.username}`, `=password=${opts.password}`]);
        const done = reply.find((r) => r.type === "!done");
        const trap = reply.find((r) => r.type === "!trap");
        if (done && !trap) {
          finish({ ok: true, conn });
          return;
        }
        if (trap) {
          finish({ ok: false, error: `فشل تسجيل الدخول: ${trap.attrs.message ?? "بيانات غير صحيحة"}` });
          conn.close();
          return;
        }
        if (reply.find((r) => r.type === "!timeout")) {
          finish({ ok: false, error: "انتهت مهلة استجابة السيرفر" });
          conn.close();
          return;
        }
        // Legacy challenge login (RouterOS < 6.43)
        const challenge = done?.attrs.ret;
        if (challenge) {
          const md5 = crypto.createHash("md5");
          md5.update(Buffer.from([0x00]));
          md5.update(Buffer.from(opts.password, "utf8"));
          md5.update(Buffer.from(challenge, "hex"));
          const resp = await conn.sendSentence(["/login", `=name=${opts.username}`, `=response=00${md5.digest("hex")}`]);
          if (resp.find((r) => r.type === "!done") && !resp.find((r) => r.type === "!trap")) {
            finish({ ok: true, conn });
          } else {
            finish({ ok: false, error: "فشل تسجيل الدخول (challenge): بيانات غير صحيحة" });
            conn.close();
          }
          return;
        }
        finish({ ok: false, error: "استجابة غير متوقعة من السيرفر" });
        conn.close();
      })();
    };

    const onError = (err: Error) => {
      const msg =
        err.message.includes("ECONNREFUSED")
          ? "تم رفض الاتصال — تأكد من تفعيل خدمة API على السيرفر ومن المنفذ"
          : err.message.includes("ETIMEDOUT") || err.message.includes("timeout")
            ? "انتهت مهلة الاتصال — السيرفر غير قابل للوصول"
            : err.message.includes("ENOTFOUND") || err.message.includes("EAI_AGAIN")
              ? "تعذر تحويل اسم المضيف (DNS)"
              : err.message.includes("EHOSTUNREACH") || err.message.includes("ENETUNREACH")
                ? "المضيف غير قابل للوصول من الشبكة"
                : `خطأ اتصال: ${err.message}`;
      finish({ ok: false, error: msg });
    };

    try {
      if (opts.transport) {
        // Tunneled transport (agent in the customer LAN). The tunnel "connect"
        // completes when the agent confirms the stream; error wording stays honest.
        opts.transport.open().then(
          (socket) => {
            socket.on("error", onError);
            onConnect(socket);
          },
          (err: Error) => onError(err),
        );
      } else if (opts.useTls) {
        const socket = tls.connect(
          { host: opts.host, port: opts.port, rejectUnauthorized: false, timeout: connectTimeout },
          () => onConnect(socket),
        );
        socket.on("error", onError);
      } else {
        const socket = net.connect({ host: opts.host, port: opts.port, timeout: connectTimeout }, () => onConnect(socket));
        socket.on("error", onError);
      }
    } catch (err) {
      finish({ ok: false, error: `تعذر بدء الاتصال: ${(err as Error).message}` });
    }
  });
}

function mapReply(reply: RosReplyWord[]): RosResult {
  const trap = reply.find((r) => r.type === "!trap" || r.type === "!fatal");
  if (trap) return { ok: false, error: trap.attrs.message ?? "خطأ من السيرفر", data: [] };
  if (reply.find((r) => r.type === "!timeout")) return { ok: false, error: "انتهت مهلة الأمر", data: [] };
  // Only `!re` sentences carry data rows. The terminal `!done` carries none
  // (attributes there, if any, are metadata like `ret`/`count`, never a row).
  const data = reply.filter((r) => r.type === "!re").map((r) => r.attrs);
  return { ok: true, data };
}

/** Execute a single command on an open connection. */
export async function runCommand(conn: RosConnection, command: string[], timeoutMs?: number): Promise<RosResult> {
  const reply = await conn.sendSentence(command, timeoutMs);
  if (reply.length === 0) return { ok: false, error: "انقطع الاتصال بالسيرفر", data: [] };
  return mapReply(reply);
}

/** One-shot helper: connect → run → close. */
export async function withRouter<T>(
  opts: ConnectOptions,
  fn: (conn: RosConnection) => Promise<T>,
): Promise<{ ok: boolean; error?: string; value?: T }> {
  const res = await connectRouterOS(opts);
  if (!res.ok || !res.conn) return { ok: false, error: res.error };
  try {
    const value = await fn(res.conn);
    return { ok: true, value };
  } finally {
    res.conn.close();
  }
}

export type { RosConnection, ConnectOptions };
