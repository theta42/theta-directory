---
layout: default
title: Directory Management
description: Managing your Home-Lab infrastructure, services, and LDAP access relationships via the SSO Directory API.
---

# Directory Management

The SSO Manager ships with a built-in **Directory & Inventory Management** feature. Instead of just managing bare LDAP groups for your homelab, the Directory allows you to map out your infrastructure graph and assign rich metadata to your services.

## Architecture

The Directory models your homelab infrastructure using a parent-child graph (e.g. `Site -> Host -> Service`).

There are three primary **Kinds** of resources you can define:
- **Site**: A physical location, datacenter, or root node (e.g., `us-east`). Sites do not require parents.
- **Host**: A physical machine, Proxmox node, virtual machine, or LXC container. A Host **must** have a parent Site or another Host.
- **Service (App)**: An application, web service. A Service **must** have a parent Host or another Service.
- **OAuth Integration**: An OAuth 2.0 / OpenID Connect client application. An OAuth integration **must** have a parent Service.

By defining this hierarchy, the SSO Manager builds a queryable graph of your infrastructure.

## Automatic LDAP Group Creation

When you create a new **Host** or **Service** in the Directory via the web UI (or API), the SSO Manager will automatically provision two LDAP groups in your directory to govern access to that resource:

1. `<slug>_access` (Member level access)
2. `<slug>_admin` (Owner level access)

For example, if you create a Service named "Emby" with the slug `app_emby`, the system will create the LDAP groups `app_emby_access` and `app_emby_admin`. You can then assign users to these groups, and they will immediately see the service populate on their "My Services" dashboard.

## Resource Metadata

Resources carry a flexible `metadata` JSON object that can store essential context for your applications. The UI natively supports the following metadata fields:

### Common Metadata
- **Sub Type**: Free-form text to categorize the resource (e.g., `proxmox_node`, `linux`, `lxc`, `web`).
- **IP Address**: The internal IP address of the resource.
- **MAC Address**: The hardware address of the primary interface.
- **Host / URI Address**: The FQDN or URL of the resource (e.g., `https://emby.home.arpa`).
- **Production Environment**: A boolean toggle indicating if the resource is in production.

### Host Metadata
- **VMID**: The hypervisor VM or Container ID (e.g. `101`).
- **OS**: The operating system name (e.g. `Ubuntu 22.04.3 LTS`).
- **Kernel**: The kernel version string (e.g. `5.15.0-100-generic`).

### Service Metadata
- **Internal Port**: The local port the service binds to (e.g. `8080`).
- **External Port**: The reverse-proxy or external port (defaults to Internal Port if left blank).
- **Public (No Auth)**: Indicates if the service is exposed publicly without authentication.
- **External Reachable**: Indicates if the service is accessible outside the VPN/local network.
- **Git Repo**: The source code repository for the service (e.g. `https://github.com/...`).
- **Install Path**: The filesystem path where the service is installed (e.g. `/opt/app`).
- **Systemd Service**: The systemd unit name for the service (e.g. `app.service`).

## Navigating the UI

The Directory Management interface provides a **Tree View** toggle that visually nests your resources, making it easy to comprehend your network topography at a glance. You can also filter, search, and sort your entire infrastructure inventory. From the tree view, you can click the green `+` icon next to any resource to instantly add a child resource beneath it.
