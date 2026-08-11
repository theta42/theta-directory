---
layout: default
title: Importing an existing directory
description: Migrate users and groups from an existing OpenLDAP (or other LDAP) server into SSO Manager from an LDIF export, preserving uidNumber, gidNumber and password hashes.
---

# Importing an existing directory

If you already run an LDAP directory, you do not have to recreate every account
by hand. **Users → Import LDIF** takes a standard LDIF export and walks you
through migrating the accounts and group memberships into this directory.

Two things are preserved exactly, because a migration that loses them is worse
than no migration at all:

- **`uidNumber` and `gidNumber`.** Every file on every host is owned by a
  number, not a name. If an account arrives with a different uidNumber, every
  file it owns becomes someone else's — so the importer never reallocates. A
  number that is already taken here blocks that account instead.
- **Password hashes.** Passwords are carried across as the stored hash, never
  re-hashed and never reset, so people keep the password they already have.

## Before you start

> **Import into a directory that has no users yet.**
>
> This is the supported procedure, and you should treat it as a requirement.
> The import runs as your admin account, which is the only account that should
> exist when you begin. Any source account whose username, `uidNumber` or
> `gidNumber` collides with something already here is **blocked** and cannot be
> migrated — so importing on top of an existing population produces a
> half-migrated directory you then have to reconcile by hand.
>
> If the account you personally use exists in the export as well, it will be
> blocked by your own admin account. Import first, then log in as your migrated
> account and remove the bootstrap admin.

