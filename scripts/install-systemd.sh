#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "Run via npm run service-install (sudo required)" >&2
  exit 1
}

TARGET_USER=${SUDO_USER:-root}
TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
REPO=$(pwd)
CONFIG=${ENV_LOGGER_CONFIG:-$TARGET_HOME/.config/environment-logger/site.json}
[ -f "$CONFIG" ] || {
  echo "Configuration not found: $CONFIG" >&2
  exit 1
}
NODE=$(command -v node)

cat > /etc/systemd/system/environment-logger.service <<UNIT
[Unit]
Description=Environment logger
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$REPO
Environment=HOME=$TARGET_HOME
Environment=ENV_LOGGER_CONFIG=$CONFIG
ExecStart=$NODE $REPO/src/main.mjs
Restart=on-failure
RestartSec=15
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now environment-logger.service
systemctl --no-pager --full status environment-logger.service || true
