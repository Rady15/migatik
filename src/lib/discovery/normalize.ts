/**
 * Normalization helpers for RouterOS discovery data.
 * All correlation logic depends on these being deterministic.
 */

/** Normalize a MAC address to lowercase colon-separated AA:BB:CC:DD:EE:FF. Returns null when invalid. */
export function normalizeMac(raw?: string | null): string | null {
  if (!raw) return null;
  const hex = raw.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  if (hex === "000000000000" || hex === "ffffffffffff") return null;
  return hex.match(/.{2}/g)!.join(":");
}

/** Validate an IPv4 address (RouterOS may also report IPv6 — we keep both but tag). */
export function normalizeIp(raw?: string | null): string | null {
  if (!raw) return null;
  const ip = raw.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    if (parts.every((p) => p >= 0 && p <= 255)) return ip;
    return null;
  }
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return ip; // IPv6 passthrough
  return null;
}

export function ouiPrefixOf(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length >= 6 ? hex.slice(0, 6) : null;
}

/** Parse RouterOS durations like "1w2d3h4m5s", "3h25m", "45s", "1d". Returns seconds. */
export function parseRosDuration(raw?: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "forever" || s === "never") return null;
  let total = 0;
  let matched = false;
  const re = /(\d+)(w|d|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case "w": total += n * 604800; break;
      case "d": total += n * 86400; break;
      case "h": total += n * 3600; break;
      case "m": total += n * 60; break;
      case "s": total += n; break;
    }
  }
  if (!matched && /^\d+$/.test(s)) return parseInt(s, 10); // plain seconds
  return matched ? total : null;
}

/** Parse DHCP lease "expires-after" (duration) → absolute expiry timestamp. */
export function expiryFromDuration(raw?: string | null, now = new Date()): Date | null {
  const sec = parseRosDuration(raw);
  if (sec == null) return null;
  return new Date(now.getTime() + sec * 1000);
}

/** Parse a bit-rate string like "585 Mbps", "1.2 Gbps", "921600" (bps). Returns bits/sec. */
export function parseRateToBps(raw?: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(bps|kbps|mbps|gbps)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  switch (m[2]) {
    case "gbps": return n * 1e9;
    case "mbps": return n * 1e6;
    case "kbps": return n * 1e3;
    default: return n;
  }
}

export function bool(raw?: string | null): boolean {
  if (!raw) return false;
  const s = raw.trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

/** Parse RouterOS RX/TX byte counters (may carry K/M/G suffix e.g. "2M134", "45KiB"). Returns bytes. */
export function parseRosBytes(raw?: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(k|m|g|t)?(i?b)?$/);
  if (!m) {
    const n = parseInt(s, 10);
    return isFinite(n) ? n : null;
  }
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case "t": return n * 1e12;
    case "g": return n * 1e9;
    case "m": return n * 1e6;
    case "k": return n * 1e3;
    default: return n;
  }
}

export const VALID_DEVICE_CATEGORIES = [
  "phone", "computer", "router", "access_point", "switch", "server",
  "printer", "camera", "tv", "iot", "nas", "gaming", "unknown",
] as const;

export const VALID_STATUSES = [
  "online", "offline", "idle", "unknown", "blocked", "recently_disconnected",
] as const;

/** Extract a small integer field from RouterOS "v" values stored as strings. */
export function toInt(raw?: string | null, fallback = 0): number {
  const n = parseInt((raw ?? "").trim(), 10);
  return isFinite(n) ? n : fallback;
}
