#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 VPS for BAHITH (run as root, reviewed first).
# Installs Docker from Docker's apt repository, a firewall allowing only SSH/HTTP/HTTPS,
# unattended security updates, and a non-root `bahith` user that owns the deployment.
set -euo pipefail
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades fail2ban
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
id bahith >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups docker bahith
install -d -m 0750 -o root -g bahith /etc/bahith
dpkg-reconfigure -f noninteractive unattended-upgrades
echo "Ready. Put /etc/bahith/<env>.env (mode 0640, root:bahith), then deploy as user bahith."
