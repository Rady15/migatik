import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

/**
 * v4 — ONE-COMMAND AGENT BOOTSTRAP (public, credential-bearing endpoint).
 *
 *   curl -fsSL "<PLATFORM_URL>/api/agents/bootstrap?code=mtcm-XXXXXXXX" | bash
 *
 * The code is generated per-agent in the platform (POST /api/agents/enroll-code)
 * and only its SHA-256 is stored. A successful bootstrap call:
 *   1. resolves the agent by enrollCodeHash (plaintext code is never stored),
 *   2. ROTATES the agent bearer token — the new token is embedded in the
 *      returned install script exactly once and its SHA-256 replaces tokenHash,
 *   3. serves a self-contained bash installer with the platform URL, token and
 *      agent name baked in.
 *
 * ?file=agent.js serves the agent source (contains NO secrets — credentials
 * live in env vars) so the installer can download it on the target host.
 *
 * Security: strict per-IP sliding window (10/min), plain-text errors only,
 * no-store caching, token rotation logged in the audit trail.
 */

const BOOTSTRAP_WINDOW_MS = 60_000;
const bootstrapHits = new Map<string, number[]>();

function allowBootstrap(ip: string, limit = 10): boolean {
  const now = Date.now();
  const arr = (bootstrapHits.get(ip) ?? []).filter((t) => now - t < BOOTSTRAP_WINDOW_MS);
  bootstrapHits.set(ip, arr);
  if (arr.length >= limit) return false;
  arr.push(now);
  if (bootstrapHits.size > 5_000) {
    for (const [k, v] of bootstrapHits) if (v.every((t) => now - t >= BOOTSTRAP_WINDOW_MS)) bootstrapHits.delete(k);
  }
  return true;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
}

function platformOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function agentOrigin(req: NextRequest): string {
  // Use PUBLIC_AGENT_URL if set, else derive from platform origin (port 3003 for realtime service)
  const publicUrl = process.env.PUBLIC_AGENT_URL?.trim();
  if (publicUrl) return publicUrl;
  const origin = platformOrigin(req);
  const url = new URL(origin);
  url.port = "3003";
  return url.toString().replace(/\/$/, "");
}

