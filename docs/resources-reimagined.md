# Resources Reimagined

This document outlines the planned redesign of the resource tracking and management system within the Directory (`sso-manager`), aiming to provide a more intuitive, status-driven, and hierarchical single pane of glass.

## Problems to Solve

The current directory aspect of the project needs work in several areas:

*   **Status over Agents:** The "Agent" tab should be replaced with a "Status" tab. This status should be a composite derived from agent data and plugin data.
*   **Subtype Templates Re-evaluation:** The `Preset Subtype Template` feature is currently half-baked.
    *   Templates should actually effect the shape/schema of the settings.
    *   Templates should restrict availability (not every template makes sense at every hierarchy level).
    *   Templates should define what "status" and "fields" are relevant for a specific resource type.
*   **Data Leakage/Misalignment:** Agent data for a given resource is sometimes shown in a different resource (at a different site), caused by loose relations and matching.
*   **View vs. Edit:** Opening a resource should display read-only information by default. Editing should be a distinct action to prevent accidental modifications and improve the viewing experience.
*   **Hierarchical Meaning:**
    *   **Environment** (e.g., prod, dev, testing) should bubble up the tree (e.g. if a child LXC is Prod, its parent host and site are also marked Prod).
    *   **Ownership** (owner, admin, viewer) should propagate *down* the tree.

## Proposed Design Decisions

### 1. Data-Driven Subtypes (Database-Backed)
Subtypes will not be hardcoded since we cannot determine all possible types in advance. They will be data-driven and stored in the database. 
*   The system will come with a bunch of **pre-installed default subtypes** (e.g., `linux`, `windows`, `proxmox`).
*   Admins can add new ones or modify existing ones via the UI.
*   A Subtype Template will define:
    *   The valid parent types (where it can be created in the hierarchy).
    *   The dynamic fields required for that resource (e.g., an IP address, a specific port, credentials).
    *   How the "Status" is calculated based on telemetry/plugin data.

### 2. Environment Bubbling
Environment criticality bubbles up. 
Example: `office (site) -> cluster0 (proxmox) -> dl380 (proxhost) -> gitea (prox-lxc)`
If `gitea` is set to `prod`, then `dl380`, `cluster0`, and `office` also inherit the `prod` status.

### 3. Strict Matching & Permanence
To fix data leakage, we must eliminate loose matching across boundaries.
Currently, `discovery_reconciler.js` attempts to merge incoming agent/plugin data based on a cascade of guesses (MAC -> IP -> Name). This allows a plugin (like Proxmox) to discover a VM with IP `192.168.1.50` and accidentally merge it into an entirely unrelated agent's resource at a different site just because they share a private IP or a generic hostname (like `ubuntu`). 
**Solution:** 
*   **Permanence:** Once an agent or resource successfully binds to a resource ID, that relationship is permanent. 
*   **Strict Boundaries:** Fallback matching (like matching by IP or Hostname) should be extremely strict—for example, never matching across different Sites, and never allowing a weak match to hijack a resource that already has a strong identity (like a verified MAC).

### 4. Abstract Graph Relations (No Special Cases)
Resources should be purely abstract. We must remove hardcoded or special-cased fields like `agentId` from a Host's metadata. 
Instead of a Host "owning" an agent via a field, the `theta-agent` is simply a **Service** (a leaf node Resource with subtype `theta-agent`) that is a child of the Host in the graph. 
*   **Uniformity:** Every relationship is an edge. `Site -> Host -> Service (theta-agent)`.
*   **Routing:** To find out if a Host has an agent, the system simply checks if it has a child resource of subtype `theta-agent`.
*   **Identity:** The agent's connection ties directly to its specific `theta-agent` Service Resource, not the Host.

### 5. View vs Edit UI
The UI will default to a read-only, dashboard-style "Status" and "Properties" view for resources. Editing properties or moving the resource will require clicking into an explicit "Edit" mode.

## Proposed Resource Hierarchy (Examples)

The resource tree will be structured with distinct node types: Sites, Hosts, and Services.

### 1. Site Sub-types (Root Nodes)
*   **Suite:** A full installation of the theta-suite.
*   **Managed:** A site containing a WireGuard (WG) node that has other managed resources, but not a full suite deployed.
*   **WG Node:** A minimal site consisting of just a theta-agent to control WireGuard.
*   **Unmanaged:** A logical container/holder for child resources without active management.

### 2. Host Sub-types
*   `router`, `switch`, `wireless access point`
*   `desktop`, `laptop`
*   `server`
*   `server-proxmox` (Children: `proxmox-lxc`, `proxmox-kvm`)
*   `server-hyperv`, `server-unraid`

### 3. Service Sub-types (Leaf Nodes)
*   `systemd`, `service (windows)`, `process`
*   `ssh`, `http`, `theta-agent`, `wireguard`

## Goals & Use Cases (The "Why")

A resource owner must be empowered to do the following through this system:
*   **Access Management:** Manage who is an owner, admin, or viewer of a resource and all its inherited children.
*   **Status Visibility:** See the status of a resource and its children at a glance (a true single pane of glass).
*   **Active Sessions:** See who is currently logged in and where.
*   **Actionable Routing:** Do port forwarding from one site to a host in the resource directory.
*   **Automated Configuration:** Allow `theta-agent` to pull and apply configurations (similar to an ACME client) from the proxy.

---

## Master TODO List

### Backend & Data Models
- [x] Implement `SubtypeTemplate` DB model (id, slug, name, target_kind, schema, status_rules).
- [x] Create API routes for managing `SubtypeTemplate` (CRUD).
- [x] Refactor `Resource` model to remove `metadata.agentId` and hardcoded `metadata.isProduction`.
- [x] Implement generic Tag/Label bubbling logic (replacing `isProduction`).
- [x] Refactor `Agent` model and logic to bind to a `theta-agent` Service Resource instead of a Host Resource.
- [x] Update `agent_manager.js` and `api_agent.js` enrollment to provision `theta-agent` child services automatically.

### Discovery & Reconciler
- [x] Refactor `discovery_reconciler.js` to enforce strict God Key (UUID) or verified MAC matching.
- [x] Remove loose cross-site IP/Slug fallback matching in Reconciler.
- [x] Update Reconciler to parse generic child services from telemetry instead of hardcoded `systemd`/`docker`.
- [x] Remove `slug_access` and `slug_admin` auto-group creation from Reconciler.

### Access & Advanced Architecture
- [x] Implement Virtual LDAP Groups for SSSD/OpenCredential (synthesize LDAP responses based on inherited tree access).
- [x] Define the `port-forward` Service Subtype and adjust networking logic to query the graph for these leaves.
- [x] Implement Asynchronous State Evaluation background job for mapping telemetry to Status based on `status_rules`.
- [x] Implement Write-Through Proxying for Spokes (spokes forward writes transparently to Master).

### UI
- [x] Replace "Agent" tab with "Status" tab in UI.
- [x] Implement "View vs Edit" mode for resources (default to View).
- [x] Build dynamic form renderer in Edit mode using Subtype `schema`.

### Testing & Docs
- [x] Update e2e and unit tests to pass with the new abstract graph and API changes.
- [x] Update public documentation to reflect the new architecture.
