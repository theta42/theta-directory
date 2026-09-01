// Discovery plugin admin, discovered-inventory table, and the merge/promote
// flows that connect a discovered device to the managed catalog.
//
// Extracted from views/directory.ejs (part of the ongoing decomposition of
// that file -- see docs/resources-reimagined.md and the session that started
// splitting it) as a plain classic script, loaded via <script src> alongside
// directory.ejs's own inline <script>. Deliberately NOT wrapped in an IIFE
// and NOT 'use strict': every function here is called directly from
// directory.ejs's markup (onclick="...") and from its page-load bootstrap
// ($(document).ready), so each needs to land as a genuine global (`function`
// declarations do this automatically in a classic, non-module script) --
// exactly as it already behaved living inline. This file has nothing pure to
// unit-test; unlike resource_status.js/resource_facts.js, its whole job is
// DOM/API glue (app.api, app.modal, app.messages, jQuery), so there is no
// dual CommonJS export here. tests/view_integrity.test.js resolves onclick
// targets and checks this file parses, the same as it does for directory.ejs
// itself.
//
// Depends on globals declared in directory.ejs's own script (loaded
// alongside this one, in the same document): `rawResources`, `promoteSlug`,
// `esc`, `loadData`, `openResourceModal`, `updateIconPreview`,
// `toggleFormFields`, `loadLdapGroups`, plus app.*/jQuery/moment from
// top.ejs's bundles. All are `var`/top-level `function` declarations, so
// they attach to `window` and are visible here regardless of script order --
// nothing in this file runs until something calls it (a click, or the
// bootstrap block), by which point every script tag has already executed.

// ── Merge a discovered device into an existing managed resource ────────────

