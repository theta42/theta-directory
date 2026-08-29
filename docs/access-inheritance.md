---
layout: default
title: Access Inheritance
nav_order: 4
---

# Access Inheritance

[← Back to Home](index.html)

Ownership propagates **down** the resource tree. Granting someone a site grants
them what is in it, without anyone re-granting it at every level.

This is the mirror of [environment bubbling](status-rules.html#environment-vs-bubbled_environment),
which goes the other way: a resource is as critical as the most critical thing
*under* it, and as accessible as the least restrictive grant *above* it.

## The rule

A grant is a row linking a resource to an LDAP group at an access level:
`(resourceId, groupCn, accessLevel)`. Your **effective** level on a resource is
the strongest level granted on that resource *or on any of its ancestors*.

```
office        ← alice granted "admin" here
└── cluster0     alice is admin
    └── dl380    alice is admin
        └── gitea  alice is admin
```

One grant, four resources. Before this existed, reaching `gitea` meant a row on
`gitea`, and an estate of any size was unmanageable.

Inheritance follows **graph edges only**. `metadata.hostId` is a denormalised
convenience the discovery reconciler writes; access does not follow it, because
nothing keeps it in step with the graph.

## Grants are additive — there is no deny

A weaker grant on a child does **not** reduce what an ancestor gave.

```
office        ← alice granted "admin"
└── dl380     ← alice also granted "viewer"
    alice is still admin on dl380.
```

This surprises people, so it is worth being explicit about why it works this
way. The alternative — letting a child row override an ancestor downward — is a
deny mechanism, and a deny mechanism that only *looks* like it works is worse
than not having one. An operator who "restricted" a host by adding a viewer row
would believe they had taken away an admin they in fact still hold through the
site.

**To reduce someone's access, remove the ancestor grant.** There is no way to
carve an exception out of an inherited grant, by design.

What a deeper grant *can* do is raise the level for its own subtree:

```
office        ← team granted "viewer"      → viewer on office, cluster0, nas
└── cluster0
    └── dl380  ← team granted "admin"      → admin on dl380 and everything under it
```

## Levels

Ranked weakest to strongest: `viewer` = `member` < `access` < `admin` < `owner`.
Comparison is case-insensitive, and a level the system does not recognise ranks
below all of them rather than above.

## Roster groups grant nothing below themselves

A site carries a `{site}_everyone` group — "all users at this site" — and it is
linked to the site resource so it can be managed from the site's modal. Every
user at the site is in it.

That link is a **roster**, not a grant, and inheritance skips it. Propagating it
would hand every user at a site access to every resource in that site, which is
the opposite of what a roster is for. `utils/groups.js` `hasPermission()` has
always excluded these meta groups; inheritance follows the same rule.

The same applies to the global `everyone`.

## What inheritance does not do

* **It does not travel sideways or upward.** A grant on `gitea` reaches `gitea`
  and nothing else — not its host, not its siblings.
* **It does not promote discovered resources into the catalog.** A resource that
  discovery found and nobody promoted stays invisible no matter who is granted
  its site. Discovery output is not catalog content.
* **It does not travel through roster groups.** See above.
* **It does not bypass the agent and jump-target rules.** Reachability through
  an enrolled `theta-agent`, and whether a subtype is ssh-capable at all, are
  separate questions answered in `services/access_projection.js` and
  [subtype templates](subtype-templates.html).

## Seeing it

In the directory tree's **Access** column:

* a **blue** badge is a grant on that resource itself;
* a **grey ↳ inherited** badge is a grant that reaches it from an ancestor;
* **via host** means a service whose access follows the host running it (a
  systemd unit is not an access boundary of its own);
* **no groups** means genuinely nothing grants it.

The read-only view of a resource lists both, so you can tell at a glance whether
an access came from here or from somewhere above.

`GET /api/directory-admin/access-summary` returns the same split, per resource:
`groups` for direct rows and `inherited` for the rest.

## Where it lives

`services/access_inheritance.js` computes effective grants; a breadth-first walk
down from each granted resource, revisiting a node only when arriving with a
stronger level, which both terminates on cycles and resolves the case where two
ancestors grant different levels.

`services/access_projection.js` consumes it for `GET /api/discovery/me` and
`GET /api/discovery/access/:uid` — the two endpoints that must agree, since the
first is what a person sees in the Directory and the second is what the SSH
jump host offers them.

One consequence worth calling out: a **site super admin** now reaches every
resource at their site through `/me`. `hasPermission()` has always said they
have permission there, but the projection previously only consulted it for hosts
running a theta-agent, so `/me` was stricter than the permission model it
implements. That is now consistent.
