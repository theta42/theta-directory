# Vault Secrets Management

The Vault Secrets feature integrates with OpenBao to provide a secure key-value store for your environment. It allows you to store sensitive information like passwords, API keys, and credentials, ensuring they are encrypted and access-controlled.

## Usage

You can access the Vault UI from the application's top navigation bar. 

### Creating Secrets

1. Click on the **New Secret** button.
2. Enter a **Secret Path**. This acts as the name/identifier of your secret (e.g., `db-credentials`).
3. Enter the **Secret Data** in JSON format. For example:
   ```json
   {
     "username": "admin",
     "password": "supersecretpassword123"
   }
   ```
4. Click **Save Secret**.

### Reading and Editing Secrets

* To view a secret, click on its name in the **Secrets List**.
* To update an existing secret, select it and click the **Edit** button. You can then modify the JSON data and save your changes.

### OpenBao Integration

The secrets are stored in an OpenBao backend configured in development mode. The default KV (Key-Value) version 2 engine is mounted at `secret/`. The built-in UI uses the `/api/vault/secret/` API endpoints to interact with OpenBao.

## Apps tab (admin)

The **Apps** tab mints a scoped OpenBao token for an **external application** so it can read its own configuration out of OpenBao — a downstream-app credential, not a per-user secret.

1. Enter an app **name** (e.g. `my-service`) and click **Mint token**.
2. A token is shown **once** — copy it into the external app now; it cannot be recovered later. The app uses it as the `X-Vault-Token` header against `secret/apps/<name>/*` (see the connection convention shown on the page).
3. The **Minted apps** list shows every token you've created (metadata only — the token itself is never stored). sso keeps each token alive by renewing it periodically, so a downstream app's credential stays valid as long as sso runs. If an app shows a **renewal error**, re-mint it here — that revokes the old token and issues a fresh one.

The token is scoped to `secret/apps/<name>/*` only (policy `app-<name>`), so a compromised token can't touch any other secret.

## Shared tab

The **Shared** tab lets you share a secret with another user (or app) without copying the value around.

1. **New** — give the secret a name (slug) and its JSON data. The owner has full read/write on `secret/shared/<uid>/<slug>`.
2. Open a secret and use **Grants** to share it with a user or app; the grantee's OpenBao policy is edited immediately so the share takes effect with no token re-mint. Revoking a grant removes access at the ACL.
3. The data itself is read through the normal Vault proxy using each user's own session, so OpenBao enforces read access per-request.

## API Access

If you need to programmatically access the secrets, you can interact directly with the OpenBao API using the root token (in dev mode):

```bash
# Example: Read a secret via the API
curl -H "X-Vault-Token: root" -H "Authorization: Bearer <your-sso-token>" http://<your-sso-host>/api/vault/secret/data/<your-secret-path>
```
