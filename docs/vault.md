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

1. **Via the SSO Manager UI**: Go to the **Admin Configuration** page (`/conf`) to edit the application's configuration secrets directly.
2. **Via the REST API**: Send requests to `/api/vault/v1/...` with your SSO Manager session or API Token.

### API Example

To read secrets from the default key-value store, issue a `GET` request to:
`/api/vault/v1/secret/data/sso-manager/conf`

Only administrators with `app_sso_admin` or `admin` permissions can query the vault endpoints.

## Namespaces and Paths

Currently, secrets are maintained at `/v1/secret/data/sso-manager/conf` using the `kv-v2` backend. When configurations are edited via the admin UI, SSO Manager performs a deep-merge so that partial updates don't overwrite unrelated keys (such as SMTP vs OAuth configurations).

## Plugin Integration

When building custom Agents or integrations, they can utilize the local Vault to retrieve API tokens instead of hardcoding them. Always use the `/api/vault` proxy to ensure permissions are consistently enforced.
