'use strict';

const { FilterParser, PresenceFilter } = require('ldapts');
const { hasPermission } = require('./groups');

function parseGroupCn(cn) {
  const kindMatch = cn.match(/_(host|app|hosts|apps|super)_/);
  if (!kindMatch) return null;
  
  const kindStr = kindMatch[1];
  const site = cn.substring(0, kindMatch.index);
  const rest = cn.substring(kindMatch.index + kindMatch[0].length);
  
  if (kindStr === 'super' && rest === 'admin') {
    return { site, kind: 'site', slug: null, level: 'admin' };
  }
  
  if (kindStr === 'hosts' || kindStr === 'apps') {
    const kind = kindStr === 'hosts' ? 'host' : 'app';
    return { site, kind, slug: null, level: rest };
  }
  
  if (kindStr === 'host' || kindStr === 'app') {
    const underIdx = rest.lastIndexOf('_access') !== -1 ? rest.lastIndexOf('_access') : rest.lastIndexOf('_admin');
    if (underIdx === -1) {
      // opaque capability
      const underIdx2 = rest.lastIndexOf('_');
      if (underIdx2 === -1) return null;
      const slug = rest.substring(0, underIdx2);
      const level = rest.substring(underIdx2 + 1);
      return { site, kind: kindStr, slug, level };
    }
    const slug = rest.substring(0, underIdx);
    const level = rest.substring(underIdx + 1);
    return { site, kind: kindStr, slug, level };
  }
  return null;
}

function interceptVirtualGroups(filterString) {
  let f;
  try {
    f = FilterParser.parseString(filterString);
  } catch (err) {
    return { modifiedFilter: filterString, virtualGroups: [] };
  }

  const virtualGroups = [];

  function walk(node, parent, index) {
    if (!node) return;
    if (node.type === 163) { // EqualityFilter
      let cn = null;
      const attribute = node.attribute.toLowerCase();
      
      if (attribute === 'memberof') {
        const m = /^cn=([^,]+)/i.exec(node.value);
        cn = m ? m[1] : node.value;
      } else if (attribute === 'cn') {
        cn = node.value;
      }

      if (cn) {
        const parsed = parseGroupCn(cn);
        if (parsed) {
          virtualGroups.push({ cn, parsed, attribute, originalValue: node.value });
          if (parent && parent.filters) {
            parent.filters.splice(index, 1);
          }
        }
      }
    } else if (node.filters) {
      for (let i = node.filters.length - 1; i >= 0; i--) {
        walk(node.filters[i], node, i);
      }
    }
  }

  walk(f, null, 0);

  // Clean up empty AND filters
  if (f.type === 160 && f.filters.length === 0) {
    f = new PresenceFilter({ attribute: 'objectClass' });
  } else if (f.type === 160 && f.filters.length === 1) {
    f = f.filters[0];
  }

  return { modifiedFilter: f.toString(), virtualGroups };
}

function postFilterEntries(entries, virtualGroups) {
  if (!virtualGroups || virtualGroups.length === 0) return entries;
  
  // If we have a CN query for a virtual group, we might need to synthesize the group entry
  // if it wasn't returned (which it wouldn't be, since it's virtual).
  const cnGroups = virtualGroups.filter(vg => vg.attribute === 'cn');
  for (const vg of cnGroups) {
    if (!entries.find(e => e.cn === vg.cn)) {
      entries.push({
        dn: `cn=${vg.cn},ou=groups,dc=virtual`, // doesn't matter much as long as dn exists
        objectClass: ['top', 'groupOfNames'],
        cn: vg.cn,
        member: ['cn=dummy'] // groupOfNames requires at least one member
      });
    }
  }

  // Filter entries
  return entries.filter(entry => {
    // If it's a synthesized group, keep it
    if (cnGroups.some(vg => vg.cn === entry.cn)) return true;
    
    // For users, check if they have the required virtual groups
    for (const vg of virtualGroups) {
      if (vg.attribute === 'memberof') {
        const memberOf = entry.memberOf || [];
        const memberOfCns = (Array.isArray(memberOf) ? memberOf : [memberOf]).map(dn => {
          const m = /^cn=([^,]+)/i.exec(dn);
          return m ? m[1] : dn;
        });

        const resource = { site: vg.parsed.site, kind: vg.parsed.kind, slug: vg.parsed.slug };
        const has = hasPermission(memberOfCns, resource, vg.parsed.level);
        
        if (!has) {
          return false;
        } else {
          if (!entry.memberOf) entry.memberOf = [];
          if (!Array.isArray(entry.memberOf)) entry.memberOf = [entry.memberOf];
          // Inject the requested group DN so the client sees what it asked for
          if (!entry.memberOf.includes(vg.originalValue)) {
            entry.memberOf.push(vg.originalValue);
          }
        }
      }
    }
    return true;
  });
}

module.exports = {
  parseGroupCn,
  interceptVirtualGroups,
  postFilterEntries
};
