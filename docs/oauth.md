---
layout: default
title: OAuth / OIDC
description: SSO Manager's OpenID Connect / OAuth 2.0 provider — discovery document, client registration, and token endpoints.
---

# OAuth 2.0 / OpenID Connect

[← Back to Home](index.html)

> Looking for a plainer explanation of clients/scopes/redirect URIs instead
> of endpoint-level detail? See
> [Connecting Apps (Single Sign-On)](concepts-oauth-apps.html).

SSO Manager is an **OpenID Connect / OAuth 2.0 provider**: it issues its own
access, refresh, and ID tokens that your apps can consume to authenticate
users and authorize API calls. It also runs a full OpenLDAP directory, so it
can be both your SSO and your user directory at once.

## Discovery

The provider publishes a standards-compliant discovery document:

```
GET https://<sso-host>/.well-known/openid-configuration
```

It advertises the `issuer`, `authorization_endpoint`, `token_endpoint`,
`userinfo_endpoint`, `revocation_endpoint`, `end_session_endpoint`, `jwks_uri`,
supported scopes, and token lifetimes. OIDC clients (e.g. the theta42/proxy) can
read their endpoint URLs from here rather than configuring each one — for most
clients the discovery URL is the *only* thing you have to paste in, alongside the
client ID and secret.

The console shows the discovery URL, the client ID and every endpoint on the
client's own edit screen (Directory → the client → **Connection details**), so
you do not have to assemble them by hand.

The `issuer` advertised is `conf.oauth.issuer` — set it to the **browser-facing**
HTTPS URL the SSO is served at (e.g. `https://sso.example.com`), either in
`conf/secrets.js` or via `app_oauth__issuer` / `OAUTH_ISSUER`.

## OAuth clients

An OAuth client is a **service** resource in the Directory carrying one of two
subtypes:

| Subtype | Shown as | |
| :--- | :--- | :--- |
| `oauth` | OAuth Client | Either is a full client; pick whichever name |
| `oidc-client` | OIDC Client | describes the app better. |

Both get a `client_id` and secret minted. `saml-sp` (SAML Service Provider) is a
catalog entry only — SAML is a different protocol and is **not implemented**, so
a `saml-sp` resource gets no client credentials and cannot be used to log in.

An OAuth client represents an app that authenticates against the SSO. Each has:

- `client_id` (UUID) + `client_secret` (bcrypt-hashed; the **raw secret is
  shown once** when the client is created or rotated — save it immediately).
- `name`, `description`, `created_by` (the admin uid that created it).
- `redirect_uris` — allowed callback URLs. Each entry matches exactly, or may
  use `*` (one hostname label) / `**` (any number of labels) as a wildcard —
  e.g. `https://*.example.com/__proxy_auth/callback` covers every host
  theta42/proxy fronts under `example.com`, so you don't have to register
  each proxied host's callback individually.
- `scopes` — requested scopes (default `openid profile email groups`).
- `allowed_groups` — restrict the client to members of specific SSO groups
  (empty = any valid user).
