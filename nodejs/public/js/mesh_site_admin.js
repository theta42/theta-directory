// Multi-site & master node controls: site status, LDAP replication drift,
// registered spokes, master promotion/join, and site join keys.
//
// Extracted from views/directory.ejs (part of the ongoing decomposition of
// that file -- see docs/resources-reimagined.md) as a plain classic script,
// loaded via <script src> alongside directory.ejs's own inline <script>.
// Deliberately NOT wrapped in an IIFE and NOT 'use strict': every function
// here is called directly from directory.ejs's markup (onclick="..."), from
// the site-status badge in the page header, and from its page-load bootstrap
// ($(document).ready), so each needs to land as a genuine global -- exactly
// as it already behaved living inline. Nothing pure to unit-test here either
// (DOM/API glue only); tests/view_integrity.test.js resolves onclick targets
// and checks this file parses, the same as directory.ejs itself.
//
// Unlike discovery_admin.js, this cluster has essentially no dependency on
// directory.ejs's resource-graph state (resourcesById/allEdges/
// subtypeTemplates/rawResources) -- it fetches its own data fresh via
// app.api on every call. Only app.*/jQuery globals from top.ejs's bundles
// are needed.

// ── Multi-Site & Master Node Controls ─────────────────────────────────────
async function refreshSiteStatus() {
  try {
    const res = await app.api.get('directory-admin/site-status');
    if (res && res.config) {
      const isMaster = res.config.isMaster;
      const $badge = $('#site-node-badge');
      if (isMaster) {
        $badge.attr('class', 'badge bg-dark text-warning border border-warning shadow-sm')
              .html('<i class="fa-solid fa-crown me-1 text-warning"></i> Master Site');
      } else {
        $badge.attr('class', 'badge bg-secondary text-info border border-info shadow-sm')
              .html('<i class="fa-solid fa-bolt me-1 text-info"></i> Spoke Site (Read-Only)');
      }
    }
  } catch (e) { console.error('Failed to fetch site status:', e); }
}

// ldap: { configuredServerId, advertisedServerId, stale, peersCount } from
// GET /directory-admin/site-status (routes/api_directory_admin.js).
// configuredServerId is read from THIS node's live slapd.conf;
// advertisedServerId (master only) is what the API currently hands spokes.
// They can genuinely disagree right after a promotion or a new spoke
// joining -- OpenLDAP's static config only reloads at process start.
function renderLdapStatus(ldap) {
  if (!ldap) return '<span class="text-muted">unknown</span>';
  if (ldap.configuredServerId == null) {
    return '<span class="badge bg-secondary"><i class="fa-solid fa-circle-minus me-1"></i> Not configured (standalone)</span>';
  }
  let html = '<span class="badge bg-dark">ServerID ' + esc(ldap.configuredServerId) + '</span>';
  if (ldap.peersCount != null) {
    html += ' <span class="badge bg-primary">' + ldap.peersCount + ' peer' + (ldap.peersCount === 1 ? '' : 's') + '</span>';
  }
  if (ldap.stale === null) {
    html += ' <span class="badge bg-secondary" title="' + esc(ldap.note || 'slapd.conf could not be read, so drift cannot be determined') +
      '"><i class="fa-solid fa-circle-question me-1"></i> Drift unknown</span>';
    return html;
  }
  if (ldap.stale) {
    // Two independent kinds of drift. The ServerID one only happens after a
    // promotion; the peer-list one happens to EVERY site each time any new
    // site joins, and nothing re-runs setup.sh on the sites already up.
    var why = [];
    if (ldap.serverIdStale) {
      why.push('This node now advertises ServerID ' + ldap.advertisedServerId +
        ' but slapd is still running with ' + ldap.configuredServerId + '.');
    }
    if (ldap.peersStale) {
      if (ldap.missingPeers && ldap.missingPeers.length) {
        why.push('Not replicating with: ' + ldap.missingPeers.join(', ') + '.');
      }
      if (ldap.extraPeers && ldap.extraPeers.length) {
        why.push('Still configured for sites no longer in the cluster: ' + ldap.extraPeers.join(', ') + '.');
      }
    }
    // Replication config is normally applied live (utils/ldap_reconcile.js),
    // so this badge means the automatic path failed rather than that the
    // operator forgot a step.
    why.push('Replication config is normally applied automatically and live; seeing this means that failed -- check the container log for [ldap-reconcile] errors.');
    html += ' <span class="badge bg-warning text-dark" title="' + esc(why.join(' ')) +
      '"><i class="fa-solid fa-triangle-exclamation me-1"></i> ' +
      (ldap.peersStale ? 'Peer list out of sync' : 'ServerID out of sync') + '</span>';
  }
  return html;
}

