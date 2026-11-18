#!/usr/bin/env bash
# MikroTik Cloud Manager — agent installer for Ubuntu/Debian (systemd service)
# Usage: sudo AGENT_URL=wss://your-platform AGENT_TOKEN=xxx ./install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo"; exit 1; fi
: "${AGENT_URL:?AGENT_URL required}"
: "${AGENT_TOKEN:?AGENT_TOKEN required}"

# node 18+ via NodeSource if missing
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  echo "installing Node.js 20 (NodeSource)..."
  apt-get update -qq && apt-get install -y -qq curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

INSTALL_DIR=/opt/mtcm-agent
mkdir -p "$INSTALL_DIR"
cp agent.js package.json "$INSTALL_DIR/"
cd "$INSTALL_DIR"
npm install --omit=dev

# dedicated low-privilege user
id -u mtcm-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin mtcm-agent

cat > /etc/mtcm-agent.env <<ENV
AGENT_URL=${AGENT_URL}
AGENT_TOKEN=${AGENT_TOKEN}
AGENT_NAME=${AGENT_NAME:-$(hostname)}
ENV
chmod 600 /etc/mtcm-agent.env

cat > /etc/systemd/system/mtcm-agent.service <<UNIT
[Unit]
Description=MikroTik Cloud Manager Network Agent (outbound-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mtcm-agent
EnvironmentFile=/etc/mtcm-agent.env
ExecStart=/usr/bin/node /opt/mtcm-agent/agent.js
Restart=always
RestartSec=5
# hardening: no inbound capability needed
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now mtcm-agent
echo "installed. status: systemctl status mtcm-agent  ·  logs: journalctl -u mtcm-agent -f"
