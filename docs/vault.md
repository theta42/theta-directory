---
layout: default
title: Secrets Vault
nav_order: 6
---

# Secrets Vault

SSO Manager integrates natively with **OpenBao** (a Vault fork) to securely manage and store sensitive data, configuration, and API keys.

The Vault proxy endpoint is exposed directly through SSO Manager at `/api/vault/v1/`, which safely authenticates and authorizes requests before forwarding them to the internal OpenBao container.

## Architecture

The secrets engine uses a persistent file backend (`/var/lib/docker/volumes/theta-env_openbao-data/_data`) to ensure high availability and durability.

When the environment is initialized via `setup.sh`, OpenBao is automatically unsealed and seeded with a root token that the application uses for authentication. The root token is kept securely inside the container environment.

## Accessing the Vault

The SSO Manager Vault can be accessed in two ways:

1. **Via the SSO Manager UI**: Go to the **Admin Configuration** page (`/conf`) to edit the application's configuration secrets directly. SMTP and OAuth settings are edited through structured form fields (not a raw JSON blob) and saved to OpenBao at `secret/sso-manager/conf` at runtime, taking effect immediately. Secret fields — the SMTP password and the OAuth JWT secret — are returned masked (`********`); leave the field unchanged (or blank) to keep the stored value, or enter a new value to replace it.
2. **Via the REST API**: Send requests to `/api/vault/v1/...` with your SSO Manager session or API Token.

### API Example

To read secrets from the default key-value store, issue a `GET` request to:
`/api/vault/v1/secret/data/sso-manager/conf`

Only administrators with `app_sso_admin` or `admin` permissions can query the vault endpoints.

## Namespaces and Paths

Currently, secrets are maintained at `/v1/secret/data/sso-manager/conf` using the `kv-v2` backend. When configurations are edited via the admin UI, SSO Manager performs a deep-merge so that partial updates don't overwrite unrelated keys (such as SMTP vs OAuth configurations).

## Plugin Integration

Plugin instances store their per-instance secrets in OpenBao at
`secret/plugins/<instance-id>/conf` (configured, loaded/unloaded, and run from
the **Plugins** page — see [Plugins](plugins.html)). The plugin process runs
in-process, so the SSO Manager reads/writes those secrets server-side through
the `sso-broker` token; the admin UI only ever sees masked values, and external
apps can retrieve API tokens via the `/api/vault` proxy to keep permissions
consistently enforced instead of hardcoding them.
