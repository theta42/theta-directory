const { Model } = require('@simpleworkjs/orm');
const crypto = require('crypto');

class SubtypeTemplate extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    slug: { type: 'string', isRequired: true, unique: true },
    name: { type: 'string', isRequired: true },
    target_kind: { type: 'string', isRequired: true }, // 'site', 'host', or 'service'
    // Where in the hierarchy this subtype may be created. `valid_parent_types`
    // constrains the parent's KIND ('site' | 'host' | 'service'); an empty list
    // means anywhere. `valid_parent_subtypes` narrows that further to specific
    // parent subtypes, which is how `proxmox-lxc` is confined to a
    // `server-proxmox` and cannot be hung off a laptop.
    valid_parent_types: { type: 'json', default: [] },
    valid_parent_subtypes: { type: 'json', default: [] },
    schema: { type: 'json', default: {} }, // JSON Schema for dynamic form rendering and validation
    status_rules: { type: 'json', default: [] }, // Rules for evaluating telemetry into a status
    // Capabilities that used to be hardcoded Sets in services/subtype_templates.js.
    // `ssh_capable`: is this a machine you get a shell on, and therefore
    //   offerable as a jump target at all.
    // `inherits_host_access`: is access to this decided by access to its host,
    //   rather than by groups of its own. True for the things an agent reports
    //   (a systemd unit is not an access boundary) and false for a catalog
    //   entry an operator modelled.
    ssh_capable: { type: 'boolean', default: false },
    inherits_host_access: { type: 'boolean', default: false },
    // Which resources this one may be MERGED with by discovery. Defaults to
    // `target_kind`, which is right for almost everything: a discovered host
    // may fold into an existing host, never into a service of the same name.
    //
    // The exception is an out-of-band controller. An iLO's NIC is a different
    // device from the server's, on a different network, and merging the two by
    // MAC or IP misrepresents one address as the other. That guard used to be
    // implemented by giving the resource a fake `kind: 'bmc'` -- which worked,
    // but cost it access groups, a place in the host tree, and every other
    // behaviour keyed on kind. It is an identity rule, so it lives here.
    identity_class: { type: 'string' },
    description: { type: 'string' },
    // Groups the subtype picker. Purely presentational -- a vocabulary this
    // size is unusable as one flat list, even filtered by kind and parent.
    category: { type: 'string' },
    icon: { type: 'string' }, // e.g. fa-solid fa-server
    created_on: { type: 'integer' },
    updated_on: { type: 'integer' }
  };

  // The shipped vocabulary.
  //
  // These are DEFAULTS, not constants: they are seeded when missing and never
  // overwritten, so an operator's edits survive restarts and they can add
  // whatever else their estate contains. What is here is the set the rest of
  // the codebase already emits or reasons about -- every subType written by a
  // discovery plugin, by the agent, or named in docs/resources-reimagined.md --
  // so that the directory has a template for everything it can actually
  // produce, rather than a handful of examples.
  static defaults() {
    // Rules are evaluated in order, first match wins, so the "no data" case has
    // to come before the thresholds: on a host with no agent every telemetry
    // path is undefined, and `undefined > 80` is false, which would otherwise
    // read as healthy. See docs/status-rules.md.
    const machineRules = [
      { condition: 'telemetry.cpu_usage_percent == null', status: 'unknown', message: 'No telemetry reported yet' },
      { condition: 'telemetry.disk_usage_percent > 90', status: 'critical', message: 'Disk nearly full' },
      { condition: 'telemetry.ram_usage_percent > 95', status: 'critical', message: 'Memory exhausted' },
      { condition: 'telemetry.cpu_usage_percent > 80 || telemetry.ram_usage_percent > 80', status: 'warning', message: 'High load' },
      { condition: 'telemetry.disk_usage_percent > 80', status: 'warning', message: 'Disk filling up' },
      { condition: 'true', status: 'ok', message: 'Healthy' }
    ];

    // A guest or appliance the directory only ever hears about second-hand,
    // through a hypervisor or BMC API. Power state is all we know.
    const powerRules = [
      { condition: "metadata.powerState == null", status: 'unknown', message: 'Power state unknown' },
      { condition: "metadata.powerState == 'running' || metadata.powerState == 'On'", status: 'ok', message: 'Running' },
      { condition: 'true', status: 'warning', message: 'Not running' }
    ];

    // Something the agent reports the unit state of.
    const unitRules = [
      { condition: 'metadata.last_seen == null', status: 'unknown', message: 'Never reported' },
      { condition: 'true', status: 'ok', message: 'Registered' }
    ];

    // A plugin-polled endpoint: the plugin's own last run is the signal.
    const pluginRules = [
      { condition: 'plugin == null', status: 'unknown', message: 'No plugin has reported on this' },
      { condition: "plugin == 'ok'", status: 'ok', message: 'Reachable' },
      { condition: 'true', status: 'critical', message: 'Last poll failed' }
    ];

    const site = (slug, name, description, icon, category = 'Sites') => ({
      slug, name, description, icon, category,
      target_kind: 'site', valid_parent_types: [], valid_parent_subtypes: []
    });

    // Every host that is a machine with a shell shares one shape.
    const machine = (slug, name, description, icon, parentSubtypes = [], category = 'Machines', schema = null) => ({
      slug, name, description, icon, category,
      target_kind: 'host',
      valid_parent_types: parentSubtypes.length ? ['host'] : ['site', 'host'],
      valid_parent_subtypes: parentSubtypes,
      ssh_capable: true,
      status_rules: machineRules,
      ...(schema ? { schema } : {})
    });

    // Fields shared by every machine you get a shell on. NOT `port` or
    // `address` -- the main resource form already has inputs for those, and a
    // template that re-declares a platform key gets it skipped in the UI
    // (PLATFORM_METADATA_KEYS in views/directory.ejs).
    const shellFields = {
      properties: {
        sshPort: { type: 'number', description: 'SSH port', default: 22 },
        sshUser: { type: 'string', description: 'Default SSH user' },
        serial: { type: 'string', description: 'Serial number' },
        location: { type: 'string', description: 'Physical location (rack, room)' }
      }
    };

    // Network gear and out-of-band controllers: never a shell, whatever else
    // is true of them.
    const appliance = (slug, name, description, icon, category = 'Network & appliances') => ({
      slug, name, description, icon, category,
      target_kind: 'host', valid_parent_types: ['site', 'host'], valid_parent_subtypes: [],
      ssh_capable: false,
      status_rules: pluginRules
    });

    // A leaf an agent reports on its host. Access follows the host.
    const unit = (slug, name, description, icon, schema, category = 'Agent-reported') => ({
      slug, name, description, icon, category,
      target_kind: 'service', valid_parent_types: ['host'], valid_parent_subtypes: [],
      inherits_host_access: true,
      status_rules: unitRules,
      ...(schema ? { schema } : {})
    });

    // A service an operator modelled by hand. Keeps its own groups.
    const app = (slug, name, description, icon, schema, category = 'Applications') => ({
      slug, name, description, icon, category,
      target_kind: 'service', valid_parent_types: ['host'], valid_parent_subtypes: [],
      inherits_host_access: false,
      status_rules: pluginRules,
      ...(schema ? { schema } : {})
    });

    const portField = (label, dflt) => ({ type: 'number', description: label, ...(dflt ? { default: dflt } : {}) });

    return [
      // ── Sites ───────────────────────────────────────────────────────────
      site('suite', 'Suite Site', 'A full theta-suite installation.', 'fa-solid fa-building'),
      site('managed', 'Managed Site', 'A WireGuard node with managed resources, but no full suite deployed.', 'fa-solid fa-network-wired'),
      site('wg-node', 'WireGuard Node', 'A minimal site: just a theta-agent controlling WireGuard.', 'fa-solid fa-shield-halved'),
      site('unmanaged', 'Unmanaged Site', 'A logical container for child resources, without active management.', 'fa-solid fa-folder-open'),
      site('cloud', 'Cloud Region', 'A cloud provider region or account holding managed resources.', 'fa-solid fa-cloud'),
      site('colo', 'Colocation', 'Rented rack space in a shared datacentre.', 'fa-solid fa-warehouse'),
      site('branch', 'Branch Office', 'A staffed office location.', 'fa-solid fa-building-user'),
      site('home', 'Home / Remote', 'A home or otherwise personal location.', 'fa-solid fa-house'),

      // ── Hosts: machines you log into ────────────────────────────────────
      machine('linux', 'Linux Server', 'A Linux host, typically running theta-agent.', 'fa-brands fa-linux', [], 'Machines', shellFields),
      machine('windows', 'Windows Server', 'A Windows host.', 'fa-brands fa-windows', [], 'Machines',
        { properties: {
            rdpPort: { type: 'number', description: 'RDP port', default: 3389 },
            domain: { type: 'string', description: 'AD domain' },
            serial: { type: 'string', description: 'Serial number' },
            location: { type: 'string', description: 'Physical location (rack, room)' }
          } }),
      machine('server', 'Server', 'A physical or virtual server of unspecified OS.', 'fa-solid fa-server', [], 'Machines', shellFields),
      machine('desktop', 'Desktop', 'An end-user workstation.', 'fa-solid fa-desktop', [], 'Machines', shellFields),
      machine('laptop', 'Laptop', 'An end-user portable machine.', 'fa-solid fa-laptop', [], 'Machines', shellFields),
      machine('mac', 'macOS Host', 'A macOS desktop, laptop or server.', 'fa-brands fa-apple', [], 'Machines', shellFields),
      machine('bsd', 'BSD Host', 'A FreeBSD/OpenBSD/NetBSD host.', 'fa-solid fa-terminal', [], 'Machines', shellFields),
      machine('thin-client', 'Thin Client', 'A minimal endpoint that boots to a remote session.', 'fa-solid fa-display'),
      machine('cloud-vm', 'Cloud Instance', 'A VM rented from a cloud provider.', 'fa-solid fa-cloud'),
      machine('k8s-node', 'Kubernetes Node', 'A machine in a Kubernetes cluster.', 'fa-solid fa-dharmachakra'),
      machine('docker-host', 'Container Host', 'A machine whose job is running containers.', 'fa-brands fa-docker'),

      // Hypervisors. `proxmox` is the CLUSTER (the API endpoint) and
      // `hypervisor` one of its nodes -- that is what plugins/discovery/proxmox.js
      // emits, and the two are deliberately distinct: the cluster stands for an
      // endpoint, not a machine.
      { ...machine('proxmox', 'Proxmox Cluster', 'A Proxmox VE cluster, addressed by its API endpoint.', 'fa-solid fa-layer-group'),
        valid_parent_types: ['site'], status_rules: pluginRules, ssh_capable: true,
        schema: { properties: { address: { type: 'string', description: 'API endpoint URL' } } } },
      { ...machine('hypervisor', 'Hypervisor Node', 'One node of a hypervisor cluster.', 'fa-solid fa-server'),
        valid_parent_types: ['site', 'host'], valid_parent_subtypes: ['proxmox'] },
      machine('server-proxmox', 'Proxmox Host', 'A standalone Proxmox VE host.', 'fa-solid fa-server'),
      machine('server-hyperv', 'Hyper-V Host', 'A Windows Hyper-V virtualisation host.', 'fa-brands fa-windows'),
      machine('server-unraid', 'Unraid Host', 'An Unraid storage and virtualisation host.', 'fa-solid fa-hard-drive'),
      machine('esxi', 'VMware ESXi', 'A VMware ESXi hypervisor host.', 'fa-solid fa-server'),
      machine('xcp-ng', 'XCP-ng', 'An XCP-ng / XenServer host.', 'fa-solid fa-server'),
      machine('nas', 'NAS', 'Network-attached storage with a shell (TrueNAS, Synology, Unraid).', 'fa-solid fa-hard-drive', [], 'Storage'),
      machine('truenas', 'TrueNAS', 'A TrueNAS storage host.', 'fa-solid fa-hard-drive', [], 'Storage'),
      machine('synology', 'Synology', 'A Synology DiskStation.', 'fa-solid fa-hard-drive', [], 'Storage'),

      // Guests. Confined to the things that can actually run them.
      { ...machine('lxc', 'LXC Container', 'A Proxmox LXC guest.', 'fa-solid fa-box', ['proxmox', 'hypervisor', 'server-proxmox']),
        status_rules: powerRules },
      { ...machine('vm', 'Virtual Machine', 'A full virtual machine guest.', 'fa-solid fa-display',
          ['proxmox', 'hypervisor', 'server-proxmox', 'server-hyperv', 'server-unraid']),
        status_rules: powerRules },
      { ...machine('proxmox-lxc', 'Proxmox LXC', 'An LXC guest on a Proxmox host.', 'fa-solid fa-box', ['proxmox', 'hypervisor', 'server-proxmox']),
        status_rules: powerRules },
      { ...machine('proxmox-kvm', 'Proxmox KVM', 'A KVM guest on a Proxmox host.', 'fa-solid fa-display', ['proxmox', 'hypervisor', 'server-proxmox']),
        status_rules: powerRules },
      { slug: 'template', name: 'Guest Template', description: 'A hypervisor guest template. Never runs; never a jump target.',
        icon: 'fa-solid fa-clone', category: 'Machines', target_kind: 'host', valid_parent_types: ['host'],
        valid_parent_subtypes: ['proxmox', 'hypervisor', 'server-proxmox'],
        ssh_capable: false,
        status_rules: [{ condition: 'true', status: 'ok', message: 'Template' }] },

      // ── Hosts: appliances and network gear ──────────────────────────────
      appliance('router', 'Router', 'A network router or firewall.', 'fa-solid fa-route'),
      appliance('pfsense', 'pfSense Firewall', 'A pfSense/OPNsense firewall.', 'fa-solid fa-fire'),
      appliance('switch', 'Switch', 'A managed network switch.', 'fa-solid fa-network-wired'),
      appliance('unifi_switch', 'UniFi Switch', 'A UniFi-managed switch.', 'fa-solid fa-network-wired'),
      appliance('ap', 'Wireless Access Point', 'A wireless access point.', 'fa-solid fa-wifi'),
      appliance('unifi_ap', 'UniFi Access Point', 'A UniFi-managed access point.', 'fa-solid fa-wifi'),
      appliance('printer', 'Printer', 'A network printer.', 'fa-solid fa-print'),
      appliance('camera', 'Camera', 'A network camera.', 'fa-solid fa-video'),
      // Out-of-band controllers. `bmc` is the generic; ilo/idrac are vendors.
      // Out-of-band controllers. Their own identity class: the management NIC
      // is not the server's NIC, and folding one into the other by MAC or IP
      // puts the wrong address on both.
      { ...appliance('bmc', 'BMC', 'A generic out-of-band management controller.', 'fa-solid fa-microchip'), identity_class: 'bmc' },
      { ...appliance('ilo', 'HPE iLO', 'An HPE Integrated Lights-Out controller.', 'fa-solid fa-microchip'), identity_class: 'bmc' },
      { ...appliance('idrac', 'Dell iDRAC', 'A Dell Remote Access Controller.', 'fa-solid fa-microchip'), identity_class: 'bmc' },
      appliance('firewall', 'Firewall', 'A dedicated firewall appliance.', 'fa-solid fa-fire'),
      appliance('load-balancer', 'Load Balancer', 'A hardware or appliance load balancer.', 'fa-solid fa-scale-balanced'),
      appliance('modem', 'Modem / ONT', 'A carrier modem or optical terminal.', 'fa-solid fa-satellite-dish'),
      appliance('ups', 'UPS', 'An uninterruptible power supply.', 'fa-solid fa-battery-half', 'Power & environment'),
      appliance('pdu', 'PDU', 'A rack power distribution unit.', 'fa-solid fa-plug', 'Power & environment'),
      appliance('sensor', 'Environmental Sensor', 'A temperature, humidity or door sensor.', 'fa-solid fa-temperature-half', 'Power & environment'),
      appliance('nvr', 'NVR', 'A network video recorder.', 'fa-solid fa-video'),
      appliance('voip-phone', 'VoIP Phone', 'A desk phone.', 'fa-solid fa-phone', 'Endpoints'),
      appliance('media-player', 'Media Player / TV', 'A smart TV or streaming device.', 'fa-solid fa-tv', 'Endpoints'),
      appliance('mobile', 'Mobile Device', 'A phone or tablet on the network.', 'fa-solid fa-mobile-screen', 'Endpoints'),
      appliance('iot', 'IoT Device', 'A small connected device with no general-purpose OS.', 'fa-solid fa-microchip', 'Endpoints'),
      appliance('san', 'SAN', 'A storage area network appliance.', 'fa-solid fa-database', 'Storage'),

      // ── Services the agent reports ──────────────────────────────────────
      // Each of these is a thing the agent can start/stop, and the ONE field
      // that matters is the name it is addressed by -- `unitName` for systemd,
      // the container name for docker. The driver already reads these
      // (drivers/theta_agent_driver.js); until now they could only be set by
      // discovery, never corrected by hand.
      unit('theta-agent', 'Theta Agent', 'The agent enrolment itself, bound to this host.', 'fa-solid fa-shield-halved'),
      unit('systemd', 'Systemd Unit', 'A systemd service on the host.', 'fa-solid fa-gears',
        { properties: {
            unitName: { type: 'string', description: 'Unit name (e.g. nginx.service)' },
            port: portField('Listening Port (optional)'),
            installPath: { type: 'string', description: 'Working Directory / Install Path (optional)' }
          } }),
      unit('systemd-timer', 'Systemd Timer', 'A systemd timer on the host.', 'fa-solid fa-clock',
        { properties: { unitName: { type: 'string', description: 'Timer name (e.g. backup.timer)' } } }),
      unit('openrc', 'OpenRC Service', 'An OpenRC service on the host.', 'fa-solid fa-gears',
        { properties: { unitName: { type: 'string', description: 'Service name' } } }),
      unit('cron', 'Cron Job', 'A scheduled cron job on the host.', 'fa-solid fa-clock',
        { properties: {
            schedule: { type: 'string', description: 'Cron expression' },
            command: { type: 'string', description: 'Command' }
          } }),
      unit('windows-service', 'Windows Service', 'A Windows service on the host.', 'fa-brands fa-windows',
        { properties: { unitName: { type: 'string', description: 'Service name' } } }),
      unit('process', 'Process', 'A bare process the agent watches.', 'fa-solid fa-microchip',
        { properties: { processName: { type: 'string', description: 'Process name' } } }),
      unit('docker', 'Docker Container', 'A Docker container on the host.', 'fa-brands fa-docker',
        { properties: {
            containerName: { type: 'string', description: 'Container name' },
            image: { type: 'string', description: 'Image' },
            port: portField('Mapped Host Port (optional)')
          } }),
      unit('podman', 'Podman Container', 'A Podman container on the host.', 'fa-brands fa-docker',
        { properties: {
            containerName: { type: 'string', description: 'Container name' },
            image: { type: 'string', description: 'Image' },
            port: portField('Mapped Host Port (optional)')
          } }),

      // What a network scan concluded nothing from. NOT ssh_capable: an
      // unclassified device is as likely to be a camera as a server, and
      // `nmap` used to emit no subType at all, which fell through to the
      // ssh-capable default and offered every one of them as a jump target.
      { slug: 'unknown', name: 'Unclassified Host', target_kind: 'host',
        description: 'A host discovery found but could not classify. Set a real subtype once you know what it is.',
        icon: 'fa-solid fa-circle-question', category: 'Unclassified',
        valid_parent_types: ['site', 'host'], valid_parent_subtypes: [],
        ssh_capable: false,
        status_rules: [{ condition: 'true', status: 'unknown', message: 'Unclassified' }] },

      // ── Services an operator models ─────────────────────────────────────
      { ...app('port-forward', 'Port Forward', 'A forwarded port from a site edge to this host.', 'fa-solid fa-arrow-right-arrow-left',
          { properties: {
              targetPort: portField('Internal Port'),
              sourcePort: portField('External Port'),
              protocol: { type: 'string', description: 'Protocol', enum: ['tcp', 'udp'] },
              isExternalReachable: { type: 'boolean', description: 'Reachable externally' }
            }, required: ['targetPort', 'sourcePort'] }),
        inherits_host_access: true,
        status_rules: unitRules },
      app('ssh', 'SSH Service', 'An SSH endpoint and daemon on this host.', 'fa-solid fa-terminal',
        { properties: {
            port: portField('SSH Port', 22),
            unitName: { type: 'string', description: 'Systemd Unit Name (optional)', default: 'sshd.service' }
          } }, 'Remote access'),
      app('git-repo', 'Git Repository App', 'A self-hosted application installed from a git repository.', 'fa-solid fa-code-branch',
        { properties: {
            gitRepo: { type: 'string', description: 'Git Repository URL' },
            branch: { type: 'string', description: 'Branch', default: 'main' },
            installPath: { type: 'string', description: 'Install Path (e.g. /opt/app)' },
            systemdService: { type: 'string', description: 'Associated Systemd Service' },
            port: portField('Listening Port (optional)')
          } }, 'Developer'),

      // OAuth/OIDC clients. A service, not a kind of its own -- see
      // models/oauth_client.js. `valid_parent_types` is ['host', 'service']
      // because a client belongs to the thing it authenticates for (the Proxy's
      // client hangs off the Proxy service), which is one level below a host.
      // No `schema` on these two: redirect URIs, scopes, allowed groups and
      // token TTLs have a purpose-built panel in the resource modal (it also
      // rotates the client secret, which a generic field cannot). Declaring
      // them here as well would render a second set of inputs writing the same
      // keys into `metadata` while the panel writes them top-level for
      // OAuthClient.update -- two controls, one value, last one wins.
      { ...app('oauth', 'OAuth Client', 'An OAuth2/OIDC client registered against this directory.', 'fa-solid fa-key',
          null, 'Identity'),
        valid_parent_types: ['host', 'service'],
        // No <slug>_access/_admin pair of its own. An OAuth client's actual
        // authorization is its own `allowed_groups`, checked at token issue;
        // minting a second, unrelated LDAP group pair per client would be
        // sprawl with no decision behind it -- the same reason a systemd unit
        // gets none. It follows the service it authenticates for.
        inherits_host_access: true },
      { ...app('oidc-client', 'OIDC Client', 'An OpenID Connect relying party.', 'fa-solid fa-id-badge',
          null, 'Identity'),
        valid_parent_types: ['host', 'service'],
        // No <slug>_access/_admin pair of its own. An OAuth client's actual
        // authorization is its own `allowed_groups`, checked at token issue;
        // minting a second, unrelated LDAP group pair per client would be
        // sprawl with no decision behind it -- the same reason a systemd unit
        // gets none. It follows the service it authenticates for.
        inherits_host_access: true },
      { ...app('saml-sp', 'SAML Service Provider', 'A SAML relying party.', 'fa-solid fa-file-signature',
          { properties: {
              entity_id: { type: 'string', description: 'Entity ID' },
              acs_url: { type: 'string', description: 'Assertion Consumer Service URL' }
            } }, 'Identity'),
        valid_parent_types: ['host', 'service'],
        // No <slug>_access/_admin pair of its own. An OAuth client's actual
        // authorization is its own `allowed_groups`, checked at token issue;
        // minting a second, unrelated LDAP group pair per client would be
        // sprawl with no decision behind it -- the same reason a systemd unit
        // gets none. It follows the service it authenticates for.
        inherits_host_access: true },
      app('http', 'HTTP Service', 'An HTTP endpoint on this host.', 'fa-solid fa-globe',
        { properties: { port: portField('HTTP port', 80), address: { type: 'string', description: 'Base URL' } } }),
      app('web', 'Web Application', 'A web application in the catalog.', 'fa-solid fa-globe',
        { properties: {
            port: portField('Internal Port (e.g. 8080)'),
            externalPort: portField('External Port (optional)'),
            address: { type: 'string', description: 'Base / Public URL (https://...)' },
            isExternalReachable: { type: 'boolean', description: 'Reachable Externally' },
            isPublic: { type: 'boolean', description: 'Public (No Auth)' },
            gitRepo: { type: 'string', description: 'Git Repository URL (optional)' },
            installPath: { type: 'string', description: 'Install Path (e.g. /opt/app)' },
            systemdService: { type: 'string', description: 'Systemd Unit Name (optional)' }
          } }, 'Web'),
      app('wireguard', 'WireGuard Tunnel', 'A WireGuard tunnel endpoint.', 'fa-solid fa-shield-halved',
        { properties: { port: portField('Listen port', 51820) } }),
      app('postgresql', 'PostgreSQL', 'A PostgreSQL database server.', 'fa-solid fa-database',
        { properties: { port: portField('Port', 5432) } }),
      app('redis', 'Redis', 'A Redis in-memory store.', 'fa-solid fa-cubes',
        { properties: { port: portField('Port', 6379) } }),
      app('openbao_vault', 'OpenBao Vault', 'An OpenBao secret store.', 'fa-solid fa-vault',
        { properties: { port: portField('Port', 8200) } }),
      app('k8s_deployment', 'Kubernetes Deployment', 'A Kubernetes deployment.', 'fa-solid fa-dharmachakra'),
      app('libvirt', 'libvirt', 'A libvirt virtualisation endpoint.', 'fa-solid fa-display'),
      app('kvm', 'KVM', 'A KVM virtualisation endpoint.', 'fa-solid fa-display'),
      app('zfs_pool', 'ZFS Pool', 'A ZFS storage pool.', 'fa-solid fa-hard-drive'),
      app('unifi', 'UniFi Controller', 'A UniFi network controller.', 'fa-solid fa-wifi',
        { properties: { port: portField('Port', 8443), address: { type: 'string', description: 'Controller URL' } } }),
      // Databases
      app('mysql', 'MySQL / MariaDB', 'A MySQL or MariaDB server.', 'fa-solid fa-database',
        { properties: { port: portField('Port', 3306) } }, 'Databases'),
      app('mongodb', 'MongoDB', 'A MongoDB server.', 'fa-solid fa-database',
        { properties: { port: portField('Port', 27017) } }, 'Databases'),
      app('influxdb', 'InfluxDB', 'A time-series database.', 'fa-solid fa-chart-line',
        { properties: { port: portField('Port', 8086) } }, 'Databases'),
      app('elasticsearch', 'Elasticsearch', 'A search / log index.', 'fa-solid fa-magnifying-glass',
        { properties: { port: portField('Port', 9200) } }, 'Databases'),

      // Web front ends
      app('nginx', 'nginx', 'An nginx web server or reverse proxy.', 'fa-solid fa-globe',
        { properties: { port: portField('Port', 80) } }, 'Web'),
      app('apache', 'Apache httpd', 'An Apache web server.', 'fa-solid fa-globe',
        { properties: { port: portField('Port', 80) } }, 'Web'),
      app('caddy', 'Caddy', 'A Caddy web server.', 'fa-solid fa-globe',
        { properties: { port: portField('Port', 80) } }, 'Web'),
      app('traefik', 'Traefik', 'A Traefik reverse proxy.', 'fa-solid fa-diagram-project',
        { properties: { port: portField('Dashboard port', 8080) } }, 'Web'),
      app('haproxy', 'HAProxy', 'An HAProxy load balancer.', 'fa-solid fa-scale-balanced',
        { properties: { port: portField('Port', 80) } }, 'Web'),

      // Core network services -- the ones an outage is felt everywhere.
      app('dns', 'DNS', 'A DNS resolver or authoritative server.', 'fa-solid fa-signs-post',
        { properties: { port: portField('Port', 53) } }, 'Network services'),
      app('dhcp', 'DHCP', 'A DHCP server.', 'fa-solid fa-network-wired',
        { properties: { port: portField('Port', 67) } }, 'Network services'),
      app('ntp', 'NTP', 'A time server.', 'fa-solid fa-clock',
        { properties: { port: portField('Port', 123) } }, 'Network services'),
      app('smtp', 'SMTP', 'A mail transfer agent.', 'fa-solid fa-envelope',
        { properties: { port: portField('Port', 25) } }, 'Network services'),
      app('ldap', 'LDAP', 'A directory server.', 'fa-solid fa-address-book',
        { properties: { port: portField('Port', 389) } }, 'Network services'),
      app('radius', 'RADIUS', 'A RADIUS authentication server.', 'fa-solid fa-key',
        { properties: { port: portField('Port', 1812) } }, 'Network services'),
      app('syslog', 'Syslog', 'A syslog collector.', 'fa-solid fa-file-lines',
        { properties: { port: portField('Port', 514) } }, 'Network services'),

      // Remote access
      app('rdp', 'RDP', 'A Windows Remote Desktop endpoint.', 'fa-solid fa-desktop',
        { properties: { port: portField('Port', 3389) } }, 'Remote access'),
      app('vnc', 'VNC', 'A VNC endpoint.', 'fa-solid fa-desktop',
        { properties: { port: portField('Port', 5900) } }, 'Remote access'),
      app('openvpn', 'OpenVPN', 'An OpenVPN endpoint.', 'fa-solid fa-shield-halved',
        { properties: { port: portField('Port', 1194) } }, 'Remote access'),
      app('tailscale', 'Tailscale', 'A Tailscale node or subnet router.', 'fa-solid fa-shield-halved', null, 'Remote access'),

      // File sharing
      app('smb', 'SMB / CIFS', 'A Windows file share.', 'fa-solid fa-folder-open',
        { properties: { port: portField('Port', 445) } }, 'Storage'),
      app('nfs', 'NFS', 'An NFS export.', 'fa-solid fa-folder-open',
        { properties: { port: portField('Port', 2049) } }, 'Storage'),
      app('minio', 'MinIO / S3', 'An S3-compatible object store.', 'fa-solid fa-box-archive',
        { properties: { port: portField('Port', 9000) } }, 'Storage'),
      app('ftp', 'FTP / SFTP', 'A file transfer endpoint.', 'fa-solid fa-file-arrow-up',
        { properties: { port: portField('Port', 21) } }, 'Storage'),

      // Messaging
      app('rabbitmq', 'RabbitMQ', 'A RabbitMQ broker.', 'fa-solid fa-envelopes-bulk',
        { properties: { port: portField('Port', 5672) } }, 'Messaging'),
      app('kafka', 'Kafka', 'A Kafka broker.', 'fa-solid fa-envelopes-bulk',
        { properties: { port: portField('Port', 9092) } }, 'Messaging'),
      app('mqtt', 'MQTT', 'An MQTT broker.', 'fa-solid fa-tower-broadcast',
        { properties: { port: portField('Port', 1883) } }, 'Messaging'),

      // Observability
      app('prometheus', 'Prometheus', 'A metrics scraper.', 'fa-solid fa-chart-line',
        { properties: { port: portField('Port', 9090) } }, 'Observability'),
      app('grafana', 'Grafana', 'A dashboard server.', 'fa-solid fa-chart-area',
        { properties: { port: portField('Port', 3000) } }, 'Observability'),
      app('loki', 'Loki', 'A log aggregator.', 'fa-solid fa-file-lines',
        { properties: { port: portField('Port', 3100) } }, 'Observability'),
      app('uptime-monitor', 'Uptime Monitor', 'An availability checker.', 'fa-solid fa-heart-pulse', null, 'Observability'),

      // Developer and media services -- what actually fills a homelab or an
      // SMB rack, and what people most often want a status dot on.
      app('gitea', 'Gitea / Forgejo', 'A self-hosted git forge.', 'fa-brands fa-git-alt',
        { properties: { port: portField('Port', 3000) } }, 'Developer'),
      app('gitlab', 'GitLab', 'A GitLab instance.', 'fa-brands fa-gitlab',
        { properties: { port: portField('Port', 80) } }, 'Developer'),
      app('jenkins', 'Jenkins', 'A CI server.', 'fa-solid fa-gears',
        { properties: { port: portField('Port', 8080) } }, 'Developer'),
      app('registry', 'Container Registry', 'An OCI image registry.', 'fa-brands fa-docker',
        { properties: { port: portField('Port', 5000) } }, 'Developer'),
      app('plex', 'Plex', 'A Plex media server.', 'fa-solid fa-film',
        { properties: { port: portField('Port', 32400) } }, 'Media'),
      app('jellyfin', 'Jellyfin', 'A Jellyfin media server.', 'fa-solid fa-film',
        { properties: { port: portField('Port', 8096) } }, 'Media'),
      app('backup', 'Backup Job', 'A scheduled backup target or job.', 'fa-solid fa-box-archive', null, 'Storage'),

      { ...app('unknown-service', 'Unidentified Service', 'An open port discovery could not name.', 'fa-solid fa-circle-question',
          { properties: { port: portField('Port'), protocol: { type: 'string', description: 'Protocol' } } }, 'Unclassified'),
        status_rules: [{ condition: 'true', status: 'unknown', message: 'Unidentified' }] }
    ];
  }

  // Seed the shipped vocabulary. Idempotent: a slug that already exists is left
  // exactly as it is, so operator edits are never clobbered by a restart.
  static async seedDefaults() {
    const existing = await this.list().catch(() => []);
    const have = new Set(existing.map(t => t.slug));
    let created = 0;
    for (const def of this.defaults()) {
      if (have.has(def.slug)) continue;
      await this.create({
        id: crypto.randomUUID(),
        valid_parent_types: [],
        valid_parent_subtypes: [],
        schema: {},
        status_rules: [],
        ssh_capable: false,
        inherits_host_access: false,
        identity_class: def.identity_class || def.target_kind,
        ...def,
        created_on: Math.floor(Date.now() / 1000)
      }).catch(err => console.warn(`[SubtypeTemplate] could not seed ${def.slug}:`, err.message));
      created++;
    }
    if (created) console.log(`[SubtypeTemplate] seeded ${created} default subtype template(s)`);
    return created;
  }
}

module.exports = { SubtypeTemplate };
