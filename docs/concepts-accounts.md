---
layout: default
title: Accounts, Groups & Managers
description: A plain-language guide to users, service accounts, personal groups, and managers in SSO Manager.
---

# Accounts, Groups & Managers

This page explains the concepts behind the Users and Groups pages in plain
language. If you want the technical schema/attribute-level detail instead,
see the [LDAP reference](ldap.html).

## What's an account?

Every person (or app) that can sign in through this SSO Manager has an
**account** — a username, a display name, maybe an email address, and a
password (or, for service accounts, no password at all — see below).
Accounts live in the directory this app manages, and any other app you've
connected (Gitea, Home Assistant, your Wi-Fi, whatever) checks against these
same accounts instead of keeping its own separate list of users and
passwords.

## Two kinds of account: people and service accounts

Most accounts belong to an actual person — check **Users → People** to see
them. But sometimes you need an account for something that *isn't* a
person: a media server, a backup script, a bind account another app uses to
look people up. These are **service accounts**, listed separately under
**Users → Service Accounts**, and they're different from a person's account
in two ways that matter:

- **No email required.** A service account doesn't need a mailbox, so the
  form doesn't ask for one.
- **A password is optional.** If you leave it blank, nobody can log in as
  that account — which is exactly what you want for something that only
  ever gets used programmatically (a script authenticating with an API
  token, or another app binding with a fixed, separately-configured
  password you set yourself). Only give it a password if the account
  genuinely needs to log in or bind somewhere as itself.

Aside from those two differences, a service account is a completely normal
account under the hood — it can belong to groups, have a manager, and so
on, just like anyone else's.

## Groups: who can do what

A **group** is just a named list of accounts, used to control access. This
app has a handful of built-in groups that grant admin powers (e.g. only
people in the `app_sso_admin` group can see the Users/Groups/Integrations
pages at all), but you can also make your own groups for any app you
connect — say, a group listing everyone who should be allowed into your
photo server. Once a group exists, add or remove members from the
**Groups** page, and point the other app's "who's allowed in" setting at
that group's name.

## Every account's personal group

Separately from the groups above, every single account — person or
service account — automatically gets its own small, personal group when
it's created, named after the account itself. Most of the time you'll
never think about this; it exists so that, on a Linux system connected to
this directory, each account "owns" its own files by default the same way
a normal Unix user account would.

Occasionally you'll want to share that ownership with someone else — for
example, letting a second account also have write access to files a
service account owns. That's what the **"Members of `<uid>`'s group"**
section on a profile page is for: add another account there, and the
underlying Linux permissions treat them as if they belong to that same
personal group too.

## What's a "manager"?

Every account has one or more **managers** — the people allowed to edit
that account's profile (phone number, SSH key, home directory, and so on)
without needing full admin rights. By default, whoever created an account
(the admin who added it, or whoever sent the invite) becomes its first
manager, but you can add or remove managers later from the account's Edit
form.

This is useful for service accounts especially: if a service account
belongs to a particular project or person, make them its manager so they
can maintain it — rotate its SSH key, adjust its description — without
needing to be a full SSO administrator.

## Inviting someone vs. adding them yourself

From the Users page you can either fill in someone's details yourself
("Add new user"), or send them an **invite** — an email (or a link you copy
and send however you like) that lets them pick their own username and
password. Either way, the resulting account is identical; invites are just
a convenience so you don't have to know someone's preferred username or
handle their password directly.

## Want more detail?

This page deliberately leaves out LDAP schema names, attribute types, and
protocol-level detail. If you're connecting a third-party app directly to
the LDAP directory, or you just want to know exactly what's stored where,
see the [LDAP reference](ldap.html).

[← Back to Home](index.html)
