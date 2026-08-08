#!/bin/sh
set -e

# --- Configuration ---
BINARY_URL="${BINARY_URL:-}"
CONFIG_DIR="/etc/theta42"
CONFIG_FILE="$CONFIG_DIR/agent.yml"
BIN_PATH="/usr/local/bin/theta-agent"
SERVICE_FILE="/etc/systemd/system/theta-agent.service"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

log() { echo "${GREEN}[+]${NC} $1"; }
error() { echo "${RED}[!]${NC} $1"; exit 1; }

# 1. Root check
if [ "$(id -u 2>/dev/null || echo 1)" -ne 0 ]; then
  error "This script must be run as root."
fi

# Install SSSD and PAM integration packages if missing
install_sssd_deps() {
  if ! command -v sssd >/dev/null 2>&1; then
    log "Installing SSSD and PAM integration dependencies..."
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sssd sssd-ldap libnss-sss libpam-sss libsss-sudo libpam-runtime || \
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sssd sssd-ldap libnss-sss libpam-sss || true
      if command -v pam-auth-update >/dev/null 2>&1; then
        pam-auth-update --package --enable mkhomedir sss || pam-auth-update --enable mkhomedir || true
      fi
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y sssd sssd-ldap sssd-tools || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y sssd sssd-ldap sssd-tools || true
    elif command -v pacman >/dev/null 2>&1; then
      pacman -S --noconfirm sssd || true
    elif command -v zypper >/dev/null 2>&1; then
      zypper in -y sssd || true
    fi
  else
    log "SSSD is already installed."
  fi
  mkdir -p /etc/sssd
  chmod 755 /etc/sssd
}

# 2. Argument Parsing
URL=""
TOKEN=""
JOIN_KEY=""
PUBLIC_KEY=""
B64_CONFIG=""
INSTALL_SSSD=0

while [ $# -gt 0 ]; do
  case $1 in
    --url)
      URL="$2"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --public-key)
      PUBLIC_KEY="$2"
      shift 2
      ;;
    --join-key)
      JOIN_KEY="$2"
      shift 2
      ;;
    --install-sssd|--ldap)
      INSTALL_SSSD=1
      shift
      ;;
    *)
      B64_CONFIG="$1"
      shift
      ;;
  esac
done

# Validation: require credentials ONLY if config file does not already exist
if [ ! -f "$CONFIG_FILE" ] && [ -z "$B64_CONFIG" ] && { [ -z "$URL" ] || { [ -z "$TOKEN" ] && [ -z "$JOIN_KEY" ]; }; }; then
  error "Missing required configuration. Provide a base64 encoded config, or --url with either --join-key or --token."
  exit 1
fi

# 3. Resolve binary URL dynamically if not specified
if [ -z "$BINARY_URL" ]; then
  if [ -n "$URL" ]; then
    BINARY_URL="${URL%/}/resources/theta-agent/theta-agent-linux-amd64"
  elif [ -n "$B64_CONFIG" ]; then
    EXTRACTED_URL=$(echo "$B64_CONFIG" | base64 -d 2>/dev/null | grep -E '^\s*server_url:' | awk -F'"' '{print $2}' | tr -d ' ' || true)
    if [ -n "$EXTRACTED_URL" ]; then
      HTTP_URL=$(echo "$EXTRACTED_URL" | sed -e 's/^wss:\/\//https:\/\//' -e 's/^ws:\/\//http:\/\//')
      BINARY_URL="${HTTP_URL%/}/resources/theta-agent/theta-agent-linux-amd64"
    fi
  fi
fi
if [ -z "$BINARY_URL" ]; then
  BINARY_URL="https://sso.example.com/resources/theta-agent/theta-agent-linux-amd64"
fi

log "Downloading binary from $BINARY_URL..."
curl -fsSL "$BINARY_URL" -o "$BIN_PATH.tmp" || error "Failed to download binary."
chmod +x "$BIN_PATH.tmp"
mv -f "$BIN_PATH.tmp" "$BIN_PATH"

# 4. Setup configuration
log "Preparing configuration directory $CONFIG_DIR..."
mkdir -p "$CONFIG_DIR"
chmod 755 "$CONFIG_DIR"

if [ -n "$B64_CONFIG" ]; then
  log "Decoding and writing configuration from base64..."
  echo "$B64_CONFIG" | base64 -d > "$CONFIG_FILE" || error "Failed to decode base64 configuration."
elif [ ! -f "$CONFIG_FILE" ]; then
  log "Generating minimal configuration from arguments..."
  cat <<EOF > "$CONFIG_FILE"
server_url: "$URL"
auth_token: "$TOKEN"
join_key: "$JOIN_KEY"
public_key: "$PUBLIC_KEY"
location: "unknown"
capabilities:
  telemetry: true
  configure_ldap: true
  ldap_tunnel: true
  reboot: false
  service_control: []
  arbitrary_bash: false
EOF
else
  log "Preserving existing configuration at $CONFIG_FILE"
fi
chmod 600 "$CONFIG_FILE"

# 4b. Ensure SSSD dependencies are installed if configure_ldap is enabled
if [ "$INSTALL_SSSD" -eq 1 ] || grep -qE -i 'configure_ldap:[[:space:]]*true' "$CONFIG_FILE" 2>/dev/null; then
  install_sssd_deps
fi

# 5. Setup systemd service
log "Creating systemd service unit..."
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=Theta Agent Unified Endpoint Management
After=network.target

[Service]
Type=simple
ExecStart=$BIN_PATH
Restart=always
RestartSec=5
SyslogIdentifier=theta-agent

[Install]
WantedBy=multi-user.target
EOF

# 6. Start the agent
log "Enabling and starting Theta Agent..."
systemctl daemon-reload
systemctl enable theta-agent
systemctl start theta-agent

log "Theta Agent installation complete!"
log "Verify status with: systemctl status theta-agent"
log "Check logs with: journalctl -u theta-agent -f"