// spokes: [{siteSlug, endpoint, noInbound, relayNote, ldapServerId, lastSeenOn}]
// Per-spoke detail (master only) so an operator can see what's actually
// registered instead of only an aggregate count.
function renderSpokesTable(spokes) {
  if (!spokes || !spokes.length) return '';
  const rows = spokes.map(function(s) {
    return '<tr>' +
      '<td><code>' + esc(s.siteSlug || '?') + '</code></td>' +
      '<td class="small">' + esc(s.endpoint) + '</td>' +
      '<td>' + (s.ldapServerId != null ? '<span class="badge bg-dark">' + esc(s.ldapServerId) + '</span>' : '<span class="text-muted small">unassigned</span>') + '</td>' +
      '<td>' + (s.noInbound
        ? '<span class="badge bg-info text-dark" title="' + esc(s.relayNote || '') + '"><i class="fa-solid fa-diagram-project me-1"></i> Relayed</span>'
        : '<span class="text-muted small">direct</span>') + '</td>' +
      // Actions: this table used to be purely informational, so a
      // decommissioned site's row sat here forever holding an LDAP ServerID
      // and collecting replication pushes, and the only way to force a sync
      // was to make an unrelated catalog write.
      '<td class="text-end text-nowrap">' +
        '<button class="btn btn-sm btn-outline-primary py-0 px-1 me-1" data-spoke-resync="' + esc(s.id) + '" title="Push a resync to this spoke now">' +
          '<i class="fa-solid fa-rotate"></i></button>' +
        '<button class="btn btn-sm btn-outline-danger py-0 px-1" data-spoke-remove="' + esc(s.id) + '" data-spoke-label="' + esc(s.siteSlug || s.endpoint) + '" title="Remove this spoke from the registry">' +
          '<i class="fa-solid fa-trash"></i></button>' +
      '</td>' +
    '</tr>';
  }).join('');
  return '<div class="card mt-3">' +
    '<div class="card-header py-2 fw-bold small d-flex justify-content-between align-items-center">' +
      '<span><i class="fa-solid fa-diagram-project me-1"></i> Registered Spokes</span>' +
      '<button class="btn btn-sm btn-outline-primary py-0 px-2" data-spoke-resync-all="1">' +
        '<i class="fa-solid fa-rotate me-1"></i> Sync all now</button>' +
    '</div>' +
    '<div class="card-body p-0">' +
      '<table class="table table-sm table-hover mb-0">' +
        '<thead><tr><th>Site</th><th>Endpoint</th><th>LDAP ServerID</th><th>Path</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>' +
  '</div>';
}

// Wires the spoke-row actions. Called after the modal body is rendered.
function bindSpokeActions(container, reopen) {
  if (!container) return;

  container.querySelectorAll('[data-spoke-resync], [data-spoke-resync-all]').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const id = btn.getAttribute('data-spoke-resync');
      btn.disabled = true;
      try {
        const res = await app.api.post('site/spokes/resync', id ? { id: id } : {});
        const failed = (res.results || []).filter(function(r) { return !r.ok; });
        if (failed.length) {
          app.messages.toast('Resync reached ' + res.ok + ' spoke(s); failed for: ' +
            failed.map(function(f) { return f.endpoint + ' (' + f.error + ')'; }).join(', '), 'warning');
        } else {
          app.messages.toast('Resync pushed to ' + res.ok + ' spoke(s).', 'success');
        }
      } catch (e) {
        app.messages.toast('Resync failed: ' + (e.message || e), 'danger');
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Row-scoped confirm rather than app.messages.confirm(): that renders into
  // a single shared banner, so with one button PER ROW a second click before
  // the first resolves leaves a dangling body-level handler and the banner
  // can end up confirming for the wrong row. Same reasoning (and the same
  // shape) as confirmAgentJoinKeyAction above.
  container.querySelectorAll('[data-spoke-remove]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const id = btn.getAttribute('data-spoke-remove');
      const label = btn.getAttribute('data-spoke-label');
      const $cell = $(btn).closest('td');
      $cell.html('<span class="small me-1">Remove ' + esc(label) + '?</span>');
      $('<button class="btn btn-danger btn-sm me-1">Yes</button>')
        .appendTo($cell)
        .on('click', async function() {
          try {
            const res = await app.api.delete('site/spokes/' + encodeURIComponent(id));
            app.messages.toast(res.message + (res.note ? ' ' + res.note : ''), 'success');
          } catch (e) {
            app.messages.toast('Could not remove spoke: ' + (e.message || e), 'danger');
          }
          if (reopen) reopen();
        });
      $('<button class="btn btn-outline-secondary btn-sm">No</button>')
        .appendTo($cell)
        .on('click', function() { if (reopen) reopen(); });
    });
  });
}

