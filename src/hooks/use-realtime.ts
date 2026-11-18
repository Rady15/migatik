"use client";

/**
 * Realtime updates: socket.io primary (via Caddy gateway → :3003), HTTP polling fallback.
 * The UI works identically in both modes; the header chip shows which is active.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket, type ManagerOptions, type SocketOptions } from "socket.io-client";

type IoOptions = Partial<ManagerOptions & SocketOptions>;
import { authFetch } from "@/lib/store";

/**
 * Resolve how to reach the realtime socket.io service (:3003).
 * - Explicit NEXT_PUBLIC_REALTIME_URL wins (custom/production deployments).
 * - Direct dev (app served on :3000, no Caddy gateway) → connect to :3003 on
 *   the same hostname. Otherwise the socket handshake would hit Next.js itself,
 *   get HTML back, fail, and fall back to HTTP polling (constant churn).
 * - Behind the Caddy gateway (any other port) → use the XTransformPort rewrite.
 */
function socketTarget(): { url: string; opts: IoOptions } {
  const opts: IoOptions = { path: "/", reconnectionAttempts: 5, timeout: 4000 };
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (explicit) return { url: explicit, opts: { ...opts, auth: {} } };
  if (typeof window !== "undefined") {
    const port = window.location.port;
    if (port === "3000" || port === "") {
      const proto = window.location.protocol === "https:" ? "https:" : "http:";
      return { url: `${proto}//${window.location.hostname}:3003`, opts: { ...opts, auth: {} } };
    }
  }
  // Caddy gateway rewrites ?XTransformPort=3003 → localhost:3003
  return { url: "/?XTransformPort=3003", opts };
}

export interface RealtimeDevice {
  id: string;
  mac: string;
  ip: string | null;
  hostname: string | null;
  customName: string | null;
  manufacturer: string | null;
  category: string;
  connectionType: string;
  interface: string | null;
  vlan: number | null;
  ap: string | null;
  status: string;
  trustStatus: string;
  sources: string[];
  isNew: boolean;
  firstSeen: string;
  lastSeen: string | null;
  lastActive: string | null;
  router: { name: string };
}

export interface RealtimeStats {
  total: number; online: number; offline: number; idle: number; unknown: number;
  blocked: number; wireless: number; wired: number; hotspot: number; pppoe: number; newDevices: number;
  blockedDevices?: number;
}

export interface TrafficSample {
  id: string; deviceId: string; rxMbps: number; txMbps: number; source: string; ts: string;
}

interface UseRealtimeOptions {
  onDevices?: (devices: RealtimeDevice[]) => void;
  onStats?: (stats: RealtimeStats) => void;
  onSyncStatus?: (jobs: { id: string; routerId: string; status: string; error?: string }[]) => void;
  pollDevicesMs?: number;
  enabled?: boolean;
}

/** Org-scoped realtime: the server filters devices/stats per organization room. */
function getOrgIdForSocket(): string {
  try {
    return localStorage.getItem("mtcm_org_id") || "";
  } catch {
    return "";
  }
}

