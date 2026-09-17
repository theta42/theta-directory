'use strict';

// A discovery plugin that points at a web UI gets a catalog entry for it.
//
// Adding a Proxmox or a UniFi controller is a deliberate admin act, and the
// thing they just configured -- `https://pve.example:8006` -- is exactly the
// kind of address a person goes looking for later and cannot find. Before
// this, the admin typed that URL into a plugin form and it went nowhere the
// catalog could see.
//
// The signal is already in every manifest: a `configSchema` field of
// `type: 'url'`. No per-plugin special-casing, and nmap -- which scans a CIDR
// and points at no UI -- correctly produces nothing.
//
//   ilo      { key: 'url', type: 'url', placeholder: 'https://ilo.example.com' }
//   proxmox  { key: 'url', type: 'url', placeholder: 'https://pve.example:8006' }
//   unifi    { key: 'url', type: 'url', placeholder: 'https://unifi.example:8443' }
//   nmap     -- none
//
// CREATE ONCE, NEVER RE-ASSERT. Discovery re-runs on a schedule; an admin who
// renames the entry, rewrites its tagline or unticks "Show in catalog" must
// not have that undone on the next tick. The same rule the bootstrap's
// `ensure()` follows, and the same one the v3.42.0 seed corrections got wrong.

const crypto = require('crypto');
const { Resource, ResourceEdge } = require('../models/resource');

// The first `type: 'url'` field in a manifest's configSchema, if it has one.
function urlFieldKey(manifest) {
	const schema = (manifest && Array.isArray(manifest.configSchema)) ? manifest.configSchema : [];
	const field = schema.find((f) => f && f.type === 'url');
	return field ? field.key : null;
}

// Split a URL into the http subtype's external shape. Anything unparseable is
// skipped rather than guessed at -- a catalog card pointing at a malformed
// address is worse than no card.
function endpointFromUrl(raw) {
	let u;
	try { u = new URL(String(raw)); } catch (e) { return null; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
	const isHTTPS = u.protocol === 'https:';
	const port = u.port ? Number(u.port) : (isHTTPS ? 443 : 80);
	return { fqdn: u.hostname, externalIsHTTPS: isHTTPS, externalPort: port, address: u.origin };
}

// The resource the plugin created to stand for its own endpoint, so the entry
// hangs under the machine rather than floating at the root. Proxmox records
// `sourceId: url` on its cluster row for exactly this reason; anything that
// simply stored the address matches too. No parent is acceptable -- the entry
// is still a valid catalog row, it just has no host to inherit status from.
async function findEndpointHost(sourceName, url) {
	const all = await Resource.list().catch(() => []);
	const origin = (() => { try { return new URL(url).origin; } catch (e) { return null; } })();
	return all.find((r) => {
		if (r.kind !== 'host') return false;
		const md = r.metadata || {};
		const sources = Array.isArray(md.discovery_sources) ? md.discovery_sources : [];
		if (sources.length && !sources.includes(sourceName)) return false;
		return md.sourceId === url || md.address === url || (origin && md.address === origin);
	}) || null;
}

/**
 * Ensure a catalog entry exists for a plugin instance's configured URL.
 * Returns the resource if it created one, else null. Never throws: a failure
 * here must not fail the discovery run that triggered it.
 */
async function ensurePluginCatalogEntry(instance, manifest, config) {
	try {
		if (!instance || !manifest) return null;
		const key = urlFieldKey(manifest);
		if (!key) return null;

		const url = config && config[key];
		if (!url) return null;
		const endpoint = endpointFromUrl(url);
		if (!endpoint) return null;

		const slug = `plugin-${instance.slug}-ui`;

		// Create-once. An existing row is left EXACTLY as it is -- including a
		// `catalog` an admin has since unticked, and a URL they have corrected
		// by hand.
		const existing = await Resource.getBySlug(slug).catch(() => null);
		if (existing) return null;

		const parent = await findEndpointHost(instance.slug, url);

		const created = await Resource.create({
			id: crypto.randomUUID(),
			kind: 'service',
			name: manifest.name || instance.slug,
			slug,
			description: manifest.description || '',
			metadata: {
				subType: 'http',
				...endpoint,
				icon: manifest.icon || 'fa-solid fa-gauge-high',
				tagline: `The ${manifest.name || instance.pluginType} web interface.`,
				// On by default: the admin configured this deliberately, which
				// is a much stronger signal than anything passive discovery
				// produces. Unticking it sticks, per create-once above.
				catalog: true,
				requestable: true,
				managed: true,
				discovery_sources: [instance.slug],
				sourceId: url,
			},
			created_on: Math.floor(Date.now() / 1000),
		});

		if (parent) {
			await ResourceEdge.create({
				id: crypto.randomUUID(),
				parentId: parent.id,
				childId: created.id,
				relation: 'hosts',
			}).catch(() => {});
		}

		console.log(`[Catalog] Added "${created.name}" (${slug}) for plugin ${instance.slug}`
			+ (parent ? ` under ${parent.slug}` : ' with no parent host'));
		return created;
	} catch (err) {
		console.warn(`[Catalog] Could not add an entry for plugin ${instance && instance.slug}:`, err.message);
		return null;
	}
}

module.exports = { ensurePluginCatalogEntry, urlFieldKey, endpointFromUrl };
