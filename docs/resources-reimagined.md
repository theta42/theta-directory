# Resources Reimagined

The redesign of resource tracking in the Directory (`sso-manager`): a
status-driven, hierarchical single pane of glass, with resources modelled as an
abstract graph rather than a pile of special-cased fields.

This document was written as a plan and is kept as the as-built record. The
design decisions below describe what the system does now; the TODO list is
history; the gaps at the end are what is genuinely still open.

Reference documentation for the two mechanisms this introduced lives in
[`subtype-templates.md`](subtype-templates.md) and
[`status-rules.md`](status-rules.md).

## The problems this solved

*   **Status over Agents.** The "Agent" tab was really an agent-telemetry
    dump. A resource's health is a composite of agent telemetry *and* plugin
    state, and belongs on every resource, not just ones with an agent.
*   **Half-baked subtype templates.** A `Preset Subtype Template` named a
    resource and nothing else. It did not shape the settings, did not restrict
    where a subtype could be used, and had no say in what "healthy" meant.
*   **Data leakage.** Agent and plugin data for one resource surfaced on a
    different resource at a *different site*, because matching fell back
    through a cascade of guesses (MAC → IP → name) with no boundary.
*   **View vs. Edit.** Opening a resource dropped straight into an editable
    form, so reading a resource and accidentally changing it were the same
    gesture.
*   **Hierarchical meaning.** Environment (prod/testing/dev) needed to bubble
    *up* the tree; ownership needed to propagate *down*.

## Design decisions (as built)

### 1. Data-driven subtypes (database-backed)

Subtypes are rows in `subtypetemplate`, not constants — there is no way to know
in advance what people will put in their directory. A handful of defaults are
seeded at boot and admins can add or edit others through the API/UI.

A template defines:

*   `target_kind` and `valid_parent_types` — what kind of node this is and
    where in the hierarchy it may go.
*   `schema` — the dynamic fields for that resource, which drive both the Edit
    form and validation.
*   `status_rules` — how status is computed from telemetry and plugin data.

Validation follows **JSON Schema semantics**: declared properties are
type-checked, `required` is enforced, and undeclared keys are *allowed* unless a
template opts into `additionalProperties: false`. This matters more than it
sounds: discovery plugins legitimately write whatever a device reported (`node`
from Proxmox, `powerState` and `biosVersion` from iLO, `composeProject` from
Docker), so a template that rejected everything it had not declared would make
every discovered resource impossible to save. A short set of platform-owned keys
(`subType`, `managed`, `discovery_sources`, `status`, …) is always allowed,
because they are not the template's to declare.

### 2. Environment bubbling — and environment is operator-owned

Environment criticality bubbles **up**. Given
`office (site) → cluster0 (proxmox) → dl380 (proxhost) → gitea (prox-lxc)`,
setting `gitea` to `prod` makes `dl380`, `cluster0` and `office` report `prod`
too. The bubbled value is exposed as `metadata.bubbled_environment`, and it is
the same string everywhere it appears — the graph API, the directory tree, and
the `bubbled_environment` root in a status rule.

**No discovery plugin writes `metadata.environment`.** This is the one design
point that had to be corrected during implementation. Plugins had been deriving
it from run state (`PowerState === 'On' ? 'prod' : 'dev'`,
`vm.status === 'running' ? …`), which is wrong twice over: a powered-off
production database is still production, and because environment bubbles up, a
single VM being stopped re-labelled its host, its cluster and its entire site.
Plugins now report `powerState` — the fact they actually observed — and
environment stays a classification a human makes.

### 2b. Ownership propagation (down)

The mirror of environment bubbling, and the other half of "Hierarchical
Meaning". A grant on a resource reaches every descendant of it: granting someone
`office` grants them `cluster0`, `dl380` and `gitea`, at the strongest level any
ancestor confers.

Grants are **additive** — a weaker row on a child does not reduce what an
ancestor gave, and there is no deny. That is deliberate: a deny mechanism that
only looks like it works is worse than none, because an operator who
"restricted" a host by adding a viewer row would believe they had removed an
admin they still hold through the site. To reduce access you remove the ancestor
grant. Full rules in [`access-inheritance.md`](access-inheritance.md).

