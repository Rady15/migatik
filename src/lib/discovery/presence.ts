/**
 * Device Intelligence Engine — PRESENCE / ONLINE-OFFLINE derivation (pure, unit-testable).
 *
 * Multi-evidence status model (strict — a device is only ONLINE with DIRECT evidence):
 *
 *  1. BLOCKED                → admin block rule active (overrides everything)
 *  2. ONLINE                 → active session evidence NOW: wireless registration,
 *                              hotspot session, or PPP session (fresh within activeFreshMs)
 *  3. RECENTLY_DISCONNECTED  → was ONLINE within the grace window, no active evidence now
 *  4. IDLE                   → reachable at L2/L3 but no active session:
 *                              fresh complete ARP, fresh dynamic bridge host, or fresh
 *                              bound DHCP lease. A DHCP lease alone NEVER establishes ONLINE.
 *  5. OFFLINE                → previously seen, no fresh evidence at all
 *  6. UNKNOWN                → evidence insufficient or only historical records
 *
 * Every status carries its evidence trail so the UI can show WHY.
 */

export interface PresenceInput {
  now: number;
  /** window in which active-session evidence still counts (≈ 2× sync interval) */
  activeFreshMs: number;
  /** window in which L2/L3 evidence (arp/bridge/dhcp) still counts (≈ sync interval + slack) */
  l2l3FreshMs: number;
  /** grace period after losing active evidence (default 5 min) */
  graceMs: number;
}

export interface PreviousDeviceState {
  status: string;             // previous stored status
  lastActive: number | null;  // ts of last active-session evidence
  blocked: boolean;           // block rule active
}

export interface PresenceResult {
  status: "online" | "offline" | "idle" | "unknown" | "blocked" | "recently_disconnected";
  evidence: string[];   // human-readable reasons, exactly reflecting available data
}

export function derivePresence(
  d: {
    wirelessActiveNow: boolean;
    hotspotActiveNow: boolean;
    pppActiveNow: boolean;
    arpCompleteNow: boolean;
    arpInvalidNow: boolean;
    bridgeDynamicNow: boolean;
    dhcpBoundNow: boolean;
    sources: string[];
  },
  prev: PreviousDeviceState | null,
  p: PresenceInput,
): PresenceResult {
  const evidence: string[] = [];

  if (prev?.blocked) {
    return { status: "blocked", evidence: ["block rule active"] };
  }

  // 1. Direct active-session observation
  const activeNow: string[] = [];
  if (d.wirelessActiveNow) activeNow.push("wireless registration");
  if (d.hotspotActiveNow) activeNow.push("hotspot session");
  if (d.pppActiveNow) activeNow.push("PPP/PPPoE session");
  if (activeNow.length > 0) {
    return { status: "online", evidence: [`active: ${activeNow.join(" + ")}`] };
  }

  // 2. Grace window after losing active evidence
  if (prev && (prev.status === "online" || prev.status === "recently_disconnected")) {
    if (prev.lastActive && p.now - prev.lastActive < p.graceMs) {
      return {
        status: "recently_disconnected",
        evidence: [`active evidence lost ${Math.round((p.now - prev.lastActive) / 1000)}s ago (grace window)`],
      };
    }
  }

  // 3. L2/L3 reachable but no active session → idle (never online from these alone)
  const reachable: string[] = [];
  if (d.arpCompleteNow) reachable.push("ARP complete");
  if (d.bridgeDynamicNow) reachable.push("bridge host (dynamic)");
  if (d.dhcpBoundNow) reachable.push("DHCP lease bound (assignment only)");
  if (reachable.length > 0) {
    return { status: "idle", evidence: [`reachable: ${reachable.join(" + ")}`] };
  }

  // 4. Was previously seen, but no fresh evidence anywhere
  const everSeen = prev && prev.lastActive != null
    ? true
    : d.sources.length > 0 && prev != null;
  if (everSeen) {
    return { status: "offline", evidence: ["no fresh evidence in any source"] };
  }

  // 5. Insufficient evidence → honest UNKNOWN
  return { status: "unknown", evidence: d.sources.length === 0 ? ["no discovery evidence"] : ["insufficient evidence"] };
}

/** Time helpers shared with the sync engine. */
export function withinWindow(ts: number | null | undefined, now: number, windowMs: number): boolean {
  return ts != null && now - ts <= windowMs;
}