async function openSiteStatusModal() {
  try {
    const res = await app.api.get('directory-admin/site-status');
    const cfg = res.config || {};
    const isMaster = cfg.isMaster;

    let html = '<div class="p-2">' +
      // Where app.messages.action()/confirm() render. Without a
      // `.actionMessage` in the target, action() silently degrades to a
      // toast and confirm() renders NOTHING AND NEVER RESOLVES -- so the
      // spoke-remove and promote confirmations just did nothing when
      // clicked. (Verified in a browser: the click registered, the row
      // stayed, no dialog appeared.)
      '<div class="actionMessage rounded p-2 mb-2" style="display:none"></div>' +
      '<div class="card mb-3 shadow-sm border-' + (isMaster ? 'warning' : 'info') + '">' +
        '<div class="card-body">' +
          '<h5 class="card-title d-flex align-items-center justify-content-between">' +
            '<span>' + (isMaster ? '👑 <strong>Master Site Node</strong>' : '⚡ <strong>Spoke Site Node</strong>') + '</span>' +
            '<span class="badge bg-' + (isMaster ? 'warning text-dark' : 'info text-dark') + '">' + esc(cfg.siteMode || 'master') + '</span>' +
          '</h5>' +
          '<p class="card-text text-muted small mb-2">Multi-site directory & replication state for this node. ' +
            '<a href="https://theta42.github.io/theta-suite/sso/multi-site.html" target="_blank" rel="noopener"><i class="fa-solid fa-book me-1"></i>Directory join docs</a>' +
            ' &middot; ' +
            '<a href="https://theta42.github.io/theta-suite/jump-host/mesh.html" target="_blank" rel="noopener"><i class="fa-solid fa-book me-1"></i>Gateway mesh docs</a>' +
          '</p>' +
          '<table class="table table-sm text-start mb-0">' +
            '<tr><th>Local Site Slug:</th><td><code>' + esc(cfg.siteSlug || 'site-default') + '</code></td></tr>' +
            '<tr><th>Master Authority URL:</th><td>' + (cfg.masterUrl ? ('<code>' + esc(cfg.masterUrl) + '</code>') : '<em>(This Node is Master)</em>') + '</td></tr>' +
            '<tr><th>WAN Sync Health:</th><td>' + (res.config.wanConnected === false
              ? '<span class="badge bg-danger"><i class="fa-solid fa-xmark me-1"></i> Offline / Disconnected</span>'
              : '<span class="badge bg-success"><i class="fa-solid fa-check me-1"></i> Online / Operational</span>') + '</td></tr>' +
            (!isMaster ? '<tr><th>Live Replication:</th><td>' + (cfg.liveReplication
              ? '<span class="badge bg-success"><i class="fa-solid fa-bolt me-1"></i> Live (catalog updates push automatically)</span>'
              : '<span class="badge bg-warning text-dark"><i class="fa-solid fa-triangle-exclamation me-1"></i> Snapshot only</span>') +
              // Re-registering is the recovery path for every state where
              // this node and its master disagree about live replication:
              // a join made without selfUrl, or a registry row the master
              // removed/recreated. POST /join cannot do it (it refuses once
              // this node is a spoke).
              ' <button class="btn btn-sm btn-outline-primary py-0 px-2 ms-2" onclick="reregisterWithMaster()">' +
              '<i class="fa-solid fa-rotate me-1"></i> Re-register</button>' +
              '</td></tr>' : '') +
            (isMaster ? '<tr><th>Registered Spokes:</th><td><span class="badge bg-success">' + (cfg.registeredSpokesCount || 0) + ' receiving live updates</span></td></tr>' : '') +
            '<tr><th>Registered Sites:</th><td><span class="badge bg-primary">' + (res.sitesCount || 0) + ' sites</span></td></tr>' +
            '<tr><th>Theta Gateways:</th><td>' + (res.gatewaysCount == null
              ? '<span class="badge bg-secondary" title="' + esc(res.gatewaysNote || 'not configured') + '"><i class="fa-solid fa-question me-1"></i> Unknown (jump-host integration not configured)</span>'
              : '<span class="badge bg-dark">' + res.gatewaysCount + ' active gateway' + (res.gatewaysCount === 1 ? '' : 's') + '</span>') + '</td></tr>' +
            '<tr><th>LDAP Replication (MMR):</th><td>' + renderLdapStatus(res.ldap) + '</td></tr>' +
          '</table>' +
        '</div>' +
      '</div>' +
      '<div class="alert alert-secondary small mb-3">' +
        '<i class="fa-solid fa-network-wired me-1"></i> <strong>WireGuard Gateway Mesh & NETMAP</strong>: Inter-site routing operates via <code>theta-gateway</code> subnets (<code>10.x.0.0/16</code>) with default NETMAP shadow translations (<code>10.x.168.0/24 &rarr; 192.168.1.0/24</code>).' +
      '</div>' +
      (isMaster ? renderSpokesTable(res.spokes) : '');

    // Fresh install (no users/resources yet): offer to JOIN an existing
    // master site instead of seeding a new directory.
    if (isMaster && cfg.canJoin) {
      html += '<div class="card border-primary shadow-sm mt-3">' +
        '<div class="card-body">' +
          '<h6 class="fw-bold"><i class="fa-solid fa-link me-1 text-primary"></i> Join an Existing Site (Spoke)</h6>' +
          '<p class="small text-muted mb-2">This is a fresh install. Join an existing (master) deployment to run as a read-only spoke of its directory — paste the master URL and a site join key minted there.</p>' +
          '<div class="row g-2">' +
            '<div class="col-md-7"><input type="text" id="site-join-url" class="form-control form-control-sm" placeholder="Master Directory URL (e.g. https://sso.master.example.com)"></div>' +
            '<div class="col-md-5"><input type="text" id="site-join-key" class="form-control form-control-sm font-monospace" placeholder="Site join key (stj_...)"></div>' +
          '</div>' +
          '<div class="mt-2">' +
            '<label class="form-label small mb-1">This site\'s own reachable URL <span class="text-muted">(so the master can push live updates here — leave blank to only get a one-time snapshot)</span></label>' +
            '<input type="text" id="site-join-self-url" class="form-control form-control-sm" value="' + esc(window.location.origin) + '">' +
          '</div>' +
          '<button class="btn btn-sm btn-primary mt-2" onclick="joinCurrentSiteToMaster()"><i class="fa-solid fa-link me-1"></i> Join Site</button>' +
        '</div>' +
      '</div>';
    }

    // A master mints the site join keys spokes present when joining.
    if (isMaster) {
      html += '<div class="card mt-3">' +
        '<div class="card-header py-2 fw-bold small"><i class="fa-solid fa-key me-1"></i> Site Join Keys <span class="text-muted">(for spokes to adopt this directory)</span></div>' +
        '<div class="card-body py-2">' +
          '<div class="d-flex gap-2 align-items-end mb-2">' +
            '<div class="flex-grow-1"><input type="text" id="site-join-key-label" class="form-control form-control-sm" placeholder="label (e.g. staten-island)"></div>' +
            '<button class="btn btn-sm btn-success" onclick="mintSiteJoinKey()"><i class="fa-solid fa-plus me-1"></i> Mint key</button>' +
          '</div>' +
          '<div id="site-join-key-result" class="mb-2"></div>' +
          '<table class="table table-sm table-hover mb-0 small"><thead><tr><th>Label</th><th>Prefix</th><th>Used</th><th>Status</th><th class="text-end"></th></tr></thead><tbody id="site-join-key-tbody"></tbody></table>' +
        '</div>' +
      '</div>';
      loadSiteJoinKeys();
    }

    if (!isMaster) {
      html += '<div class="card border-danger shadow-sm mt-3">' +
        '<div class="card-body text-center">' +
          '<h6 class="text-danger fw-bold"><i class="fa-solid fa-triangle-exclamation me-1"></i> Promote Node to Master Authority</h6>' +
          '<p class="small text-muted mb-2">Requires explicit <code>god_admin</code> authorization. Spoke nodes remain in Spoke mode automatically during WAN outages to prevent split-brain errors.</p>' +
          '<button class="btn btn-sm btn-danger shadow-sm" onclick="promoteCurrentSiteToMaster()">' +
            '<i class="fa-solid fa-crown me-1"></i> Promote This Node to Master' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    html += '</div>';

    app.modal.open({ title: 'Multi-Site & Network Gateway Status', bodyHtml: html, size: 'lg' });
    // Bound after open(), which rebuilds the modal body -- handlers attached
    // to the pre-render markup would be thrown away.
    if (isMaster) bindSpokeActions(app.modal.body()[0] || document, openSiteStatusModal);
  } catch (e) {
    app.messages.toast('Error fetching site status: ' + e.message, 'danger');
  }
}

async function reregisterWithMaster() {
  try {
    const res = await app.api.post('site/reregister', { selfUrl: window.location.origin });
    app.messages.toast(
      res.message + (res.live ? ' — live replication is active.' : ' — the master did not issue a push token.'),
      res.live ? 'success' : 'warning'
    );
    openSiteStatusModal();
  } catch (e) {
    app.messages.toast('Re-registration failed: ' + (e.message || e), 'danger');
  }
}
window.reregisterWithMaster = reregisterWithMaster;

async function promoteCurrentSiteToMaster() {
  const confirmed = await app.messages.confirm(
    'Are you sure you want to promote this site node to Master? This grants single write authority for directory catalog changes.',
    app.modal.body(), 'danger'
  );
  if (!confirmed) return;

  try {
    const res = await app.api.post('directory-admin/site-promote', { selfUrl: window.location.origin });
    const handoffOk = res.handoff === 'previous master demoted' || /no previous master/.test(res.handoff || '');
    app.messages.toast((res.message || 'Node promoted to Master Site') + ' — ' + (res.handoff || ''), handoffOk ? 'success' : 'warning');
    app.modal.close();
    refreshSiteStatus();
  } catch (e) {
    app.messages.action('Promotion failed: ' + (e.message || e), app.modal.body(), 'danger');
  }
}

// ── Site join (spoke adopts a master directory) ───────────────────────────
async function joinCurrentSiteToMaster() {
  const masterUrl = ($('#site-join-url').val() || '').trim();
  const joinKey = ($('#site-join-key').val() || '').trim();
  const selfUrl = ($('#site-join-self-url').val() || '').trim();
  if (!masterUrl || !joinKey) {
    return app.messages.toast('Enter the master Directory URL and a site join key', 'warning');
  }
  const confirmed = await app.messages.confirm(
    'Join ' + masterUrl + ' as a read-only spoke? This adopts its directory (users, groups, resources).',
    app.modal.body(), 'warning'
  );
  if (!confirmed) return;

  try {
    const res = await app.api.post('site/join', { masterUrl, joinKey, ...(selfUrl ? { selfUrl } : {}) });
    const replicationNote = res.replication && res.replication.live
      ? ' Live replication is active.'
      : ' Snapshot only — this site will not receive live updates (' + ((res.replication && res.replication.note) || 'no selfUrl given') + ').';
    app.messages.toast((res.message || 'Joined master site') + replicationNote, res.replication && res.replication.live ? 'success' : 'warning');
    app.modal.close();
    refreshSiteStatus();
  } catch (e) {
    app.messages.action('Join failed: ' + (e.message || e), app.modal.body(), 'danger');
  }
}

async function loadSiteJoinKeys() {
  try {
    const res = await app.api.get('site/join-keys');
    const rows = (res.joinKeys || []).map(k => {
      const status = k.revoked
        ? '<span class="badge bg-secondary">revoked</span>'
        : '<span class="badge bg-success">active</span>';
      const revoke = k.revoked
        ? ''
        : '<button class="btn btn-sm btn-outline-danger" onclick="revokeSiteJoinKey(\'' + k.id + '\')"><i class="fa-solid fa-ban me-1"></i>Revoke</button>';
      return '<tr><td>' + esc(k.label) + '</td><td><code>' + esc(k.keyPrefix) + '</code></td><td>' + (k.use_count || 0) + '</td><td>' + status + '</td><td class="text-end">' + revoke + '</td></tr>';
    }).join('');
    $('#site-join-key-tbody').html(rows);
  } catch (e) { console.error('load site join keys:', e); }
}

async function mintSiteJoinKey() {
  const label = ($('#site-join-key-label').val() || '').trim() || 'default';
  try {
    const res = await app.api.post('site/join-keys', { label });
    $('#site-join-key-result').html(
      '<div class="alert alert-warning small p-2 mb-0">Key created (shown once, copy it now): <code class="user-select-all">' + res.key + '</code>' +
      '<button class="btn btn-sm btn-outline-secondary ms-2" onclick="copySiteJoinKey(this)"><i class="fa-solid fa-copy me-1"></i>Copy</button></div>'
    );
    loadSiteJoinKeys();
  } catch (e) { app.messages.toast('Mint failed: ' + (e.message || e), 'danger'); }
}

function copySiteJoinKey(btn) {
  const code = $(btn).closest('div').find('code').text();
  navigator.clipboard.writeText(code).then(() => {
    $(btn).html('<i class="fa-solid fa-check me-1"></i>Copied!');
  });
}

async function revokeSiteJoinKey(id) {
  try {
    await app.api.post('site/join-keys/' + id + '/revoke', {});
    loadSiteJoinKeys();
  } catch (e) { app.messages.toast('Revoke failed: ' + (e.message || e), 'danger'); }
}
