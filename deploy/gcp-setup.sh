#!/usr/bin/env bash
# =====================================================================
# Shiftly – one-command install / update on a Google Cloud VM
# (Debian 12, e2-micro "Always Free"). Run from the VM's SSH window:
#
#   curl -fsSL https://raw.githubusercontent.com/avipiron1-art/Avi/main/deploy/gcp-setup.sh | sudo bash
#
# What it does:
#   - adds swap (e2-micro has ~1 GB RAM), installs Node.js 22, Caddy, sqlite3
#   - downloads/updates the app into /opt/shiftly and builds it
#   - keeps the database in /var/lib/shiftly (persistent disk) with daily backups
#   - serves it over HTTPS at https://<ip-with-dashes>.sslip.io (free certificate)
# Running it again updates the app to the latest version; data is kept.
# =====================================================================
set -euo pipefail

REPO="${REPO:-https://github.com/avipiron1-art/Avi.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/shiftly
DATA_DIR=/var/lib/shiftly
BACKUP_DIR=/var/backups/shiftly
ENV_FILE=/etc/shiftly.env

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }

# ---------- swap (needed to build on 1 GB RAM) ----------
if ! swapon --show | grep -q .; then
  say "Adding 2 GB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- packages ----------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git sqlite3 caddy >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# ---------- app user & code ----------
id shiftly >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin shiftly
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  say "Updating the app"
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  say "Downloading the app"
  rm -rf "$APP_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
say "Building (this can take a few minutes)"
npm ci --include=dev --no-audit --no-fund --loglevel=error
npm run build --silent
chown -R shiftly:shiftly "$APP_DIR" "$DATA_DIR"

# ---------- address ----------
IP=$(curl -fs -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || curl -fs https://api.ipify.org)
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"

# ---------- first-run configuration ----------
if [ ! -f "$ENV_FILE" ]; then
  SEED_DEMO=true
  ADMIN_PASSWORD=""
  if [ -r /dev/tty ]; then
    printf '\nStart with demo data (fake employees and shifts for trying the system)? [y/N] '
    read -r ans < /dev/tty || ans=n
    case "$ans" in y|Y|yes) SEED_DEMO=true ;; *) SEED_DEMO=false ;; esac
    if [ "$SEED_DEMO" = false ]; then
      while :; do
        printf 'Choose a password for the "admin" user (8+ chars, a letter and a digit): '
        read -rs ADMIN_PASSWORD < /dev/tty; echo
        [[ ${#ADMIN_PASSWORD} -ge 8 && "$ADMIN_PASSWORD" =~ [A-Za-z] && "$ADMIN_PASSWORD" =~ [0-9] ]] && break
        echo "Password too weak, try again."
      done
    fi
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
DB_FILE=$DATA_DIR/shiftly.db
APP_URL=https://$DOMAIN
DEMO_MODE=false
SEED_DEMO=$SEED_DEMO
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
  umask 022
else
  sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" "$ENV_FILE"
fi

# ---------- service ----------
cat > /etc/systemd/system/shiftly.service <<EOF
[Unit]
Description=Shiftly workforce management
After=network.target

[Service]
User=shiftly
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

# ---------- daily backup (keeps 14 days) ----------
cat > /etc/cron.daily/shiftly-backup <<EOF
#!/bin/sh
[ -f $DATA_DIR/shiftly.db ] || exit 0
sqlite3 $DATA_DIR/shiftly.db ".backup '$BACKUP_DIR/shiftly-\$(date +%F).db'"
find $BACKUP_DIR -name 'shiftly-*.db' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/shiftly-backup

systemctl daemon-reload
systemctl enable -q shiftly caddy
systemctl restart shiftly caddy

say "Waiting for the app to start"
for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:3000/api/health >/dev/null && break
  sleep 2
done
curl -fs http://127.0.0.1:3000/api/health >/dev/null || { echo "The app did not start. Logs: journalctl -u shiftly -n 50"; exit 1; }
# The admin password is only needed to create the first database – don't keep it on disk
sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' "$ENV_FILE"

printf '\n\033[1;32m✅ Shiftly is running:  https://%s\033[0m\n' "$DOMAIN"
if grep -q '^SEED_DEMO=true' "$ENV_FILE"; then
  echo "   Demo logins: admin / Admin1234  ·  michal / Manager1234  ·  yossi / Employee1234"
  echo "   ⚠️  Change these passwords (Settings → Users) before sharing the link."
else
  echo "   Log in with user: admin and the password you chose."
fi
echo "   (The HTTPS certificate may take up to a minute on the first visit.)"