### 3. Strict matching and permanence

Loose matching across boundaries is gone.

*   **Permanence.** A UUID or verified MAC is a strong identity. Once a
    resource has one, a weak match can never hijack it.
*   **Strict boundaries.** IP and hostname fallback matching only ever happens
    *within the same site*, resolved by walking parent edges up to the nearest
    site. With no location configured, discovery uses this directory's own site
    (`isCurrentSite`) and refuses to guess when several sites exist — rather
    than taking `sites[0]`, which on a master holding every spoke's row is
    whichever site happens to sort first.
*   **Edge provenance.** `ResourceEdge.source` records which discovery source
    created an edge. It is what lets a source reparent a guest that moved
    between hypervisors and prune only the edges it owns, and it is why a
    hand-made edge (`POST /edges`, source always null) is never deleted by a
    plugin run. Manual edges are validated for self-edges and cycles the same
    way the reconciler validates its own.

### 4. Abstract graph relations (no special cases)

Resources are abstract. `metadata.agentId` is gone. The `theta-agent` is simply
a **Service** — a leaf resource with subtype `theta-agent` — that is a child of
the Host in the graph.

*   **Uniformity.** Every relationship is an edge: `Site → Host → Service`.
*   **Routing.** "Does this host have an agent?" is answered by looking for a
    child resource of subtype `theta-agent`.
*   **Identity.** `Agent.resourceId` points at that service, never at the host.

Both directions of that walk live in one place, `utils/agent_binding.js`. They
had been open-coded in five call sites, which is how the two directions drifted
apart in the first place.

`theta-agent` is in `AGENT_SERVICE_SUBTYPES`, so it inherits access from its
host rather than minting its own LDAP group pair. Without that, a fleet of N
machines produces 2N groups nobody ever grants.

### 5. View vs Edit UI

The resource modal opens on a read-only dashboard: identity, placement in the
graph, network, platform, the template's own declared fields, access (direct and
inherited), and discovery provenance — rendered from the resource, with no form
controls at all. Switching to Edit swaps in the form and reveals Save. A new
resource opens straight in Edit, since there is nothing yet to view.

This replaced a version that only *looked* like it did this. The old View mode
hid the Save button and called `.prop('disabled')` on `#edit-resource-form
input, ...` — and no element with that id existed anywhere in the DOM, so every
field stayed fully editable in "View".

### 6. Which site an agent belongs to

A self-enrolling agent tells the directory where it is, resolved in order:

1.  `location` in `agent.yml` — an operator said so; nothing overrides it.
2.  **mDNS**: the `site` TXT field of a local `_theta-suite._tcp` announcement
    that fronts the very host this agent is already configured to talk to.
3.  Nothing, and the directory files the host under its own current site.

The mDNS hint is a **label, not a credential**. It decides which site row a host
is filed under; the join key and TLS decide whether the agent is let in at all.
That asymmetry is what makes reading it off unauthenticated multicast
acceptable, and it is why the "roaming agent switches directories" case is
deliberately *not* built.

## Resource hierarchy

Sites, Hosts, and Services. Every subtype below is seeded at boot, with its
placement rules, capability flags, form schema and status rules. See
[`subtype-templates.md`](subtype-templates.md) for the full list including the
subtypes discovery emits (`unknown`, `template`, the UniFi and BMC variants).

### 1. Site sub-types (root nodes)
*   **Suite:** A full installation of the theta-suite.
*   **Managed:** A site with a WireGuard node and managed resources, but no full suite.
*   **WG Node:** A minimal site — just a theta-agent controlling WireGuard.
*   **Unmanaged:** A logical container for child resources, without active management.

### 2. Host sub-types
*   `router`, `switch`, `wireless access point`
*   `desktop`, `laptop`
*   `server`
*   `server-proxmox` (children: `proxmox-lxc`, `proxmox-kvm`)
*   `server-hyperv`, `server-unraid`

### 3. Service sub-types (leaf nodes)
*   `systemd`, `service (windows)`, `process`
*   `ssh`, `http`, `theta-agent`, `wireguard`, `port-forward`

