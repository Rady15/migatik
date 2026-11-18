import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";

/**
 * GET /api/network?source=<source>&routerId=...
 * Serves locally synced RouterOS tables (never hits the router per page view —
 * each source shows its own last-sync timestamp; use /api/discovery to refresh).
 */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const sp = req.nextUrl.searchParams;
    const source = sp.get("source") ?? "";
    const routerId = sp.get("routerId") && sp.get("routerId") !== "all" ? sp.get("routerId")! : null;
    const search = (sp.get("search") ?? "").trim().toLowerCase();

    const routers = await db.router.findMany({
      where: { isDemo: false },
      select: { id: true, name: true, status: true, lastSyncAt: true, lastSyncOk: true, lastSyncError: true, syncEnabled: true, syncIntervalSec: true, identity: true, isDemo: true },
      orderBy: { createdAt: "asc" },
    });

    const emptyResp = { rows: [], lastSync: null, routers };

    switch (source) {
      case "dhcp_leases": {
        const rows = await db.dhcpLease.findMany({
          where: routerId ? { routerId } : {},
          orderBy: { seenAt: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.address.toLowerCase().includes(search) || r.macAddress.toLowerCase().includes(search) || (r.hostname ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          ip: r.address, mac: r.macAddress, hostname: r.hostname, server: r.serverName,
          status: r.status, dynamic: r.dynamic, blocked: r.blocked, disabled: r.disabled,
          expiresAt: r.expiresAt, lastSeen: r.lastSeen, pool: r.addressPool, clientId: r.clientId,
          comment: r.comment, syncTime: r.seenAt,
        })) });
      }
      case "arp": {
        const rows = await db.arpEntry.findMany({
          where: routerId ? { routerId } : {},
          orderBy: { seenAt: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.address.toLowerCase().includes(search) || (r.macAddress ?? "").toLowerCase().includes(search) || (r.interface ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          ip: r.address, mac: r.macAddress, interface: r.interface,
          dynamic: r.dynamic, state: r.complete ? "complete" : r.invalid ? "invalid" : "incomplete",
          published: r.published, comment: r.comment, syncTime: r.seenAt,
        })) });
      }
      case "bridge_hosts": {
        const rows = await db.bridgeHost.findMany({
          where: routerId ? { routerId } : {},
          orderBy: { seenAt: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.macAddress.toLowerCase().includes(search) || (r.bridge ?? "").toLowerCase().includes(search) || (r.interface ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          mac: r.macAddress, bridge: r.bridge, interface: r.interface, vlan: r.vlanId,
          isLocal: r.isLocal, dynamic: r.dynamic, externalFdb: r.externalFdb, syncTime: r.seenAt,
        })) });
      }
      case "wireless": {
        const rows = await db.wirelessClient.findMany({
          where: routerId ? { routerId } : {},
          orderBy: { seenAt: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.macAddress.toLowerCase().includes(search) || (r.interface ?? "").toLowerCase().includes(search) || (r.ssid ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          mac: r.macAddress, apiPath: r.apiPath, interface: r.interface, radioName: r.radioName,
          ssid: r.ssid, signal: r.signal, txRate: r.txRate, rxRate: r.rxRate,
          uptime: r.uptime, band: r.band, registeredAt: r.registeredAt, syncTime: r.seenAt,
        })) });
      }
      case "wifi": {
        const rows = await db.wirelessClient.findMany({
          where: routerId ? { routerId, apiPath: "wifi" } : { apiPath: "wifi" },
          orderBy: { seenAt: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.macAddress.toLowerCase().includes(search) || (r.interface ?? "").toLowerCase().includes(search) || (r.ssid ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          mac: r.macAddress, apiPath: r.apiPath, interface: r.interface, radioName: r.radioName,
          ssid: r.ssid, signal: r.signal, txRate: r.txRate, rxRate: r.rxRate,
          uptime: r.uptime, band: r.band, registeredAt: r.registeredAt, syncTime: r.seenAt,
        })) });
      }
      case "capsman": {
        const rows = await db.wirelessClient.findMany({
          where: routerId ? { routerId, apiPath: "capsman" } : { apiPath: "capsman" },
          orderBy: { seenAt: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.macAddress.toLowerCase().includes(search) || (r.interface ?? "").toLowerCase().includes(search) || (r.ssid ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          mac: r.macAddress, apiPath: r.apiPath, interface: r.interface, radioName: r.radioName,
          ssid: r.ssid, signal: r.signal, txRate: r.txRate, rxRate: r.rxRate,
          uptime: r.uptime, band: r.band, registeredAt: r.registeredAt, syncTime: r.seenAt,
        })) });
      }
      case "capsman_caps": {
        const rows = await db.networkResource.findMany({
          where: { ...(routerId ? { routerId } : {}), source: "capsman_caps" },
          orderBy: { seenAt: "desc" }, take: 500,
          include: { router: { select: { name: true } } },
        });
        const data = rows.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name,
          key: r.key, data: JSON.parse(r.data || "{}"), syncTime: r.seenAt,
        }));
        const filtered = search
          ? data.filter((r) => JSON.stringify(r.data).toLowerCase().includes(search) || r.key.toLowerCase().includes(search))
          : data;
        return NextResponse.json({ ...emptyResp, rows: filtered });
      }
      case "hotspot_active": {
        // live sessions come from the unified devices + local hotspot session records
        const rows = await db.networkDevice.findMany({
          where: { ...(routerId ? { routerId } : {}), connectionType: "hotspot", status: "online" },
          orderBy: { lastActive: "desc" }, take: 2000,
          include: { router: { select: { name: true } } },
        });
        const sessions = await db.hotspotSession.findMany({ where: { routerId: routerId ?? undefined, status: "active" }, orderBy: { startedAt: "desc" } });
        return NextResponse.json({ ...emptyResp, rows: rows.map((d) => {
          const s = sessions.find((x) => x.mac === d.macAddress || x.ip === d.ipAddress);
          return {
            id: d.id, routerId: d.routerId, router: d.router.name,
            username: s?.username ?? null, ip: d.ipAddress, mac: d.macAddress,
            server: s?.routerId ?? null, startedAt: s?.startedAt ?? d.lastActive,
            durationSec: s?.durationSec ?? null, uploadMb: s?.uploadMb ?? null, downloadMb: s?.downloadMb ?? null,
            status: d.status, syncTime: d.lastSeen,
          };
        }) });
      }
      case "ppp_active": {
        const rows = await db.pppSession.findMany({
          where: routerId ? { routerId } : {},
          orderBy: { seenAt: "desc" }, take: 2000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) => r.username.toLowerCase().includes(search) || (r.address ?? "").includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          username: r.username, service: r.service, callerId: r.callerId, ip: r.address,
          profile: r.profile, uptime: r.uptime, encoding: r.encoding, syncTime: r.seenAt,
        })) });
      }
      case "hotspot_host": {
        const rows = await db.networkDevice.findMany({
          where: { ...(routerId ? { routerId } : {}), connectionType: "hotspot" },
          orderBy: { lastSeen: "desc" }, take: 5000,
          include: { router: { select: { name: true } } },
        });
        const filtered = search ? rows.filter((r) =>
          r.macAddress.toLowerCase().includes(search) || (r.ipAddress ?? "").includes(search) || (r.hostname ?? "").toLowerCase().includes(search)) : rows;
        return NextResponse.json({ ...emptyResp, rows: filtered.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name, rosId: r.rosId,
          ip: r.ipAddress, mac: r.macAddress, hostname: r.hostname, server: r.accessPoint,
          status: r.status, connectionType: r.connectionType, syncTime: r.lastSeen,
        })) });
      }
      case "ppp_secrets": {
        const rows = await db.networkResource.findMany({
          where: { ...(routerId ? { routerId } : {}), source: "ppp_secrets" },
          orderBy: { seenAt: "desc" }, take: 500,
          include: { router: { select: { name: true } } },
        });
        const data = rows.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name,
          key: r.key, data: JSON.parse(r.data || "{}"), syncTime: r.seenAt,
        }));
        const filtered = search
          ? data.filter((r) => JSON.stringify(r.data).toLowerCase().includes(search) || r.key.toLowerCase().includes(search))
          : data;
        return NextResponse.json({ ...emptyResp, rows: filtered });
      }
      case "ppp_profiles": {
        const rows = await db.networkResource.findMany({
          where: { ...(routerId ? { routerId } : {}), source: "ppp_profiles" },
          orderBy: { seenAt: "desc" }, take: 500,
          include: { router: { select: { name: true } } },
        });
        const data = rows.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name,
          key: r.key, data: JSON.parse(r.data || "{}"), syncTime: r.seenAt,
        }));
        const filtered = search
          ? data.filter((r) => JSON.stringify(r.data).toLowerCase().includes(search) || r.key.toLowerCase().includes(search))
          : data;
        return NextResponse.json({ ...emptyResp, rows: filtered });
      }
      // ---- generic NetworkResource sources ----
      case "interfaces":
      case "addresses":
      case "dhcp_servers":
      case "dhcp_networks":
      case "neighbors":
      case "routes":
      case "firewall_connections":
      case "address_lists": {
        const rows = await db.networkResource.findMany({
          where: { ...(routerId ? { routerId } : {}), source },
          orderBy: { seenAt: "desc" }, take: 3000,
          include: { router: { select: { name: true } } },
        });
        const data = rows.map((r) => ({
          id: r.id, routerId: r.routerId, router: r.router.name,
          key: r.key, data: JSON.parse(r.data || "{}"), syncTime: r.seenAt,
        }));
        const filtered = search
          ? data.filter((r) => JSON.stringify(r.data).toLowerCase().includes(search) || r.key.toLowerCase().includes(search))
          : data;
        return NextResponse.json({ ...emptyResp, rows: filtered });
      }
      case "discovery_status": {
        const jobs = await db.discoveryJob.findMany({
          where: routerId ? { routerId } : {},
          orderBy: { startedAt: "desc" }, take: 10,
          include: { router: { select: { name: true } } },
        });
        return NextResponse.json({ ...emptyResp, rows: jobs.map((j) => ({
          id: j.id, router: j.router.name, routerId: j.routerId, type: j.type, trigger: j.trigger,
          status: j.status, sourcesDone: JSON.parse(j.sourcesDone || "[]"), sourcesFailed: JSON.parse(j.sourcesFailed || "[]"),
          stats: JSON.parse(j.stats || "{}"), error: j.error, durationMs: j.durationMs,
          startedAt: j.startedAt, finishedAt: j.finishedAt,
        })) });
      }
      default:
        return badRequest("مصدر بيانات غير معروف — استخدم source=dhcp_leases|arp|bridge_hosts|wireless|hotspot_active|ppp_active|interfaces|addresses|dhcp_servers|dhcp_networks|neighbors|routes|firewall_connections|address_lists|discovery_status");
    }
  } catch (e) {
    return serverError(e);
  }
});
