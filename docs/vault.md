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

## API Access

If you need to programmatically access the secrets, you can interact directly with the OpenBao API using the root token (in dev mode):

```bash
# Example: Read a secret via the API
curl -H "X-Vault-Token: root" -H "Authorization: Bearer <your-sso-token>" http://<your-sso-host>/api/vault/secret/data/<your-secret-path>
```