## Goals & use cases (the "why")

A resource owner must be empowered to:
*   **Access management:** manage owner/admin/viewer for a resource and its inherited children.
*   **Status visibility:** see the status of a resource and its children at a glance.
*   **Active sessions:** see who is logged in, and where.
*   **Actionable routing:** port forward from one site to a host in the directory.
*   **Automated configuration:** let `theta-agent` pull and apply configuration
    from the proxy, ACME-client style.

---

## Master TODO list

### Backend & data models
- [x] Implement `SubtypeTemplate` DB model (id, slug, name, target_kind, valid_parent_types, schema, status_rules).
- [x] Create API routes for managing `SubtypeTemplate` (CRUD).
- [x] Refactor `Resource` model to remove `metadata.agentId` and hardcoded `metadata.isProduction`.
- [x] Implement generic Tag/Label bubbling logic (replacing `isProduction`).
- [x] Refactor `Agent` model and logic to bind to a `theta-agent` Service Resource instead of a Host Resource.
- [x] Update `agent_manager.js` and `api_agent.js` enrollment to provision `theta-agent` child services automatically.

### Discovery & reconciler
- [x] Refactor `discovery_reconciler.js` to enforce strict God Key (UUID) or verified MAC matching.
- [x] Remove loose cross-site IP/Slug fallback matching in Reconciler.
- [x] Update Reconciler to parse generic child services from telemetry instead of hardcoded `systemd`/`docker`.
- [x] Remove `slug_access` and `slug_admin` auto-group creation from Reconciler.

### Access & advanced architecture
- [x] Implement Virtual LDAP Groups for SSSD/OpenCredential (`utils/virtual_groups.js`, wired into `routes/api_ldap.js`).
- [x] Define the `port-forward` Service Subtype; `GET /api/discovery/port-forwards` answers the firewall consumer from the graph.
- [x] Implement Asynchronous State Evaluation background job for mapping telemetry to Status based on `status_rules`.
- [x] Implement Write-Through Proxying for Spokes (spokes forward writes transparently to Master).

### UI
- [x] Replace "Agent" tab with "Status" tab.
- [x] Implement "View vs Edit" mode for resources (default to View).
- [x] Build dynamic form renderer in Edit mode using Subtype `schema`.

### Discovery plugins
- [x] Close the `kind` vocabulary to site/host/service; move `bmc`, `network_device`, `container`, `template` and `oauth` to subtypes.
- [x] Move the BMC merge guard from a fake `kind` to `identity_class` on the subtype.
- [x] Make `groupKind()` consult `templateFor().ownGroups`, so one rule decides which resources get their own groups.
- [x] Unify the two group-naming schemes: `/promote` now uses `services/resource_groups.js` like everything else.
- [x] Classify UniFi devices; stop importing every DHCP client by default; honour the controller's site; emit `sourceId`.
- [x] Bound every plugin run with a timeout, and move maintenance jobs to their own queue.
- [x] Validate discovery payloads before they reach the reconciler; drop bad rows rather than whole runs.
- [x] Isolate per-node failures in the Proxmox plugin.
- [x] Make the Docker ignore list configurable.
- [x] Make garbage collection real: archive, then purge with dependents, and honour `archived` in the projection and UI.
- [x] Clean up a discovery source's resources and edges when its plugin instance is deleted.
- [x] Make the self-service access-request guard ask the real access model.
- [x] Document the plugin contract (`docs/discovery-plugins.md`).

### Making it actually work in a browser
- [x] Fix the nested script tag that killed every function on the directory page.
- [x] Serve graph-decorated resources to the tree, so bubbled environment/status reach the one screen they are for.
- [x] Roll status up the tree, so a collapsed view still tells the truth, and show a rolled-up dot as hollow.
- [x] Show inherited environment distinctly from a resource's own.
- [x] Make View mode disable the other tabs, not just the General one.
- [x] Fix the audit footer reading second-precision timestamps as milliseconds ("created 1970-01-21").
- [x] Add `tests/view_integrity.test.js` — script balance, inline-script parsing, and handler definedness.

