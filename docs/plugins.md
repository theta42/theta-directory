# Plugins

The SSO Manager runs **plugins** as scheduled background tasks. A plugin
**type** is an installed module; a plugin **instance** is a configured, loadable
copy of a type. You can create, edit, load/unload, run, and delete instances
from the **Plugins** page (or the `/api/plugins` API), and you can run several
instances of the same type — e.g. two Proxmox endpoints, each with its own URL
and token on its own schedule.

Per-instance **secrets** are stored in [OpenBao](https://openbao.org/) at
`secret/plugins/<instance-id>/conf`, not in `sso-secrets.js`. The admin UI only
ever shows them masked (`********`); the plugin reads them at run time. This
needs theta-suite ≥ v1.30.1 (which grants the `sso-broker` OpenBao policy
`secret/plugins/*`); re-run `./setup.sh` after upgrading.

## Plugin types

A plugin type is a module under `nodejs/plugins/<category>/<type>.js`. The
filename basename (without `.js`) is the `type`; the parent directory is the
`category`. Two built-in categories ship today:

**`discovery`** — scheduled scans that sync external assets into the
directory catalog:

- `proxmox` — Proxmox VE (URL + API token)
- `unifi` — UniFi Network controller (URL + username/password)
- `nmap` — nmap OS + port scan (a target range; no credentials)
- `docker` — Docker daemon discovery (containers as directory resources)

**`messaging`** — on-demand delivery for alerts, 2FA codes, and
notifications:

- `twilio` — Twilio SMS
- `webhook` — universal REST webhook (custom JSON payload to Slack, Teams,
  Discord, or any HTTP endpoint)

If no messaging plugin instance is enabled, the system falls back to the
legacy `voipms` integration configured directly in the SSO secrets.

### What the Proxmox plugin produces

One endpoint becomes one subtree:

```
Proxmox endpoint (cluster name, or the endpoint hostname)
└── node (hypervisor)
    ├── VM / template
    └── LXC / template
```

The endpoint resource stands for the cluster, not a machine, so it carries the
API URL and a `sourceId` but deliberately no IP — giving it the address it is
reached at made the reconciler merge it with the node answering on that address,
which produced a resource that was its own parent.

Every guest carries:

- `interfaces[]` — one entry per NIC with its own `mac`, `ip`/`ips` and `name`.
  The MAC and the address on it are read from the same source, so they cannot be
  mismatched (an earlier version collected MACs and IPs into two flat lists and
  zipped them by index, which attributed addresses to the wrong NIC on any
  multi-NIC guest).
- `macAddress` / `ip` — the primary NIC's values, preferring one that actually
  has an address.
- `vmid`, `node` and `sourceId` (`<node>/qemu/<vmid>` or `<node>/lxc/<vmid>`), so
  a directory row traces back to the exact guest on the exact node.

Interfaces belonging to something running *inside* a guest — `docker0`, `veth*`,
`br-*`, VPN tunnels — are filtered out. They are not NICs of the host, and their
172.x addresses would otherwise give the reconciler spurious matches.

A stopped VM still reports its MAC (read from the VM config rather than the
guest agent), and a DHCP-configured LXC gets its address from the running
container's interface list. Offline nodes are recorded with `status` rather than
skipped, so a hypervisor that is down does not look decommissioned and get
garbage-collected after a week.

A module exports a **manifest**:

```javascript
module.exports = {
  // Identity — `type`/`category` default to the file/dir name but can be set
  // explicitly. `name`/`description` show up in the UI.
  type: 'proxmox',
  category: 'discovery',
  name: 'Proxmox VE',
  description: 'Discover VMs, containers, and nodes from a PVE endpoint.',

  // Drives the admin UI form, API validation, and secret masking. Fields with
  // `secret: true` are stored in OpenBao; the rest live in the DB row.
  configSchema: [
    { key: 'url',         label: 'API URL',       type: 'url',      required: true },
    { key: 'tokenId',     label: 'Token ID',      type: 'text',     required: true },
    { key: 'tokenSecret', label: 'Token Secret',  type: 'password', required: true, secret: true }
  ],

  // "Test" button: validate the config (don't do the work). Return
  // { ok: true } or { ok: false, error: '...' }. Optional.
  validate: async (config) => { … },

  // The work. `run` is the generalized contract name; the discovery plugins
  // also keep `discover` as an alias for back-compat. For `category:
  // 'discovery'`, the scheduler passes the result to the discovery reconciler.
  run: async (config) => { return { resources, edges }; },
  discover: async (config) => { return { resources, edges }; }
};
```

`run(config)` receives the merged non-secret config + secret values as one flat
object (e.g. `{ url, tokenId, tokenSecret }`). For a discovery plugin it
returns `{ resources, edges }`; the reconciler upserts them into the resource
graph attributed to the instance's **slug** (the `discovery_sources` name).

### Writing a custom plugin type

Drop a `.js` file under `nodejs/plugins/discovery/` (or a new category directory)
following the manifest above. New types are picked up at boot, so restart the
SSO Manager after adding one. Runtime load/unload is per-**instance** only —
adding a new type still needs a restart.

## The Plugins page

Under **Plugins** (nav, admin-only — `app_sso_admin` / `app_sso_directory_admin`
/ `app_super_admin`):

- **New Plugin** — pick a type, name it, choose a unique slug (the discovery
  source name + the URL the resource graph attributes results to), set a cron
  schedule, and fill in the config form (secret fields are password inputs).
  Creating it schedules it and kicks one immediate run.
- **Edit** — name, cron, and non-secret config.
- **Edit Secrets** (key icon) — password fields, prefilled masked. Leave a
  field blank to keep its current value.
- **Test** (vial icon) — runs the plugin's `validate`.
- **Run now** (play icon) — enqueues one immediate run regardless of state.
- **Load / Unload** — enable/disable the schedule without deleting the instance.
- **Delete** — removes the schedule, the OpenBao secret namespace, and the row.

## API

All endpoints are mounted at `/api/plugins`, require an authenticated admin
(`app_sso_admin` / `app_sso_directory_admin` / `app_super_admin`), and return
secret values masked.

| Method + path | Purpose |
|---|---|
| `GET /api/plugins/types` | list installed plugin types + their `configSchema` |
| `GET /api/plugins` | list instances (with masked secrets + last-run state) |
| `GET /api/plugins/:id` | one instance |
| `POST /api/plugins` | create — body `{ pluginType, name, slug, cron, config }` where `config` is a flat object of all field values; secret fields are split into OpenBao |
| `PUT /api/plugins/:id` | update name/cron/enabled + non-secret config |
| `PUT /api/plugins/:id/secrets` | update secret fields (blank = keep) |
| `POST /api/plugins/:id/test` | run `validate` → `{ ok }` or `{ ok:false, error }` |
| `POST /api/plugins/:id/load` | enable + schedule + run now |
| `POST /api/plugins/:id/unload` | unschedule + disable |
| `POST /api/plugins/:id/run` | enqueue one immediate run |
| `DELETE /api/plugins/:id` | unschedule + remove OpenBao secrets + delete row |
| `GET /api/plugins/:id/runs` | `{ lastRunAt, lastStatus, lastError }` |

## Scheduler internals

The scheduler ([BullMQ](https://docs.bullmq.io/) over Redis) gives each instance
a stable JobScheduler id (`plugin:<instanceId>`); load/unload upsert/remove
that one schedule without disturbing the others. A daily `garbage_collect` job
prunes discovery resources not seen in > 7 days.

### Legacy migration

Before this system, plugins were configured statically in `sso-secrets.js`:

```javascript
module.exports = {
  discovery: {
    plugins: {
      proxmox: { enabled: true, cron: '0 * * * *', url: '…', tokenId: '…', tokenSecret: '…' }
    }
  }
};
```

On the first boot of SSO Manager ≥ v1.17.0, if the `PluginInstance` table is
empty **and** `conf.discovery.plugins` has entries, one instance per configured
type is seeded automatically (secret fields copied into OpenBao). After that the
table is non-empty and the static config is ignored — manage plugins from the
UI/API instead. The migration is idempotent (guarded by the empty-table check).