- `token_lifetime` — `access_token` / `refresh_token` lifetimes (seconds).
- `is_public` — the app holds no secret and authenticates with PKCE (see
  [Public clients](#public-clients-spa-mobile-cli)).
- `is_valid` — clear it to disable the client without deleting it (see
  [Disabling a client](#disabling-a-client)).

### Managing clients

Clients are managed directly from the **Directory** tab in the web UI. They are modeled as resources of `kind: oauth` and must belong to a parent Service.

| Action | How to do it |
|--------|--------------|
| **Create** | Click the green **+** on a parent Service to add a child resource. Choose **OAuth Integration**. The raw `client_secret` is shown once upon creation. |
| **Edit** | Click the edit pencil on the OAuth resource in the Directory list or tree. You can update redirect URIs, scopes, allowed groups, and token TTLs. |
| **Delete** | Click the trash can on the OAuth resource in the Directory list. |
| **Rotate Secret** | Open the edit modal for the OAuth resource and click **Rotate Client Secret**. The new raw secret is shown once. |

> All client-management actions use the standard Directory API (`/api/directory-admin/resources`) and are gated by the `app_sso_directory_admin` group.

<a href="images/oauth-clients.png" target="_blank"><img src="images/oauth-clients.png" alt="Editing an OAuth client resource" width="80%"></a>

## Scopes

| Scope | Claims / access |
|-------|-----------------|
| `openid` | OIDC ID token + discovery |
| `profile` | `preferred_username`, display name, etc. |
| `email` | the user's `mail` |
| `groups` | the user's group memberships (the `groups` claim) |

The `groups` claim is what relying parties (e.g. the proxy's
`app_auth__adminGroups`) use to map group membership to roles.

## Token lifetimes

Defaults (overridable per-client via `token_lifetime`, or globally via
`app_oauth__token_lifetime__access_token` /
`app_oauth__token_lifetime__refresh_token`):

- access token: 3600s (1 hour)
- refresh token: 2592000s (30 days)

## Admin gating

SSO admin actions are gated by LDAP group membership (checked via the group's
`member` list, not `memberOf` on the user):

- `app_sso_admin` — full admin (users, groups, settings).
- `app_sso_oauth_admin` — OAuth client management.
- `app_sso_invite` — invitation management.

The bootstrap in [theta-env](https://github.com/theta42/theta-env) creates your
first admin and adds them to `app_sso_admin` + `app_sso_oauth_admin`
automatically; for a standalone install, add the admin's DN to those groups
manually (or via `ops/ldap-setup.sh`).

## Token signing

ID tokens are signed **RS256** with an RSA key pair generated on first use and
stored in OpenBao at `secret/oauth/id-token-key`. The public half is published
as a JWKS:

```
GET https://<sso-host>/.well-known/jwks.json
```

A relying party validates ID tokens against that document and needs no shared
secret to do it — which is what lets a client configure itself from discovery
alone. The `kid` is an RFC 7638 thumbprint of the key, so it changes if and only
if the key does.

In a multi-site cluster the key is replicated with the rest of the directory
(the same mechanism as the agent signing key), so a promotion or failover does
not invalidate every issued token.

### The HS256 fallback

If the RSA key cannot be read or persisted — typically an OpenBao policy that
does not grant `secret/oauth/*` — ID tokens fall back to HS256 signed with
`conf.oauth.jwtSecret` (`app_oauth__jwtSecret` / `JWT_SECRET`), the discovery
document advertises `HS256` and omits `jwks_uri`, and the failure is logged at
startup. That fallback exists because refusing to sign would fail every login on
the deployment; it is not a mode to run in deliberately:

- there is no public half to publish, so every client needs the shared secret
  handed to it out of band;
- **every client validates with a key it could also sign with**, so any one of
  them can mint an ID token for any other. (The OIDC spec's HS256 mode uses the
  client's own `client_secret` as the MAC key precisely to avoid this; that is
  not available here because client secrets are stored bcrypt-hashed and cannot
  be recovered.)

`jwtSecret` therefore still has to be set and persisted, but on a correctly
configured deployment it is not what signs your tokens. Check which is in use by
reading `id_token_signing_alg_values_supported` from the discovery document.

## Public clients (SPA, mobile, CLI)

An app with nowhere to keep a secret — a browser SPA, a mobile app, a CLI — is
registered as a **public client** (the toggle on the client's edit screen). A
public client:

- authenticates at the token endpoint with **PKCE instead of a secret**, and
  `code_challenge` is *required*: a code is refused at issue time without one,
  rather than failing later at redemption where the cause is less obvious;
- must **not** send a `client_secret`. Doing so is rejected rather than ignored,
  because it means the caller believes it is talking to a confidential client.

Discovery advertises this as `none` in `token_endpoint_auth_methods_supported`.
Confidential clients are unaffected and still require their secret.

## Revoking tokens

Rotating a client secret stops it obtaining *new* tokens. It does nothing about
the ones already issued — a refresh token lives 30 days by default — so it is not
on its own the containment it sounds like. Two levers end existing sessions:

**A client revoking its own token** — [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009):

```
POST https://<sso-host>/oauth/revoke
    token=<access or refresh token>
    &token_type_hint=refresh_token      # optional
    &client_id=…&client_secret=…        # omit the secret for a public client
```

Always answers `200`, including for an unknown, malformed or already-revoked
token, and for a token belonging to another client — the endpoint must not become
an oracle telling a caller which of the tokens it holds are real. The only
failure it reports is a client that cannot authenticate.

**An operator revoking everything a client holds** — the **Revoke All Tokens**
button on the client's edit screen (`POST /api/directory-admin/resources/:id/revoke-tokens`).
Everyone signed in through that application is signed out immediately.

## Disabling a client

The **Enabled** switch on the client's edit screen blocks both the authorize and
the token endpoint without deleting anything, which is usually what you want
during an incident: the registration, its redirect URIs and its group
restrictions all survive, and flipping it back restores service. Note that
disabling does not retract tokens that are already issued — pair it with
**Revoke All Tokens** if you need existing sessions gone too.

[← Back to Home](index.html)