### Closing the gaps
- [x] Seed the full subtype vocabulary (sites, hosts, guests, appliances, services) with placement rules, schemas and status rules.
- [x] Move `ssh_capable` / `inherits_host_access` off hardcoded Sets and onto the templates, read through a cache that fails closed.
- [x] Enforce parent SUBTYPE, not just parent kind, so a guest cannot be hung off a laptop.
- [x] Drive the resource modal's subtype picker from the templates, filtered by kind and parent.
- [x] Implement ownership propagation DOWN the tree, and surface direct vs inherited grants in the API and UI.
- [x] Build a real read-only dashboard for View mode (the old one disabled nothing).
- [x] Make the `nmap` plugin classify what it finds, and fail closed to a non-ssh-capable `unknown`.

### Testing & docs
- [x] Update e2e and unit tests to pass with the new abstract graph and API changes.
- [x] Document the `SubtypeTemplate` schema format and the `status_rules` expression language.
- [x] Document access inheritance, the shipped vocabulary, and the capability flags.

---

## Defects found in review

The implementation above was reviewed after the fact, and four defects were
found that the test suite was green over. They are recorded here because each
one is a category of mistake this design is especially prone to.

1.  **`POST /api/site/export` was off by one.** `SubtypeTemplate.list()` was
    inserted into the middle of a positional `Promise.all` while its binding
    was appended at the end, so every later binding took its neighbour's value:
    the signing key received the template list, `baoSecrets` received the agent
    fleet *including token hashes*, and `apiTokens` received user
    verifications. A spoke would have joined "successfully" with a scrambled
    catalog. Nothing tested the export payload's shape; `tests/site_export_shape.test.js` now does.

2.  **`ResourceEdge.source` had been dropped from the model.** The ORM silently
    discards keys a model does not declare, so the field read back `undefined`,
    every `e.source === sourceName` test went false, and edge reparenting and
    pruning stopped happening — with no error anywhere. This is the failure
    mode to watch for with `@simpleworkjs/orm`: a removed field is not a crash,
    it is silence. `tests/reconciler_edges.test.js` covers it.

3.  **Join-key enrolment required a `?site=` parameter no shipped agent sent**,
    rejecting every self-enrolment with a 4001 close and an infinite retry.
    Resolved by decision 6 above.

4.  **Status rules could not express their two most common cases.** The
    evaluator's grammar had no `true`/`false`/`null` literals, so there was no
    way to write a catch-all fallback rule and no way to ask "did any telemetry
    arrive?" — and `bubbled_environment` in a rule was an object of merged
    *ancestor* metadata, bubbling the wrong direction, so the natural
    comparison `bubbled_environment == 'prod'` was silently false forever.

A fifth issue was latent rather than active: `metadata.constructor` in a rule
resolved to the `Object` constructor. There is no call syntax in the grammar so
it was not executable, but status rules are operator-editable rows in a
database, and "not reachable yet" is not a security property. Property access is
now own-properties-only.

## Current state

**954 tests, 952 passing, 0 failing, 2 skipped** — the whole suite, against a
live OpenLDAP:

```bash
docker compose -f docker-compose.test.yml run --rm --build test-runner \
  sh -lc 'NODE_ENV=test npx jest --forceExit'
```

`npm test` runs a curated subset (729 tests) that needs no LDAP.

The directory has also been exercised in a browser against a real server with a
seeded estate — site, Proxmox cluster, hypervisor, LXC and VM guests, services,
an iLO, a switch and a NAS. The tree renders, hierarchy and subtypes are
legible, own-vs-inherited environment and direct-vs-inherited access are
distinguishable at a glance, status dots carry honest tooltips
("No telemetry reported yet", not a green dot), and the read-only view opens by
default with the other tabs genuinely disabled.

### The "~192 LDAP-dependent failures" were not real

Three passes of this work recorded, and inherited, a note that ~192 tests fail
because they need LDAP and that this was unrelated to the redesign. Actually
running the full suite against the LDAP the repo already ships a compose file
for gave 852 passing and **one** genuine failure — caused by this work, and
invisible for as long as nobody checked. Run the full suite.

### The subtype vocabulary