**Add your hosts and apps first.** This is strongly recommended and it is not
about tidiness. Source groups are **never created** by an import — see
[Why groups are not imported](#why-groups-are-not-imported) below — so they can
only be merged into groups that already exist here. If you import before your
resources exist, there is nothing to map onto and every group has to be dropped.
Set up your [directory and inventory](directory.html) first, let it provision
the access groups, and then import.

## Exporting from the old server

On the machine running the directory you are leaving:

```bash
slapcat -l full.ldif
```

Or, against a running server over the network:

```bash
ldapsearch -x -H ldaps://old-ldap.example.com -D 'cn=admin,dc=example,dc=com' \
  -W -b 'dc=example,dc=com' -LLL '(objectClass=*)' '*' > full.ldif
```

Use an export that includes `userPassword`, which means binding as a user
entitled to read it — usually the directory manager. A dump without password
hashes imports fine, but every account arrives with no password and cannot be
logged into until one is set.

The importer accepts any RFC 2849 content export. It does **not** accept LDIF
*change* records (`changetype: modify`), and will say so rather than
misinterpret them.

## The wizard

### 1. File

Upload the export. It is parsed in memory and held for one hour so you can work
through the review screens; it is never written to disk, and the password hashes
in it are never sent back to your browser — the review screens show only the
scheme name (`{SSHA512}`, `{MD5}`, …).

The banner at the top tells you whether this directory is in the clean state the
import expects.

### 2. Mapping

The importer guesses how your source directory is laid out and shows you the
guess. For a normal OpenLDAP export it will be right; for FreeIPA, Active
Directory or a hand-rolled schema, correct it here:

| Setting | What it decides |
|---|---|
| User objectClass | Which entries are accounts. Prefer the class carrying `uidNumber` — an entry without one cannot be migrated at all. |
| Username attribute | Which attribute becomes the username. `uid`, `sAMAccountName` and `cn` are offered when present. Must be unique across accounts. |
| Group objectClasses | Which entries are groups. |
| Membership attribute | `member`/`uniqueMember` hold DNs; `memberUid` holds bare usernames. Mixed directories are handled per entry, so `groupOfNames` and `posixGroup` entries in the same file both resolve. |

Changing anything here re-scans the file.

### 3. Users

Every account, with what it will bring across and what it will not. Each row is
one of:

- **Import** — a normal person's account.
- **Service account** — non-person accounts (things an app or daemon runs as).
  Identical to ticking "service account" when creating a user by hand: the
  account joins `app_sso_service_account`, is listed separately on the users
  page, and is left out of notifications and site-join user counts.
- **Reject** — not migrated.

Rows shown in red are **blocked**: something makes them impossible to import
(no `uidNumber`, a duplicate inside the file, or a collision with an account
already here). Blocked rows are always skipped, whatever the dropdown says.

Carried across automatically, where the source has them: `uidNumber`,
`gidNumber`, the password hash, first/last name, email, phone, login shell, home
directory, description, location, date of birth, every SSH public key, sudo
rules, and the account's disabled state. Anything else in the source entry is
listed on the row as *not migrated*, so you know what you are leaving behind
before you commit.

A few things worth reading in the Notes column:

- **Legacy MD5 passwords** import fine, and the account is permanently flagged
  to force a password change at first login. This is not optional and is not
  affected by the onboarding settings on the last screen.
- **`cn` will be normalized.** This directory keeps `cn` equal to the username.
  A source that stores a display name there (`cn=Jane Doe`) has it rewritten, or
  the account's personal group could not be found later.
- **Disabled accounts** stay disabled after import.

### 4. Groups

Each source group either has its members merged into a group that **already
exists here**, or is dropped. Several source groups may point at the same
target, which is the normal way to collapse a sprawling old directory.

**Match by name** maps every source group whose name is exactly a group that
exists here — useful when migrating between two SSO Manager directories, and
usually a no-op otherwise.

Members whose accounts you rejected are not added anywhere; the count on each
row shows how many members will actually land. Nested groups are reported but
not migrated — rebuild nesting afterwards, where you can see the group model.

#### Why groups are not imported

A group name from another directory carries no meaning in this one. Access here
is derived from the group model ([Groups](groups.html)): `app_<name>_access`,
`host_<name>_admin` and so on are *projections of your resource graph*, created
and maintained by the directory. A group called `sh4a_users` or `Domain Admins`
imported verbatim would grant nothing, be maintained by nobody, and quietly
suggest an access control that does not exist.

So the import migrates **membership**, not groups: it answers "who was in this,
and where should they be now". Expect to spend time on this screen, and expect
to keep managing groups by hand afterwards — that is the intended outcome, not a
limitation being worked around.

### 5. Confirm

Two onboarding choices, because imported accounts have no history in this app:

- **Treat the terms of service as already accepted**
- **Treat email addresses as already verified**

Leave both off and everyone is asked to accept the ToS and verify their email at
first login. Turn them on if you already collected these in the directory you
are migrating from and do not want to ask 30 people again on cutover day.

**No welcome email is sent to anyone**, whatever you choose here.

## After the import

The report lists every account and group with what happened to it. Then:

1. Log in as your migrated account and confirm it works.
2. Remove the bootstrap admin account you imported with.
3. Rebuild any group nesting the old directory had.
4. Check the accounts flagged for a forced password change; they will be
   prompted on their next login.

If your hosts already have `ldap-client`/SSSD pointed at the old server, they
can be repointed once you are satisfied — because uidNumbers were preserved,
file ownership on those hosts is unaffected.

## Failure and re-running

The import is **resumable, not transactional**. Accounts are created as it runs
and are not rolled back if something fails partway, because deleting real
accounts on a best-effort basis after an error nobody understands is a worse
outcome than stopping and reporting.

If a run fails partway, fix the cause and upload the file again. The accounts
that already made it are reported as collisions and skipped, so a second run
finishes what the first started.

## Security notes

- Only members of `app_sso_admin` (or a global super admin) can reach any part
  of this. The import can set arbitrary passwords on arbitrary usernames, so it
  is gated exactly like directory administration.
- The staged file lives in Redis under a one-hour expiry and is deleted the
  moment the import is applied or abandoned. If your Redis is configured with
  AOF or RDB persistence, that staged copy — including password hashes — can
  touch disk for as long as it is staged.
- Password hashes are never included in an API response and never reach the
  browser.
- The ability to preserve ids and pre-hashed passwords exists only for this
  importer. It is not reachable through the normal user-creation API, so it
  cannot be used to plant a known password hash or claim a privileged
  `uidNumber` by posting a crafted request.