function plain(status: number, message: string) {
  return new NextResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

const CODE_RE = /^mtcm-[A-Za-z0-9]{20,64}$/;

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  if (!allowBootstrap(ip)) return plain(429, "too many requests — try again in a minute");

  const sp = req.nextUrl.searchParams;
  const file = sp.get("file");

  // ---- agent.js source distribution (no secrets inside) ----
  if (file === "agent.js") {
    // prefer the zero-dependency bundle (socket.io-client inlined) so the
    // installer never needs npm on the target host
    const bundledPath = path.join(process.cwd(), "agent", "agent.bundle.js");
    const plainPath = path.join(process.cwd(), "agent", "agent.js");
    let src: string;
    try {
      src = fs.existsSync(bundledPath) && fs.statSync(bundledPath).size > 1000
        ? fs.readFileSync(bundledPath, "utf8")
        : fs.readFileSync(plainPath, "utf8");
    } catch {
      return plain(500, "agent source not available on this deployment");
    }
    return new NextResponse(src, {
      status: 200,
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // ---- install script via enrollment code ----
  const code = (sp.get("code") ?? "").trim();
  if (!code) return plain(400, "usage: /api/agents/bootstrap?code=mtcm-XXXXXXXX | bash");
  if (!CODE_RE.test(code)) return plain(404, "invalid enrollment code");

  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const agent = await (db as any).networkAgent.findUnique({ where: { enrollCodeHash: codeHash } });
  if (!agent) {
    await db.activityLog.create({ data: { actor: "bootstrap", action: "agent:bootstrap_rejected", target: code.slice(0, 10) + "…", details: `ip=${ip}` } }).catch(() => {});
    return plain(404, "invalid enrollment code");
  }

  // rotate the bearer token — new plaintext lives ONLY in the returned script
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await (db as any).networkAgent.update({
    where: { id: agent.id },
    data: { tokenHash, status: "offline", lastSeenAt: null },
  });
  await db.activityLog.create({
    data: { actor: "bootstrap", action: "agent:bootstrap_issued", target: agent.name, details: `ip=${ip} token rotated` },
  }).catch(() => {});

  const origin = platformOrigin(req);
  const agentUrl = agentOrigin(req);
  const safeName = String(agent.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "agent";
  const script = renderInstaller({ origin, agentUrl, token, agentName: safeName, agentId: agent.id });
  return new NextResponse(script, {
    status: 200,
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function renderInstaller(o: { origin: string; agentUrl: string; token: string; agentName: string; agentId: string }): string {
  return `#!/usr/bin/env bash
# ============================================================================
#  MikroTik Cloud Manager — Network Agent one-command installer
#  Agent: ${o.agentName} (${o.agentId})
#
#  ▶ شغّل هذا الأمر داخل طرفية Linux (سيرفر/VPS داخل شبكة الراوتر) —
#    لا يعمل داخل طرفية MikroTik/RouterOS نفسها وليس هذا مطلوباً أبداً.
#
#  What it does: downloads the agent, installs Node.js if missing, registers
#  a systemd service (mtcm-agent) with automatic restart, and connects the
#  agent OUTBOUND to the platform — no listening ports, works behind NAT/CGNAT.
# ============================================================================
set -euo pipefail

MTCM_PLATFORM_URL="${o.origin}"
MTCM_AGENT_URL="${o.agentUrl}"
MTCM_AGENT_TOKEN="${o.token}"
MTCM_AGENT_NAME="${o.agentName}"
MTCM_AGENT_ID="${o.agentId}"
MTCM_DIR="\${MTCM_DIR:-/etc/mtcm-agent}"

say() { printf '\\033[1;36m[mtcm-agent]\\033[0m %s\\n' "$*"; }
die() { printf '\\033[1;31m[mtcm-agent] خطأ / ERROR:\\033[0m %s\\n' "$*" >&2; exit 1; }

# --- environment guards ------------------------------------------------------
command -v bash >/dev/null 2>&1 || die "bash غير متوفر — شغّل الأمر في طرفية Linux حقيقية (ليس طرفية MikroTik)"
if command -v curl >/dev/null 2>&1; then FETCH="curl -fsSL"; elif command -v wget >/dev/null 2>&1; then FETCH="wget -qO-"; else die "curl أو wget مطلوب"; fi

# --- Node.js >= 18 -----------------------------------------------------------
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] 2>/dev/null; }
if node_ok; then
  say "Node.js $(node -v) موجود"
else
  say "Node.js >= 18 غير موجود — جارِ التثبيت…"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y nodejs npm ca-certificates || {
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; }
  elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then yum install -y nodejs npm
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs npm
  elif command -v zypper >/dev/null 2>&1; then zypper install -y nodejs20
  fi
  node_ok || die "فشل تثبيت Node.js — ثبّته يدوياً (>=18) ثم أعد تشغيل الأمر"
  say "Node.js $(node -v) تم تثبيته"
fi

# --- privileges ---------------------------------------------------------------
# The agent is outbound-only: it needs NO root. systemd registration is a bonus
# when root is available; otherwise it runs unprivileged in the user's home.
PRIV=""
if [ "$(id -u)" = "0" ]; then
  PRIV=""
elif sudo -n true >/dev/null 2>&1; then
  PRIV="sudo -n"
elif [ -z "\${MTCM_DIR:-}" ]; then
  MTCM_DIR="$HOME/.mtcm-agent"
fi

# --- download agent ----------------------------------------------------------
\$PRIV mkdir -p "$MTCM_DIR"
say "تنزيل الوكيل من \$MTCM_PLATFORM_URL …"
\$FETCH "\$MTCM_PLATFORM_URL/api/agents/bootstrap?file=agent.js" | \$PRIV tee "\$MTCM_DIR/agent.js" >/dev/null
[ -s "\$MTCM_DIR/agent.js" ] || die "فشل تنزيل agent.js — تحقق من الوصول للمنصة"

# --- credentials file (600) ---------------------------------------------------
\$PRIV tee "\$MTCM_DIR/agent.env" >/dev/null <<ENV
AGENT_URL=\$MTCM_AGENT_URL
AGENT_TOKEN=\$MTCM_AGENT_TOKEN
AGENT_NAME=\$MTCM_AGENT_NAME
ENV
\$PRIV chmod 600 "\$MTCM_DIR/agent.env"

# --- service ------------------------------------------------------------------
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  say "تسجيل خدمة systemd (mtcm-agent)…"
  tee /etc/systemd/system/mtcm-agent.service >/dev/null <<UNIT
[Unit]
Description=MikroTik Cloud Manager Network Agent (outbound-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$MTCM_DIR/agent.env
ExecStart=/usr/bin/env node $MTCM_DIR/agent.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=$MTCM_DIR/agent.js $MTCM_DIR/agent.env

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now mtcm-agent
  sleep 2
  if systemctl is-active --quiet mtcm-agent; then
    say "✓ الخدمة تعمل — راجع السجل: journalctl -u mtcm-agent -f"
    say "✓ الوكيل سيظهر online في لوحة المنصة خلال ثوانٍ"
  else
    journalctl -u mtcm-agent -n 20 --no-pager || true
    die "الخدمة لم تشتغل — راجع السجل أعلاه"
  fi
else
  say "بدون systemd — تشغيل مباشر في الخلفية…"
  set -a; . "$MTCM_DIR/agent.env"; set +a
  pkill -f "node .*mtcm-agent/agent.js" 2>/dev/null || true
  nohup node "$MTCM_DIR/agent.js" >> "$MTCM_DIR/agent.log" 2>&1 &
  echo $! > "$MTCM_DIR/agent.pid"
  sleep 2
  if kill -0 "$(cat $MTCM_DIR/agent.pid)" 2>/dev/null; then
    say "✓ الوكيل يعمل (PID $(cat $MTCM_DIR/agent.pid)) — السجل: $MTCM_DIR/agent.log"
    say "✓ الوكيل سيظهر online في لوحة المنصة خلال ثوانٍ"
  else
    tail -n 20 "$MTCM_DIR/agent.log" || true
    die "الوكيل لم يبدأ — راجع السجل أعلاه"
  fi
fi

say "الوكيل: $MTCM_AGENT_NAME — المنصة: $MTCM_PLATFORM_URL"
`;
}