119 templates, categorised for the picker: sites, machines, hypervisors and
guests, network gear and appliances, power and environment, endpoints, storage,
and services across databases, web, core network services, remote access,
messaging, observability, developer tooling and media. Each carries its
placement rules, capability flags, form schema and status rules. See
[`subtype-templates.md`](subtype-templates.md).

## The page was dead

Everything above was built, reviewed, tested and documented against a directory
page that **did not run in a browser at all**.

Commit `4b668a8` — the pass that added the Status tab and View/Edit mode — put a
`<script>` tag inside a JavaScript template literal. An HTML parser ends a
script element at the first closing script tag in the source, whatever
JavaScript context it appears to be in. So the page's real script element was
cut in half, the template literal it was inside was left unterminated, the whole
block was a syntax error, and **every function on the page was never defined**.
The directory rendered an empty table with the rest of its own source printed
underneath it.

Nothing caught it for three passes. The EJS template compiled. Every route
returned 200. Every API test passed. 664 unit tests passed. The bug existed
entirely in how a browser parses a response that the server was perfectly happy
to produce.

Two more things surfaced once the page could actually run, both invisible from
the server side:

- **`GET /api/directory-admin/resources` read raw rows, not the graph.** So
  `bubbled_environment` — the whole of design decision §2 — was computed on
  every request and thrown away before it reached the one screen it exists for.
  A site carrying production rendered identically to an empty one.
- **A site had no status dot at all**, because status was a leaf property with
  no roll-up. "See the status of a resource and its children at a glance"
  required expanding the entire tree and reading it yourself.

`tests/view_integrity.test.js` now checks that every view compiles, that script
elements are not closed from inside a string, that every inline script parses as
JavaScript, and that every function an inline handler names is actually defined.
It fails against `4b668a8` and passes against HEAD.

The lesson is narrower than "write more tests" and worth stating exactly: **a
server-rendered page is not covered by server-side tests.** Everything that
matters about it happens after the response leaves.

## Defects found in the plugin audit

Recorded for the same reason as the review defects above: each is a shape of
mistake this codebase is prone to, not a one-off.

1. **`kind` was an open vocabulary.** Nine values existed; four were understood.
   The cost was silent — `groupKind()` returned null for `bmc`,
   `network_device`, `container` and `template`, so none of those resources ever
   got access groups through the normal path, and the promote path had grown an
   incompatible second naming scheme to compensate.

2. **An omitted `subType` is not neutral.** An empty subtype is in the
   ssh-capable set, so `unifi` — which enumerates every DHCP client on the LAN —
   turned every phone, TV and doorbell into a candidate jump target. The same
   bug was fixed in `nmap` one pass earlier and nobody checked the sibling.

3. **Garbage collection did nothing, twice over.** It set
   `metadata.lifecycle_state = 'archived'`, a field written in one place and read
   in **zero** — and the write itself did not persist, because it handed the ORM
   back the same object it already held as `metadata`. A function that appeared
   to work, changed nothing, and would not have changed anything if it had.

4. **One queue served plugins and maintenance.** A single hung plugin — an
   unreachable Proxmox, an nmap sweep of a /16 — stopped status evaluation for
   every resource in the directory, with nothing in the UI to say why.

5. **Deleting a plugin instance orphaned everything it made.** Pruning only
   happens during a run of the owning source, and that source was gone. Permanent
   litter, growing with every plugin an operator tried and removed.

## Two things access inheritance changed that are worth knowing

**A roster group grants nothing below itself.** A site links
`{site}_everyone` as a ResourceGroup row so the group can be managed from the
site's modal. Every user at a site is in it, and `utils/groups.js`
`hasPermission()` deliberately does not honour it. The first cut of inheritance
propagated it, which would have handed every user at a site access to every
resource in it. Meta groups now grant the resource they are linked to and
nothing under it (`isMetaGroup`, and the `nonInheriting` argument to
`effectiveGrants`).

