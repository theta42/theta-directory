---
layout: default
title: Vault Secrets
description: OpenBao-backed personal, shared, and external-app secret storage built into the SSO Manager UI.
---

# Vault Secrets Management

[← Back to Home](index.html)

The Vault Secrets feature integrates with OpenBao to provide a secure key-value store for your environment. It allows you to store sensitive information like passwords, API keys, and credentials, ensuring they are encrypted and access-controlled.

## Location & Access

- **External App Tokens**: Managed under **Configuration** (`/conf` -> **App Tokens** tab). Admins can mint and view periodic OpenBao app tokens scoped to `secret/apps/<name>/*`.
- **Resource Secrets**: Managed under **Directory** (`/directory`) inside each resource's modal under the **Secrets** tab. Stored in OpenBao under `secret/data/resources/<slug>/conf`.

## External App Tokens (Admin)

The **App Tokens** tab in **Configuration** (`/conf`) mints a scoped OpenBao token for an **external application** or script so it can read its own configuration out of OpenBao.

1. Enter an app **name** (e.g. `build-agent`) and click **Mint token**.
2. A token is shown **once** — copy it into the external app now; it cannot be recovered later. The app uses it as the `X-Vault-Token` header against `secret/apps/<name>/*`.
3. The **Active App Tokens** list shows every token created (metadata only — the token itself is never stored). sso-manager keeps each token alive by renewing it periodically.

The token is strictly scoped to `secret/apps/<name>/*` (policy `app-<name>`), so a compromised token can't touch any other secret.

## Shared tab

The **Shared** tab lets you share a secret with another user (or app) without copying the value around.

1. **New** — give the secret a name (slug) and its JSON data. The owner has full read/write on `secret/shared/<uid>/<slug>`.
2. Open a secret and use **Grants** to share it with a user or app; the grantee's OpenBao policy is edited immediately so the share takes effect with no token re-mint. Revoking a grant removes access at the ACL.
3. The data itself is read through the normal Vault proxy using each user's own session, so OpenBao enforces read access per-request.

## API Access

To read your own secrets programmatically, call the `/api/vault` proxy with
a [personal API token](concepts-api-tokens.html) — **not** a raw OpenBao
token. The server authenticates the request, resolves your own scoped
OpenBao access, and injects the real `X-Vault-Token` itself:

```bash
# Example: Read a secret via the API (KV-v2, so the path includes /data/)
curl -H "Authorization: Bearer sso_<id>_<secret>" \
  https://<your-sso-host>/api/vault/secret/data/<your-secret-path>
```

An **external app** reading its own config uses the scoped token minted for
it on the **Apps** tab instead of a personal token — see *Apps tab (admin)*
above for how that token is minted and what it's confined to.

Using the OpenBao **root token** directly (bypassing the SSO entirely) is
never the intended path for day-to-day secret access — it's an
operator/maintenance credential (seeding, disaster recovery), kept in
`setup.env` and never passed to a service container. See
[theta-env's Secrets doc](https://theta42.github.io/theta-env/secrets.html)
for the full token/policy model.
