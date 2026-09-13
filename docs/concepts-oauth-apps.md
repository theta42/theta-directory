---
layout: default
title: Connecting Apps (Single Sign-On)
description: A plain-language guide to OAuth/OIDC clients and single sign-on in SSO Manager.
---

# Connecting Apps (Single Sign-On)

This page explains, in plain language, what happens when you "connect" an
app to your SSO Manager so people can log into it with their existing
account. For the technical endpoint/token detail, see the
[OAuth reference](oauth.html).

## What does "single sign-on" actually mean?

Instead of every app you run having its own separate list of usernames and
passwords, they all check with this SSO Manager instead. You log in once,
here, and any connected app trusts that login — no separate password to
remember or manage for each one. If you ever need to lock someone out
everywhere at once, you do it in one place (deactivate their account here)
instead of hunting down every app individually.

The technology behind this is called **OAuth 2.0** and **OpenID Connect
(OIDC)** — you'll see both names used, often together, referring to the
same thing. You don't need to understand the protocol to use this page;
what matters practically is the handful of concepts below.

## What's a "client"?

Every app you connect is registered here as a **client** — a single entry
in the Directory representing that one app. Registering a client
gives you a **Client ID** and **Client Secret**: think of these like a
username and password, but for the *app itself* rather than for a person.
You paste them into the other app's own "Single Sign-On" or "OIDC" setup
screen, along with the discovery URL shown at the top of this page, and
that app is now able to ask this SSO Manager to authenticate people on its
behalf.

**Treat the Client Secret like a password** — anyone who has it can
impersonate that app when talking to your SSO Manager. If you ever suspect
it's leaked, rotate it from the client's card.

Everything you need to paste into the other app — the Client ID, the
discovery URL, and each individual endpoint for apps that can't use
discovery — is shown under **Connection details** on the client's edit
screen. The secret is the one exception: it's shown once when the client is
created or rotated and is never recoverable afterwards, so save it then.

### Apps that can't keep a secret

A single-page web app, a mobile app or a command-line tool has nowhere safe
to store a Client Secret — anyone can read it out of the download. Tick
**Public client** for those, and the app proves itself a different way
(PKCE) instead of with a secret. If you're not sure, leave it off: an app
running on a server you control should keep its secret.

## What are "scopes"?

**Scopes** control what information a connected app is allowed to ask for
about the person logging in — their username, email, group memberships,
and so on. Most apps tell you exactly which scopes they need in their own
setup instructions; when in doubt, the default set (`openid`, `profile`,
`email`, `groups`) covers what nearly every app expects.

## "Restrict to Groups"

By default, *any* account with an SSO Manager login can sign into a
connected app. If that's not what you want — say, a home automation
dashboard that only certain family members should reach — set **Restrict
to Groups** on that client to one of your [groups](concepts-accounts.html).
Only members of that group will be allowed to log into that particular
app; everyone else gets turned away at the login step, even though their
SSO Manager account still works everywhere else.

## Redirect URIs

A **Redirect URI** is the exact web address the connected app wants people
sent back to once they've logged in here — it's a security measure so an
attacker can't trick the login flow into redirecting somewhere else. The
app's own setup instructions will tell you this value; copy it in exactly
as given. If the app is reachable via more than one hostname (for example,
because it sits behind [theta42/proxy](https://theta42.github.io/proxy/)),
this field supports wildcard patterns — see the inline help under the
field itself for the exact syntax.

## Turning an app off

If you need to cut an app off — it's been compromised, or you're
decommissioning it — you have two switches on the client's edit screen, and
they do different things:

* **Enabled** (turn off) stops anyone logging into that app from now on.
  The registration and all its settings survive, so turning it back on
  restores service. People *already* signed in stay signed in until their
  session expires.
* **Revoke All Tokens** signs out everyone who is currently using it,
  immediately.

For a suspected leak you generally want both, plus a secret rotation.
Rotating on its own only stops the app getting *new* sessions; it does not
end the ones already running.

## Want more detail?

This page intentionally skips the protocol-level detail (exact endpoint
URLs, token formats, claim names). If you're troubleshooting a connection
or building something against the API directly, see the
[OAuth reference](oauth.html).

[← Back to Home](index.html)