export function useRealtime(opts: UseRealtimeOptions = {}) {
  const { onDevices, onStats, onSyncStatus, pollDevicesMs = 15000, enabled = true } = opts;
  const [mode, setMode] = useState<"connecting" | "socket" | "polling">("connecting");
  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cbs = useRef(opts);
  useEffect(() => { cbs.current = opts; });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const startPolling = () => {
      if (disposed || pollRef.current) return;
      setMode("polling");
      const poll = async () => {
        try {
          const res = await authFetch("/api/devices?pageSize=1&stats=1");
          if (!res.ok) return;
          const data = await res.json();
          cbs.current.onStats?.(data.kpi);
        } catch { /* keep polling silently */ }
        try {
          const res = await authFetch(`/api/devices?pageSize=100&sort=lastSeen&dir=desc&_=${Date.now()}`);
          if (!res.ok) return;
          const data = await res.json();
          cbs.current.onDevices?.(data.devices ?? []);
        } catch { /* ignore */ }
        try {
          const res = await authFetch("/api/discovery");
          if (!res.ok) return;
          const data = await res.json();
          cbs.current.onSyncStatus?.((data.jobs ?? []).slice(0, 5));
        } catch { /* ignore */ }
      };
      poll();
      pollRef.current = setInterval(poll, pollDevicesMs);
    };

    // try socket.io (direct :3003 in dev, gateway rewrite in production)
    try {
      const target = socketTarget();
      const socket = io(target.url, { ...target.opts, auth: { orgId: getOrgIdForSocket() } });
      socketRef.current = socket;
      fallbackTimer = setTimeout(() => {
        if (!socket.connected) startPolling();
      }, 4500);
      socket.on("connect", () => {
        if (disposed) return;
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setMode("socket");
      });
      socket.on("disconnect", () => {
        if (!disposed) startPolling();
      });
      socket.on("connect_error", () => { /* fallback timer handles it */ });
      socket.on("devices:update", (devices: RealtimeDevice[]) => cbs.current.onDevices?.(devices));
      socket.on("stats:update", (stats: RealtimeStats) => cbs.current.onStats?.(stats));
      socket.on("sync:status", (jobs) => cbs.current.onSyncStatus?.(jobs));
    } catch {
      startPolling();
    }

    return () => {
      disposed = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (pollRef.current) clearInterval(pollRef.current);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [enabled, pollDevicesMs]);

  return { mode };
}

/** Subscribe to per-device live traffic samples (socket room, polling fallback). */
export function useDeviceTraffic(deviceId: string | null) {
  const [samples, setSamples] = useState<TrafficSample[]>([]);
  const [mode, setMode] = useState<"connecting" | "socket" | "polling">("connecting");
  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const merge = useCallback((incoming: TrafficSample[]) => {
    setSamples((prev) => {
      const map = new Map(prev.map((s) => [s.id, s]));
      for (const s of incoming) map.set(s.id, s);
      return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-120);
    });
  }, []);

  useEffect(() => {
    if (!deviceId) {
      const raf = requestAnimationFrame(() => setSamples([]));
      return () => cancelAnimationFrame(raf);
    }
    let disposed = false;

    const loadViaHttp = async () => {
      try {
        const res = await authFetch(`/api/devices/${deviceId}/live?minutes=15`);
        if (!res.ok) return;
        const data = await res.json();
        if (!disposed) {
          merge(data.samples ?? []);
          if (data.samples?.length > 0) setMode((m) => (m === "socket" ? m : "polling"));
        }
      } catch { /* ignore */ }
    };

    try {
      const target = socketTarget();
      const socket = io(target.url, { ...target.opts, auth: { orgId: getOrgIdForSocket() } });
      socketRef.current = socket;
      const fb = setTimeout(() => {
        if (!socket.connected) {
          setMode("polling");
          loadViaHttp();
          pollRef.current = setInterval(loadViaHttp, 5000);
        }
      }, 4500);
      socket.on("connect", () => {
        if (disposed) return;
        socket.emit("subscribe:traffic", deviceId);
        setMode("socket");
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      });
      socket.on("traffic:sample", (data: { deviceId: string; samples: TrafficSample[] }) => {
        if (data.deviceId === deviceId) merge(data.samples);
      });
      socket.on("disconnect", () => {
        if (!disposed) {
          setMode("polling");
          loadViaHttp();
          pollRef.current = setInterval(loadViaHttp, 5000);
        }
      });
      return () => {
        disposed = true;
        clearTimeout(fb);
        socket.emit("unsubscribe:traffic", deviceId);
        socket.disconnect();
        if (pollRef.current) clearInterval(pollRef.current);
      };
    } catch {
      const t = setTimeout(() => {
        setMode("polling");
        loadViaHttp();
        pollRef.current = setInterval(loadViaHttp, 5000);
      }, 0);
      return () => {
        disposed = true;
        clearTimeout(t);
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [deviceId, merge]);

  return { samples, mode };
}
