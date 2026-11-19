# =============================================================================
#  MikroTik CHR — Tailscale subnet router setup (paste in New Terminal)
#  Generated for MikroTik Cloud Manager.
#
#  This makes the router part of your Tailscale tailnet. The platform (running
#  on Proxmox via Tailscale) can then reach the router's API at 100.x.x.x:8728
#  with NO public IP, NO port-forward, NO domain, NO VPS.
#
#  PREREQUISITE:
#   1. Docker container support on CHR (container package installed)
#   2. A Tailscale auth key from https://login.tailscale.com/admin/settings/keys
#      (tick "Reusable" and "Advertise tags: tag:router" recommended)
# =============================================================================

# --- 1) enable container mode on CHR (one time) ---
/system/device-mode/update container=yes
# After this command the CHR will REBOOT. Wait ~30s and reconnect.

# --- 2) create a virtual interface + bridge for the container ---
/interface/veth/add name=veth-tailscale address=172.20.0.2/24 gateway=172.20.0.1
/interface/bridge/add name=docker-bridge
/ip/address/add address=172.20.0.1/24 interface=docker-bridge
/interface/bridge/port add bridge=docker-bridge interface=veth-tailscale

# --- 3) environment variables (REPLACE the auth key!) ---
/container/envs/add name=ts-env key=TS_AUTHKEY value="tskey-auth-REPLACE-ME"
/container/envs/add name=ts-env key=TS_HOSTNAME value="mikrotik-chr"
/container/envs/add name=ts-env key=TS_ROUTES value="192.168.1.0/24"
/container/envs/add name=ts-env key=TS_EXTRA_ARGS value="--netfilter-mode=off --accept-routes"

# --- 4) mount a volume for Tailscale state ---
/container/mounts/add name=ts-state src=/tailscale-state dst=/var/lib/tailscale

# --- 5) pull and start the Tailscale container ---
# (use a small image; adjust registry/tag if needed)
/container/add remote-image=tailscale/tailscale:latest interface=veth-tailscale envlist=ts-env mounts=ts-state hostname=mikrotik-chr start-on-boot=yes name=tailscale

# --- 6) wait for it to appear in the Tailscale admin console ---
# Approve the subnet route 192.168.1.0/24 in https://login.tailscale.com/admin/machines
# (Machines -> your mikrotik-chr -> Edit route settings -> approve 192.168.1.0/24)

# --- 7) add a route on the router so tailnet traffic goes into the container ---
/ip/route/add dst-address=100.64.0.0/10 gateway=172.20.0.2 comment="mtcm-managed: tailscale"

# --- 8) verify ---
# /container/print  -> status=Running
# /log print follow  -> tailscale: "Connected"
# From the platform, ping the router's tailnet IP (found in admin console).
