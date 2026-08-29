'use strict';

// What a port scan may conclude about a host.
//
// The rule that matters is the failure mode: an unclassified device must not
// end up ssh-capable. nmap used to emit NO subType, and an empty subType is in
// SSH_CAPABLE_HOST_SUBTYPES, so every printer, camera and switch a scan turned
// up was quietly offered as a jump target.

const nmap = require('../plugins/discovery/nmap');
const { templateFor, _setTemplateCache } = require('../services/subtype_templates');
const { SubtypeTemplate } = require('../models/subtype_template');

const host = (osNmap, ports = []) => ({
  ip: '10.0.0.5',
  osNmap,
  openPorts: ports.map(p => (typeof p === 'number' ? { port: p, service: '' } : p))
});

describe('classifyHost', () => {
  test('reads the OS banner when nmap gives one', () => {
    expect(nmap.classifyHost(host('Linux 5.4.0'))).toBe('linux');
    expect(nmap.classifyHost(host('Microsoft Windows Server 2019'))).toBe('windows');
    expect(nmap.classifyHost(host('MikroTik RouterOS 7'))).toBe('router');
    expect(nmap.classifyHost(host('pfSense 2.7'))).toBe('pfsense');
    expect(nmap.classifyHost(host('Cisco Catalyst switch'))).toBe('switch');
    expect(nmap.classifyHost(host('Ubiquiti UniFi access point'))).toBe('ap');
    expect(nmap.classifyHost(host('HP Integrated Lights-Out 5'))).toBe('bmc');
    expect(nmap.classifyHost(host('Axis camera'))).toBe('camera');
  });

  test('falls back to characteristic ports', () => {
    expect(nmap.classifyHost(host(null, [8006]))).toBe('proxmox');
    expect(nmap.classifyHost(host(null, [9100]))).toBe('printer');
    expect(nmap.classifyHost(host(null, [3389]))).toBe('windows');
    expect(nmap.classifyHost(host(null, [554]))).toBe('camera');
  });

  test('SSH alone is not enough to call something a Linux server', () => {
    // A switch, a NAS and a firewall all answer on 22.
    expect(nmap.classifyHost(host(null, [22]))).toBe('unknown');
    expect(nmap.classifyHost(host(null, [22, 80]))).toBe('unknown');
  });

  test('nothing to go on is `unknown`, not a guess', () => {
    expect(nmap.classifyHost(host(null, []))).toBe('unknown');
    expect(nmap.classifyHost({})).toBe('unknown');
  });

  test('an RDP host that also answers on 22 is not called Windows', () => {
    expect(nmap.classifyHost(host(null, [22, 3389]))).toBe('unknown');
  });
});

describe('classification fails closed', () => {
  const bySlug = new Map(SubtypeTemplate.defaults().map(t => [t.slug, t]));

  afterEach(() => _setTemplateCache(null));

  test('every subtype the classifier can return has a template', () => {
    const reachable = ['linux', 'windows', 'router', 'pfsense', 'switch', 'ap',
      'bmc', 'camera', 'printer', 'proxmox', 'unknown'];
    expect(reachable.filter(s => !bySlug.has(s))).toEqual([]);
  });

  test('an unclassified host is never offered as a jump target', () => {
    const unclassified = { kind: 'host', metadata: { subType: nmap.classifyHost({}) } };
    expect(templateFor(unclassified).sshCapable).toBe(false);

    _setTemplateCache(Object.fromEntries(SubtypeTemplate.defaults().map(t =>
      [t.slug, { sshCapable: Boolean(t.ssh_capable), inheritsHost: Boolean(t.inherits_host_access) }])));
    expect(templateFor(unclassified).sshCapable).toBe(false);
  });

  test('the network gear a scan finds is never ssh-capable either', () => {
    for (const os of ['HP JetDirect', 'Axis camera', 'Cisco Catalyst switch', 'HP Integrated Lights-Out 5']) {
      const subType = nmap.classifyHost(host(os));
      expect(templateFor({ kind: 'host', metadata: { subType } }).sshCapable).toBe(false);
    }
  });
});
