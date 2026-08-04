---
layout: default
title: Theta Agent & Endpoint Management
nav_order: 5
---

# Theta Agent & Endpoint Management

The **Theta Agent** (`theta-agent`) is a unified, 2-way Command & Control (C2) endpoint management daemon written in Go for Linux hosts across your home lab, infrastructure, or data center. It connects outbound via a long-lived WebSocket connection to the central **SSO Manager** (`wss://<sso-host>/api/agent/ws`), enabling real-time host telemetry, automated host discovery, and local-first administrative management.

---

## Core Functionality

### 1. Host Discovery & Inventory
Upon establishing a WebSocket connection, the agent immediately pushes a comprehensive discovery payload:
- **Hostname & Network Interfaces**: Hostname and all non-loopback IPv4 addresses and MACs.
- **Operating System & Kernel**: Linux distribution, platform, and kernel version.
- **Hardware Specs**: CPU model, total RAM (GB), and total root disk capacity (GB).
- **Physical Location**: Location identifier string (e.g. `dc-01-rack-12`) configured in `agent.yml`.

If the agent detects a network IP change, it automatically re-pushes an updated discovery payload to the SSO Manager.

### 2. Real-Time Telemetry Streaming
Every 30 seconds, the agent streams real-time performance metrics:
- **CPU Load**: System-wide CPU utilization percentage.
- **Memory Utilization**: RAM usage percentage and available memory.
- **Disk Utilization**: Root filesystem usage percentage.
- **ZFS Storage Health**: Health status of ZFS pools (e.g., `ONLINE`).
- **NVIDIA GPU Load**: GPU compute utilization percentage (via `nvidia-smi`).

---

## Viewing in the SSO Manager

Agent status and telemetry live on the **Directory** page — there is no separate
Agents page. For each **host** resource that has a connected theta-agent, the
Directory shows a status dot in the row:

| Color | Meaning |
| :--- | :--- |
| **Green** | Connected, healthy (CPU/RAM/disk within limits). |
| **Yellow** | Connected but under high load (CPU > 80% or RAM > 80% or disk > 90%). |
| **Red** | Not connected (no agent, or the agent is offline). |

Opening a host's resource modal reveals a **Metrics** tab with the agent's live
telemetry (CPU/RAM/disk/ZFS/GPU) and discovery info (OS, kernel, IPs, location).
The agent is joined to its host by hostname (`agent.discovery.hostname` ↔ the
resource name), so name the Directory host the same as the machine's hostname.

---

## Local-First Security & Capability Matrix

To protect hosts against unauthorized control, `theta-agent` enforces a **strict, local-first capability matrix** defined in `/etc/theta42/agent.yml`. Central SSO Manager requests are checked against local configuration before execution; permissions cannot be overridden remotely.

| Capability | Config Key | Risk Level | Description & Impact |
| :--- | :--- | :--- | :--- |
| **Telemetry** | `telemetry` | Safe | Streams read-only system metrics (CPU, RAM, Disk, ZFS, GPU). |
| **Configure LDAP** | `configure_ldap` | Moderate | Writes updated SSSD configuration to `/etc/sssd/sssd.conf` & restarts `sssd`. |
| **Service Control** | `service_control` | High | Restarts systemd services listed in an explicit allowlist (e.g., `["nginx", "docker", "sssd"]`). |
| **Reboot** | `reboot` | High | Triggers an immediate system reboot (`systemctl reboot`). |
| **Arbitrary Bash** | `arbitrary_bash` | Critical | Executes raw bash scripts sent from the SSO Manager as `root` (used for automated GitOps). |

---

## High-Risk Command Verification (Protocol v1.1.0)

High-risk management commands (`reboot`, `service_restart`, `configure_ldap`, `arbitrary_bash`, `update_binary`) are cryptographically verified using **Ed25519 signatures**:
1. The SSO Manager canonicalizes the command payload (sorted keys, no whitespace).
2. The payload is signed with the SSO Manager's Ed25519 private key.
3. The Base64 signature is appended to the message payload.
4. The agent verifies the signature against the configured `public_key` in `/etc/theta42/agent.yml` before executing the action.

---

## Installation & Deployment

### Quick One-Liner Install
Run the following command as `root` on the target Linux host:

```bash
curl -fsSL https://<SSO_HOST>/resources/theta-agent/install.sh | sh -s -- --url "https://<SSO_HOST>" --token "<HOST_TOKEN>"
```

### Custom Config Wizard
You can generate a Base64-encoded custom configuration using the **Install Agent** button on the **Directory Management** page in the SSO Manager UI:

```bash
curl -fsSL https://<SSO_HOST>/resources/theta-agent/install.sh | sh -s -- "<BASE64_ENCODED_CONFIG>"
```

---

## Configuration File Example (`/etc/theta42/agent.yml`)

```yaml
# /etc/theta42/agent.yml
server_url: "wss://sso.example.com"
auth_token: "your-unique-host-token"
location: "dc-01-rack-12"
public_key: "MCowBQYDK2VwAyEA..."

capabilities:
  telemetry: true
  configure_ldap: true
  reboot: false
  service_control: ["nginx", "docker", "sssd"]
  arbitrary_bash: false
```

---

## Troubleshooting: agent can't connect (`dial tcp ... i/o timeout`)

If the agent host logs `Dial error: dial tcp <ip>:443: i/o timeout` while
connecting to `wss://<sso-host>/api/agent/ws`, the WebSocket path is usually
fine — this is a **network/NAT** problem, not an agent or SSO bug. A host behind
the same NAT that owns the SSO often cannot reach its own **public IP** (no
hairpin/loopback NAT on many home routers), so the TCP dial times out even
though the same address works from outside.

Fix options:
1. Point `agent.yml` `server_url` at an address the host can reach directly —
   e.g. the SSO host's LAN IP (`http://<lan-ip>` or `http://<lan-ip>:3001` for a
   no-TLS direct path).
2. Enable **NAT reflection / hairpin NAT** on the router so LAN hosts can reach
   their own public IP:443.
3. Add a local route/firewall rule on the agent host for its public IP.

> Note: on a deployment where the theta42 proxy fronts `sso.suite.example`, make
> sure the proxy has a **persistent Host record** for the real SSO domain — not
> just the `localtest.me` placeholder — so routing survives a proxy restart
> (an in-memory lookup cache can mask a missing Redis record for up to ~1h).