**A site super admin now reaches every resource at their site, in `/me`.**
`hasPermission()` has always said they have permission there, but the projection
only consulted it for hosts running an agent — so `/api/discovery/me` was
strictly more restrictive than the permission model it was supposed to
implement. Inheritance closes that gap. `access_request.test.js` needed its
setup updated as a result: stepping out of a host's two groups no longer makes
you a non-privileged requester if you also administer the site.

## Planned: not built yet

Two of the goals at the top of this document have no implementation. They are
recorded here as work, with the design questions that have to be answered first,
so nobody has to rediscover the shape of them.

### Active sessions — corrected: this was never actually unbuilt

> "See who is currently logged in and where."

This section previously said "nothing in the directory reads session state
today" and sketched it as unbuilt work. That was wrong when it was written:
`theta-agent` has reported sessions on every telemetry tick since
`telemetry.go:328` (`loginctl list-sessions` / `who` on Linux, `quser` on
Windows, as `{ user, tty, from, since, type }`), the directory has always
stored and rendered them (`hostTelemetryHtml`'s "Active Logged-in Users"
card, driven by `agent.lastTelemetry.logged_users`) — it just only ever
rendered for a plain host bound directly to an agent. A Proxmox-guest host
(any LXC/VM) took a different branch of the Status-tab dispatcher that never
called that renderer at all, regardless of whether the guest had an agent
installed, so it looked exactly like a missing feature. Fixed in v2.36.17
(`resolveHostAgent`/`loggedInSessionsCardHtml` extracted so both branches use
them); sessions now render for any host with a bound agent, guest or not.

What's still genuinely unbuilt:

- **A directory-wide "who is logged in anywhere" pane.** Only the per-host
  view exists. Aggregating across every host is a real, separate piece of
  work — this doc's original framing called it "the actually useful view,"
  and that's still true.
- **Retention and privacy.** Live sessions are one thing; a searchable
  history of who logged into what is a different product with different
  obligations. Nothing persists history today — this is still open, not
  resolved by the per-host fix.
- **Who may see them.** Session data is more sensitive than the resource it
  belongs to, and today it's gated by ordinary resource access — same
  question as before, still unanswered.
- **Windows and containers.** `loginctl` covers systemd hosts. Windows needs
  a different call, and a container has no sessions at all — unchanged.

### Agent-pulled configuration

> "Allow theta-agent to pull and apply configurations (similar to an ACME
> client) from the proxy."

Also unbuilt, and the design is genuinely open. What exists already and overlaps:
the mesh config push (`utils/mesh_client_conf.js`), the secret-rendering targets
in `agent.yml`, and the LDAP/SSSD configuration the agent already applies.

Open questions:

- **What is pulled?** Proxy/TLS material is the stated example, but the same
  mechanism could carry firewall rules, SSSD config or service definitions —
  and "the agent applies arbitrary config from the server" is a much larger
  security surface than "the agent fetches a certificate".
- **Pull or push?** The ACME analogy implies the agent polls and reconciles,
  which survives an agent being offline. The mesh path pushes today. Two
  mechanisms doing the same job would be worse than either.
- **What authorises it?** The agent's enrolment token authenticates the agent.
  It does not currently express *which* configuration that agent is entitled to.
- **What happens on a bad config?** An agent that renders a broken proxy config
  and reloads is an outage it caused. Needs a validate-then-apply step and a
  rollback, which is most of the actual work.

## Remaining gaps / risks

- The two items above, which are features rather than defects.
- **The Access column is repetitive.** Because everything inherits from its
  site, nearly every row reads "2 groups · N inherited". It is accurate and it
  is noise; it probably wants collapsing to the exceptions. Still open.

Closed since the list above was written:

- ~~No fleet-level summary~~ — `renderFleetSummary()` (v2.36.17) shows a
  healthy/warning/critical/unknown host count above the tree, always visible,
  not just per-site.
- ~~The modal is titled "Edit Resource" even in View mode~~ — fixed; the
  title now tracks View vs. Edit.
- ~~Nothing surfaces "these N resources were classified by a scan and nobody
  has confirmed them"~~ — `metadata.subTypeSource` (v2.36.17) now renders a
  "Guessed" badge both in the tree row and on the resource's own Identity
  card, wherever `nmap`/`unifi` inferred rather than an operator decided.
