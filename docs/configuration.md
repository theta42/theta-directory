---
layout: default
title: Configuration
---

# Configuration

[← Back to Home](index.html)

The app loads configuration via
[`@simpleworkjs/conf`](https://www.npmjs.com/package/@simpleworkjs/conf), which
deep-merges, in order (later wins):

1. `conf/base.js` — committed, generic defaults (`dc=example,dc=com`,
   `localhost`, `SSO Manager`).
2. `conf/<NODE_ENV>.js` — optional, environment-specific.
3. `conf/secrets.js` — gitignored; secrets + per-deployment values.
4. **`app_*` environment variables** — the highest-precedence layer.

Any env var whose name starts with `app_` overrides the merged config. The rest
of the name splits on **double-underscore** (`__`) into a nested path. Values are
`JSON.parse`-coerced when possible (numbers, booleans, null, JSON) and kept as
raw strings otherwise.

## Examples

| Env var | Sets | Type |
|---------|------|------|
| `app_ldap__url=ldap://host:389` | `conf.ldap.url` | string |
| `app_ldap__bindPassword=secret` | `conf.ldap.bindPassword` | string |
| `app_ldap__userBase=ou=people,dc=…` | `conf.ldap.userBase` | string |
| `app_ldap__uidGidMin=1500` | `conf.ldap.uidGidMin` | number (new-user id floor) |
| `app_ldap__uidGidReservedFloor=9000` | `conf.ldap.uidGidReservedFloor` | number (ids at/above this are ignored when allocating) |
| `app_oauth__jwtSecret=...` | `conf.oauth.jwtSecret` | string |
| `app_oauth__issuer=https://sso.example.com` | `conf.oauth.issuer` | string |
| `app_oauth__token_lifetime__access_token=3600` | `conf.oauth.token_lifetime.access_token` | number |
| `app_smtp__secure=false` | `conf.smtp.secure` | boolean |
| `app_smtp__host=smtp.example.com` | `conf.smtp.host` | string |
| `app_name=My SSO` | `conf.name` | string |
| `app_redis__host=redis.local` | `conf.redis.host` | string (external Redis) |

## The `app_*` env layer requires conf >= 1.1.0

The `app_*` environment-variable override layer was added in
`@simpleworkjs/conf` **1.1.0**. On 1.0.0 the app ignores all `app_*` vars and only
reads `base.js` / `<NODE_ENV>.js` / `secrets.js`. The Docker image will not honor
`app_*` env on 1.0.0. Refresh the lock from the `nodejs/` directory:

```bash
cd nodejs && npm install @simpleworkjs/conf@^1.1.0
```

## Inspecting the merged config

From the `nodejs/` directory:

```bash
node -e "console.log(require('@simpleworkjs/conf').ldap)"
node -e "console.log(require('@simpleworkjs/conf').oauth)"
node -e "console.log(require('@simpleworkjs/conf'))"   # everything
```

Or, inside the running container:

```bash
docker compose exec sso-manager node -e "console.log(require('@simpleworkjs/conf').ldap)"
```

`app_*` env vars override `secrets.js`, which overrides `base.js` — if a value
isn't what you expect, check those layers in that order.

## Migrating an existing instance to the generic defaults

The committed `nodejs/conf/base.js` ships **generic** defaults
(`dc=example,dc=com`, `localhost`, `SSO Manager`). Previously it carried
Theta42-specific values (LDAP bind DN/bases, SMTP host/user/sender, OAuth
issuer). If you run an existing instance off this repo:

- Move per-deployment, non-secret values (bind DN, user/group bases, SMTP
  host/user/sender, OAuth issuer, org name) from `base.js` into your gitignored
  `conf/secrets.js`, **or** set them as `app_*` env vars.
- Secret values (LDAP bind password, SMTP password, JWT secret) already belong
  in `secrets.js`.

## Troubleshooting `app_*` env vars

### `app_*` vars seem to do nothing

You're on `@simpleworkjs/conf` 1.0.0. Bump to 1.1.0+ (above).

### LDAP operations 401 / "Invalid Credentials"

Check the merged LDAP config the app actually sees:

```bash
cd nodejs && node -e "console.log(require('@simpleworkjs/conf').ldap)"
```

Confirm `url` / `bindDN` / `bindPassword` / `userBase` match your directory.

[← Back to Home](index.html)