async function openMergeModal(discoveredId, discName) {
  const targets = rawResources.filter(r => r.kind === 'host' || r.kind === 'site' || r.kind === 'service');

  app.modal.open({
    title: `Merge '${esc(discName)}' into Existing Resource`,
    size: 'md',
    bodyHtml: `
      <div class="p-3">
        <p class="small text-muted mb-2">Search and select an existing Directory resource to merge IP addresses, network interfaces, and OS telemetry into:</p>
        <div class="mb-3">
          <input type="text" class="form-control mb-2 shadow-sm" id="merge-search-input" placeholder="🔍 Type to filter resources..." oninput="filterMergeTargets()">
          <input type="hidden" id="merge-target-id" value="${targets[0] ? targets[0].id : ''}">
          <div class="list-group overflow-auto border rounded shadow-sm" id="merge-targets-list" style="max-height: 240px;">
            ${targets.map((r, i) => `
              <button type="button" class="list-group-item list-group-item-action p-2 merge-item-btn ${i===0 ? 'active' : ''}" data-id="${r.id}" onclick="selectMergeTarget(this)">
                <div class="d-flex justify-content-between align-items-center">
                  <strong>${esc(r.name)}</strong>
                  <span class="badge bg-secondary">${esc(r.kind)}${r.metadata?.subType ? ' · ' + esc(r.metadata.subType) : ''}</span>
                </div>
                ${r.metadata?.ip ? `<small class="font-monospace text-muted d-block">${esc(r.metadata.ip)}</small>` : ''}
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `,
    footer: {
      buttonsHtml: `
        <button class="btn btn-secondary btn-sm" onclick="app.modal.close()">Cancel</button>
        <button class="btn btn-success btn-sm" onclick="submitMergeResource('${discoveredId}')"><i class="fa-solid fa-code-merge me-1"></i> Confirm Merge</button>
      `
    }
  });
}

function filterMergeTargets() {
  const q = ($('#merge-search-input').val() || '').toLowerCase();
  $('#merge-targets-list button').each(function() {
    const text = $(this).text().toLowerCase();
    if (text.includes(q)) {
      $(this).removeClass('d-none');
    } else {
      $(this).addClass('d-none');
    }
  });
}

function selectMergeTarget(btn) {
  $('#merge-targets-list button').removeClass('active');
  $(btn).addClass('active');
  $('#merge-target-id').val($(btn).data('id'));
}

async function submitMergeResource(discoveredId) {
  const targetId = $('#merge-target-id').val();
  if (!targetId) return;
  try {
    app.messages.action('Merging discovered resource...', $('#app-modal-body'), 'info');
    await app.api.post('directory-admin/discovered/merge', { discoveredId, targetId });
    app.messages.action('Resource merged successfully!', null, 'success');
    app.modal.close();
    loadData();
  } catch (err) {
    app.messages.action(err.message || 'Failed to merge resource', $('#app-modal-body'), 'danger');
  }
}

async function ignoreDiscoveredResource(resourceId) {
  const confirmed = await app.messages.confirm('Ignore and dismiss this discovered device?', null, 'warning');
  if (!confirmed) return;
  try {
    await app.api.post('directory-admin/discovered/ignore', { resourceId });
    app.messages.action('Discovered device ignored.', null, 'info');
    loadData();
  } catch (err) {
    app.messages.action(err.message || 'Failed to ignore device', null, 'danger');
  }
}

// ── DISCOVERY SCRIPTS ───────────────────────────────────────────────────────
var allDiscoveryResources = [];

function loadDiscoveryResources() {
  app.api.get('discovery/resources', function(err, res) {
    if(err) {
      $('.actionMessage').html('<div class="alert alert-danger">' + (err.message || 'Error loading resources') + '</div>').show();
      return;
    }
    allDiscoveryResources = res.results || [];
    renderDiscoveryTable();
  });
}
var renderDiscoveryTimer = null;
function scheduleRenderDiscoveryTable(delay = 250) {
  if (renderDiscoveryTimer) clearTimeout(renderDiscoveryTimer);
  renderDiscoveryTimer = setTimeout(function() {
    renderDiscoveryTimer = null;
    renderDiscoveryTable();
  }, delay);
}

function renderDiscoveryTable() {
  const search = $('#discovery-search-filter').val().toLowerCase();
  const showIgnored = $('#discovery-show-ignored').is(':checked');
  const filtered = allDiscoveryResources.filter(r => {
    if (search && !r.name.toLowerCase().includes(search) && !r.slug.toLowerCase().includes(search)) return false;
    // Directory contains managed items; Discovered Inventory only shows unmanaged/pending items awaiting promotion
    const isExplicitManaged = r.metadata && (r.metadata.managed === true || r.metadata.managed === 'true');
    if (isExplicitManaged || r.kind === 'site' || r.kind === 'service') return false;
    const isIgnored = r.metadata && (r.metadata.ignored === true || r.metadata.ignored === 'true');
    if (isIgnored && !showIgnored) return false;
    return true;
  });

  $.scope.discoveryResources.empty();
  for(const r of filtered) {
    // "Unknown IP" was shown for every device whose address is known per-NIC
    // rather than in metadata.ip -- which is most of them, since a source
    // that enumerates interfaces (UniFi, Proxmox guest agent) fills
    // `interfaces[].ip`. Resolve a display address from the NICs so the
    // column agrees with the interface list right beneath it.
    const meta = r.metadata || {};
    const fromNic = (meta.interfaces || []).map(i => i && i.ip).find(Boolean) || null;
    r.displayIp = meta.ip || fromNic;
    $.scope.discoveryResources.push(r);
  }

  if(filtered.length === 0) {
    $('#discovery-list').hide();
    $('#discovery-empty-state').show();
  } else {
    $('#discovery-list').show();
    $('#discovery-empty-state').hide();
  }
}

// Promoting a discovered resource opens the resource form pre-filled with the
// discovered data so it can be reviewed before the resource is marked managed
// (and its LDAP groups created). The modal's Save (saveResource) sees
// promoteSlug set and calls the promote endpoint instead of a normal save.
function promoteResource(slug) {
  const r = allDiscoveryResources.find(x => x.slug === slug);
  if (!r) { app.messages.toast('Discovered resource not found', 'danger'); return; }
  promoteSlug = slug;
  openResourceModal('Promote Resource', null); // add-mode: groups/children tabs hidden
  const m = r.metadata || {};
  $('#res-name').val(r.name || '');
  $('#res-slug').val(r.slug || '');
  $('#res-kind').val(r.kind || 'host');
  $('#res-description').val(r.description || '');
  $('#res-ip').val(m.ip || '');
  $('#res-address').val(m.address || '');
  $('#res-subtype').val(m.subType || '');
  $('#res-mac').val(m.macAddress || '');
  $('#res-port').val(m.port || '');
  $('#res-external-port').val(m.externalPort || '');
  $('#res-icon').val(m.icon || '');
  $('#res-tagline').val(m.tagline || '');
  updateIconPreview();
  toggleFormFields();
  loadLdapGroups();
}

// ── Discovery plugin admin (instances + types) ──────────────────────────────

var discoveryPlugins = [];

function loadDiscoveryPlugins() {
  app.api.get('plugins', function(err, res) {
    if (err) return;
    discoveryPlugins = (res.results || []).filter(p => p.category === 'discovery');
    renderDiscoveryPlugins();
  });
}

function renderDiscoveryPlugins() {
  const $list = $('#discovery-plugins-list').empty();
  if (discoveryPlugins.length === 0) {
    $list.append('<div class="text-muted text-center py-4"><i class="fa-solid fa-plug fs-2 mb-2 text-black-50"></i><br>No discovery plugins configured.</div>');
    return;
  }
  discoveryPlugins.forEach(p => {
    const badgeClass = p.enabled ? 'bg-success' : 'bg-secondary';
    const statusText = p.enabled ? 'Loaded' : 'Unloaded';
    // Last-run state is surfaced by the plugins API (lastRunAt/lastStatus/
    // lastError/lastLog) but was dropped here; show it so a plugin that errors
    // is visible without digging into logs.
    const runOk = p.lastStatus === 'ok';
    const runErr = p.lastStatus === 'error';
    const runState = p.lastRunAt
      ? `<span class="badge ${runOk ? 'bg-success' : runErr ? 'bg-danger' : 'bg-secondary'}" ${runErr && p.lastError ? 'title="' + esc(p.lastError) + '"' : ''}>${runOk ? 'ok' : runErr ? 'error' : esc(p.lastStatus) || 'ran'}</span> <span class="text-muted">${fmtRunTs(p.lastRunAt)}</span>`
      : '<span class="text-muted">Never run</span>';
    const logsBtn = (p.lastLog || p.lastError)
      ? `<button class="btn btn-sm btn-outline-secondary" title="View run log" onclick="showPluginLog('${p.id}')"><i class="fa-solid fa-scroll"></i> Logs</button>`
      : '';
    const card = `
      <div class="card mb-3 border shadow-sm">
        <div class="card-body d-flex align-items-center justify-content-between">
          <div>
            <h6 class="mb-1"><strong>${p.name}</strong> <span class="badge bg-secondary ms-2">${p.pluginType}</span></h6>
            <div class="small text-muted font-monospace">${p.slug} | Schedule: ${p.cron}</div>
            <div class="small">Last run: ${runState}</div>
          </div>
          <div class="d-flex align-items-center gap-2">
            <span class="badge ${badgeClass} me-2">${statusText}</span>
            ${logsBtn}
            <button class="btn btn-sm btn-outline-secondary" title="Edit" onclick="openEditDiscoveryPluginModal('${p.id}')"><i class="fa-solid fa-pen"></i> Edit</button>
            <button class="btn btn-sm btn-outline-primary" onclick="toggleDiscoveryPlugin('${p.id}', ${!p.enabled})">${p.enabled ? 'Unload' : 'Load'}</button>
            <button class="btn btn-sm btn-success" title="Run now" onclick="runDiscoveryPluginNow('${p.id}')"><i class="fa-solid fa-play"></i> Run</button>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteDiscoveryPlugin('${p.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      </div>
    `;
    $list.append(card);
  });
}

// "Never run" when a discovery plugin has no run yet; otherwise relative time.
function fmtRunTs(ts) {
  if (!ts) return 'Never run';
  const m = moment(ts);
  return m.isValid() ? m.fromNow() : 'Never run';
}

// Modal showing the discovery plugin's last run log + error (from the plugins
// API's lastLog/lastError fields). Logs can be long, so render in a scrollable
// <pre> rather than a toast.
function showPluginLog(id) {
  const p = discoveryPlugins.find(x => x.id === id);
  if (!p) return;
  const body = p.lastError
    ? `<div class="alert alert-danger mb-2">${esc(p.lastError)}</div>`
    : '';
  const log = p.lastLog || '(no log captured for this run)';
  app.modal.open({
    title: 'Run log — ' + (p.name || p.slug),
    size: 'lg',
    bodyHtml: body + '<pre class="p-2 mb-0 bg-light border" style="max-height:55vh;overflow:auto;white-space:pre-wrap;font-size:.85rem;">' + esc(log) + '</pre>',
  });
}

async function toggleDiscoveryPlugin(id, state) {
  const endpoint = state ? 'load' : 'unload';
  try {
    await app.api.post(`plugins/${id}/${endpoint}`, {});
    app.messages.toast(`Discovery plugin ${state ? 'loaded' : 'unloaded'}`, 'success');
    loadDiscoveryPlugins();
  } catch (e) {
    app.messages.toast('Error toggling plugin: ' + e.message, 'danger');
  }
}

async function runDiscoveryPluginNow(id) {
  try {
    await app.api.post(`plugins/${id}/run`, {});
    app.messages.toast('Enqueued discovery plugin run', 'success');
    loadDiscoveryPlugins();
  } catch (e) {
    app.messages.toast('Error running plugin: ' + e.message, 'danger');
  }
}

var discoveryPluginTypes = [];

// ── Discovery plugin config helpers (ported from plugins.ejs) ─────────────
// Stored value is always a 5-field cron string; the dropdown picks a preset
// and "Custom…" reveals the raw input. Config fields are driven by each
// plugin type's configSchema so per-plugin settings (e.g. Proxmox url /
// tokenId / tokenSecret) are collected at create time.
var DP_CRON_PRESETS = [
  { key: 'hourly', label: 'Hourly',           cron: '0 * * * *' },
  { key: 'daily',  label: 'Daily (midnight)',  cron: '0 0 * * *' },
  { key: 'weekly', label: 'Weekly (Sun)',      cron: '0 0 * * 0' },
  { key: 'custom', label: 'Custom…',           cron: null },
];
function dpCronKeyFor(cron) {
  var m = DP_CRON_PRESETS.filter(function(p){ return p.cron === cron; })[0];
  return m ? m.key : 'custom';
}
function dpCronSelectHtml(prefix, current) {
  current = current || '0 * * * *';
  var key = dpCronKeyFor(current);
  var opts = DP_CRON_PRESETS.map(function(p){
    return '<option value="' + p.key + '"' + (p.key === key ? ' selected' : '') + '>' + p.label + '</option>';
  }).join('');
  var rawStyle = key === 'custom' ? '' : ' style="display:none"';
  return '<select class="form-select" id="' + prefix + 'cron-select" onchange="dpOnCronChange(\'' + prefix + '\')">' + opts + '</select>' +
    '<input type="text" class="form-control font-monospace mt-2" id="' + prefix + 'cron" value="' + current + '"' + rawStyle + '>';
}
function dpOnCronChange(prefix) {
  var sel = document.getElementById(prefix + 'cron-select');
  var raw = document.getElementById(prefix + 'cron');
  if (!sel || !raw) return;
  if (sel.value === 'custom') { raw.style.display = ''; }
  else {
    raw.style.display = 'none';
    var preset = DP_CRON_PRESETS.filter(function(p){ return p.key === sel.value; })[0];
    if (preset) raw.value = preset.cron;
  }
}
function dpCronFromForm(prefix) {
  var sel = document.getElementById(prefix + 'cron-select');
  if (sel && sel.value !== 'custom') {
    var preset = DP_CRON_PRESETS.filter(function(p){ return p.key === sel.value; })[0];
    if (preset) return preset.cron;
  }
  var raw = document.getElementById(prefix + 'cron');
  return (raw && raw.value.trim()) || '0 * * * *';
}
// `values` pre-fills the form for edit mode. Secret fields are never returned
// by the API in the clear (they live in OpenBao and come back masked), so
// they are rendered EMPTY with a "leave blank to keep" hint rather than
// prefilled with `********` -- submitting the mask back would otherwise store
// the literal asterisks as the secret.
function dpConfigFormHtml(type, prefix, values) {
  var t = discoveryPluginTypes.filter(function(x){ return x.type === type; })[0];
  var schema = t && t.configSchema;
  if (!schema || !schema.length) return '<p class="text-muted">No configuration fields for this plugin.</p>';
  values = values || {};
  var html = '';
  schema.forEach(function(f) {
    var label = f.label + (f.secret ? ' <span class="text-warning" title="stored in OpenBao"><i class="fa-solid fa-key"></i></span>' : '') + (f.required ? ' <span class="text-danger">*</span>' : '');
    if (f.type === 'boolean' || f.type === 'checkbox' || f.key === 'autoPromote') {
      var isChecked = values[f.key] === true || values[f.key] === 'true' || values[f.key] === 1 || values[f.key] === '1' || (values[f.key] === undefined && f.default !== false);
      html += '<div class="mb-3 form-check">' +
        '<input type="checkbox" class="form-check-input" id="' + prefix + f.key + '"' + (isChecked ? ' checked' : '') + '>' +
        '<label class="form-check-label fw-bold" for="' + prefix + f.key + '">' + label + '</label>' +
      '</div>';
    } else if (f.type === 'site_select' || f.key === 'location') {
      var selectedVal = String(values[f.key] != null ? values[f.key] : (f.default || '')).trim();
      var sites = rawResources.filter(r => r.kind === 'site');
      var siteOpts = '<option value="">(Default Site)</option>';
      sites.forEach(function(s) {
        var sel = (s.name === selectedVal || s.slug === selectedVal || (!selectedVal && s.slug === 'site-default')) ? ' selected' : '';
        siteOpts += '<option value="' + esc(s.name) + '"' + sel + '>' + esc(s.name) + ' (' + esc(s.slug) + ')</option>';
      });
      html += '<div class="mb-3">' +
        '<label class="form-label fw-bold">' + label + '</label>' +
        '<select class="form-select" id="' + prefix + f.key + '">' + siteOpts + '</select>' +
      '</div>';
    } else {
      var inputType = f.type === 'password' ? 'password' : (f.type === 'url' ? 'url' : 'text');
      var req = (f.required && !f.secret) ? ' required' : '';
      var ph = f.placeholder ? (' placeholder="' + esc(f.placeholder) + '"') : '';
      var val = '';
      if (!f.secret && values[f.key] != null) val = ' value="' + esc(values[f.key]) + '"';
      if (f.secret && values.__isEdit) ph = ' placeholder="unchanged — type a new value to replace"';
      html += '<div class="mb-3"><label class="form-label fw-bold">' + label + '</label>' +
        '<input type="' + inputType + '" class="form-control" id="' + prefix + f.key + '"' + req + ph + val + '></div>';
    }
  });
  return html;
}
function dpCollectConfig(type, prefix) {
  var t = discoveryPluginTypes.filter(function(x){ return x.type === type; })[0];
  var schema = t && t.configSchema;
  var out = {};
  if (!schema) return out;
  schema.forEach(function(f) {
    var el = document.getElementById(prefix + f.key);
    if (el) {
      if (f.type === 'boolean' || f.type === 'checkbox' || el.type === 'checkbox') {
        out[f.key] = el.checked;
      } else {
        out[f.key] = el.value;
      }
    }
  });
  return out;
}
function dpRenderFields() {
  var type = document.getElementById('new-plugin-type').value;
  document.getElementById('new-plugin-config-fields').innerHTML = dpConfigFormHtml(type, 'np-');
}

function openNewDiscoveryPluginModal() {
  app.api.get('plugins/types', function(err, res) {
    if (err) { app.messages.toast('Error loading plugin types: ' + err.message, 'danger'); return; }
    discoveryPluginTypes = (res.results || []).filter(t => t.category === 'discovery');
    if (discoveryPluginTypes.length === 0) {
      app.messages.toast('No discovery plugin types available', 'warning');
      return;
    }

    const options = discoveryPluginTypes.map(t => `<option value="${t.type}">${t.name} (${t.type})</option>`).join('');
    const bodyHtml = `
      <div class="mb-3">
        <label class="form-label fw-bold">Plugin Type</label>
        <select id="new-plugin-type" class="form-select shadow-sm" onchange="dpRenderFields()">${options}</select>
      </div>
      <div class="mb-3">
        <label class="form-label fw-bold">Instance Name</label>
        <input type="text" id="new-plugin-name" class="form-control shadow-sm" placeholder="e.g. Local Subnet Scanner">
        <div class="form-text">A slug is derived automatically from the name.</div>
      </div>
      <div class="mb-3">
        <label class="form-label fw-bold">Schedule</label>
        ${dpCronSelectHtml('np-', '0 * * * *')}
      </div>
      <div class="form-check mb-3">
        <input class="form-check-input" type="checkbox" id="new-plugin-enabled" checked>
        <label class="form-check-label fw-semibold" for="new-plugin-enabled">Enable (load on create)</label>
      </div>
      <hr><h6 class="fw-bold">Configuration</h6><div id="new-plugin-config-fields">${dpConfigFormHtml(discoveryPluginTypes[0].type, 'np-')}</div>
      <div class="d-flex justify-content-end gap-2">
        <button class="btn btn-secondary" onclick="app.modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="saveNewDiscoveryPlugin()">Create Plugin</button>
      </div>
    `;

    app.modal.open({
      title: 'Configure New Discovery Plugin',
      bodyHtml: bodyHtml,
      size: 'lg'
    });
  });
}

// Edit an existing instance. Non-secret config goes to PUT /plugins/:id;
// secrets go to PUT /plugins/:id/secrets and only when the operator actually
// typed a new value -- they are two endpoints because the DB row must never
// hold a secret (see routes/api_plugins.js).
function openEditDiscoveryPluginModal(id) {
  const p = discoveryPlugins.find(x => x.id === id);
  if (!p) return;
  app.api.get('plugins/types', function(err, res) {
    if (err) { app.messages.toast('Error loading plugin types: ' + err.message, 'danger'); return; }
    discoveryPluginTypes = (res.results || []).filter(t => t.category === 'discovery');
    const values = Object.assign({}, p.config || {}, { __isEdit: true });
    const bodyHtml = `
      <div class="mb-3">
        <label class="form-label fw-bold">Plugin Type</label>
        <input type="text" class="form-control" value="${esc(p.pluginType)}" disabled>
        <div class="form-text">The type is fixed once an instance exists — create a new instance to use a different one.</div>
      </div>
      <div class="mb-3">
        <label class="form-label fw-bold">Instance Name</label>
        <input type="text" id="edit-plugin-name" class="form-control shadow-sm" value="${esc(p.name)}">
        <div class="form-text">Slug <code>${esc(p.slug)}</code> is stable and does not change.</div>
      </div>
      <div class="mb-3">
        <label class="form-label fw-bold">Schedule</label>
        ${dpCronSelectHtml('ep-', p.cron)}
      </div>
      <div class="form-check mb-3">
        <input class="form-check-input" type="checkbox" id="edit-plugin-enabled" ${p.enabled ? 'checked' : ''}>
        <label class="form-check-label fw-semibold" for="edit-plugin-enabled">Loaded (runs on its schedule)</label>
      </div>
      <hr><h6 class="fw-bold">Configuration</h6>
      <div id="edit-plugin-config-fields">${dpConfigFormHtml(p.pluginType, 'ep-', values)}</div>
      <div class="d-flex justify-content-end gap-2">
        <button class="btn btn-secondary" onclick="app.modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedDiscoveryPlugin('${p.id}')">Save changes</button>
      </div>
    `;
    app.modal.open({ title: 'Edit Discovery Plugin — ' + p.name, bodyHtml: bodyHtml, size: 'lg' });
  });
}

async function saveEditedDiscoveryPlugin(id) {
  const p = discoveryPlugins.find(x => x.id === id);
  if (!p) return;
  const name = ($('#edit-plugin-name').val() || '').trim();
  if (!name) { app.messages.toast('Name is required', 'warning'); return; }

  const flat = dpCollectConfig(p.pluginType, 'ep-');
  const type = discoveryPluginTypes.find(t => t.type === p.pluginType);
  const schema = (type && type.configSchema) || [];

  // Split by the schema so a secret never rides along in the DB payload, and
  // an untouched secret field is not sent at all.
  const config = {};
  const secrets = {};
  schema.forEach(f => {
    const v = flat[f.key];
    if (f.secret) { if (v) secrets[f.key] = v; }
    else config[f.key] = v;
  });

  try {
    await app.api.put(`plugins/${id}`, {
      name,
      cron: dpCronFromForm('ep-'),
      enabled: $('#edit-plugin-enabled').is(':checked'),
      config
    });
    if (Object.keys(secrets).length) await app.api.put(`plugins/${id}/secrets`, secrets);
    app.modal.close();
    app.messages.toast('Plugin updated', 'success');
    loadDiscoveryPlugins();
  } catch (e) {
    app.messages.toast('Error saving plugin: ' + (e.message || e), 'danger');
  }
}

// Was referenced by the card's trash button but never defined, so clicking it
// only threw a ReferenceError -- delete appeared to do nothing.
async function deleteDiscoveryPlugin(id) {
  const p = discoveryPlugins.find(x => x.id === id);
  const label = p ? (p.name || p.slug) : 'this plugin';
  const $card = $('#plugins-tab-pane');
  const confirmed = await app.messages.confirm(
    `Delete discovery plugin "${label}"? Its schedule stops and its stored secrets are removed. Resources it already discovered stay in the Directory.`,
    $card, 'warning');
  if (!confirmed) return;
  try {
    await app.api.delete(`plugins/${id}`);
    app.messages.toast('Plugin deleted', 'success');
    loadDiscoveryPlugins();
  } catch (e) {
    app.messages.toast('Error deleting plugin: ' + (e.message || e), 'danger');
  }
}

async function saveNewDiscoveryPlugin() {
  const type = $('#new-plugin-type').val();
  const name = $('#new-plugin-name').val().trim();
  const cron = dpCronFromForm('np-');
  const enabled = $('#new-plugin-enabled').is(':checked');
  const config = dpCollectConfig(type, 'np-');

  if (!type) return app.messages.action('Select a plugin type.', app.modal.body(), 'danger');
  if (!name) return app.messages.action('Name is required', app.modal.body(), 'danger');

  try {
    await app.api.post('plugins', {
      pluginType: type,
      name,
      cron,
      enabled,
      config
    });
    app.messages.toast('Discovery plugin created successfully!', 'success');
    app.modal.close();
    loadDiscoveryPlugins();
  } catch (e) {
    app.messages.action('Error creating plugin: ' + e.message, app.modal.body(), 'danger');
  }
}
