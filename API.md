# SSO Manager API Documentation

> Looking for a plainer explanation of what API tokens are and when you'd
> want one, instead of a full endpoint reference? See
> [API Tokens](/docs/api-tokens) (in-app) or
> [concepts-api-tokens.md](docs/concepts-api-tokens.md) (repo).

## Overview

API documentation for the SSO Manager Node application. Provides endpoints for authentication, user management, group management, token management, notifications, and OAuth 2.0 / OpenID Connect.

**Base URL:** `https://your-domain.com`

**Content Type:** `application/json` (all request and response bodies)

---

## Authentication

### Getting a Token

Login via `POST /api/auth/login` to receive an auth token.

### Using the Token

Include the token in every protected request:

```
auth-token: <token>
```

### Protected Routes

- `/api/user/*` — user management
- `/api/group/*` — group management
- `/api/token/*` — token management
- `/api/notification/*` — notifications
- `/api/oauth/client/*` — OAuth client management

### Permission Groups

| Group | Grants |
|-------|--------|
| `app_sso_admin` | Full user/group/notification management |
| `app_sso_oauth_admin` | Register and manage OAuth clients |
| `app_sso_invite` | Invitation management |
| Group owner | Manage membership of that specific group |

Self-service: users can always read and modify their own account without admin membership.

### Rate Limits

| Endpoint | Limit |
|----------|-------|
| `POST /api/auth/login` | 10 requests / 15 min |
| `POST /api/auth/resetpassword` | 5 requests / hour |
| `POST /api/auth/otp/request` | 5 requests / 15 min |
| `POST /api/auth/otp/verify` | 10 requests / 15 min |
| `POST /api/auth/invite/*` | 20 requests / hour |

Limits are per IP. The server must be behind a trusted proxy for these to apply correctly.

---

## Authentication Endpoints

Base path: `/api/auth`

### Login

**`POST /api/auth/login`** — No auth required

**Request:**
```json
{ "uid": "username", "password": "user_password" }
```

**Response:**
```json
{ "login": true, "token": "auth_token_string", "message": "username logged in!" }
```

---

### Logout

**`ALL /api/auth/logout`** — No auth required

**Response:**
```json
{ "message": "Bye" }
```

---

### Username Suggestions

Returns available username suggestions based on name and optional date of birth.

**`GET /api/auth/username-suggestions`** — No auth required

**Query Parameters:**
- `givenName` — First name
- `sn` — Last name
- `dob` (optional) — Date of birth (used to generate year-variant suggestions)

**Response:**
```json
{ "suggestions": ["jsmith", "jsmith1990", "johnsmith"] }
```

---

### Request Password Reset

**`POST /api/auth/resetpassword`** — No auth required

**Request:**
```json
{ "mail": "user@example.com" }
```

**Response:**
```json
{ "message": "If the email address is in our system, you will receive a message." }
```

The same response is returned whether or not the email exists. Reset tokens expire after 24 hours.

---

### Complete Password Reset

**`POST /api/auth/resetpassword/:token`** — No auth required

**URL Parameters:** `token` — from the reset email

**Request:**
```json
{ "password": "new_password", "confirm": "new_password" }
```

**Response:**
```json
{ "message": "Password has been changed." }
```

The token is invalidated after a successful reset.

---

### Request OTP Code

Send a one-time login code via email or SMS.

**`POST /api/auth/otp/request`** — No auth required

**Request:**
```json
{ "login": "username_or_email", "method": "email" }
```

`method` must be `email` or `sms`. For `sms`, the account must have a mobile number on file.

**Response:**
```json
{ "message": "Code sent", "method": "email", "expires_at": 1234567890000 }
```

---

### Verify OTP Code

Verify a one-time code and receive an auth token. Also marks the corresponding contact method (email or phone) as verified on the account.

**`POST /api/auth/otp/verify`** — No auth required

**Request:**
```json
{ "login": "username_or_email", "code": "123456" }
```

**Response:**
```json
{ "login": true, "token": "auth_token_string" }
```

Returns `401` if the code is invalid or expired.

---

### Accept Invite (with Email Verification)

Create an account from an invite token after verifying email.

**`POST /api/auth/invite/:token/:mailToken`** — No auth required

**URL Parameters:** `token` — invite token, `mailToken` — email verification token

**Request:**
```json
{
  "uid": "username",
  "password": "user_password",
  "givenName": "First Name",
  "sn": "Last Name",
  "mail": "user@example.com"
}
```

**Response:**
```json
{ "user": "username", "token": "auth_token_string" }
```

---

### Send Invite Verification Email

Send an email verification link for an invite token.

**`POST /api/auth/invite/:token`** — No auth required

**URL Parameters:** `token` — invite token

**Request:**
```json
{ "mail": "user@example.com" }
```

**Response:**
```json
{ "message": "sent" }
```

---

### Impersonate User (Admin)

Creates a temporary password for a target user and returns it. Allows admins to log in as another user for support purposes.

**`POST /api/auth/impersonate/:uid`** — Auth required, `app_sso_admin`

**URL Parameters:** `uid` — target username

**Response:**
```json
{
  "uid": "target_username",
  "temp_password": "random_temp_password",
  "expires_at": 1234567890000
}
```

The temp password is short-lived. Any previous impersonation session for the same target is revoked first.

---

### End Impersonation (Admin)

Revoke all active impersonation sessions for a user.

**`DELETE /api/auth/impersonate/:uid`** — Auth required, `app_sso_admin`

**URL Parameters:** `uid` — target username

**Response:**
```json
{ "message": "Impersonation ended for username", "revoked": 1 }
```

---

## User Management Endpoints

Base path: `/api/user`

All endpoints require authentication.

### List All Users

**`GET /api/user/`** — `app_sso_admin` required

**Query Parameters:**
- `detail` (optional) — return full user objects instead of a minimal list

**Response:**
```json
{
  "results": [
    { "uid": "username", "mail": "user@example.com", "givenName": "First", "sn": "Last" }
  ]
}
```

---

### Create User

**`POST /api/user/`** — `app_sso_admin` required

**Request:**
```json
{
  "uid": "username",
  "password": "user_password",
  "givenName": "First Name",
  "sn": "Last Name",
  "mail": "user@example.com"
}
```

**Response:**
```json
{ "results": { "uid": "username", "dn": "uid=username,ou=people,dc=..." } }
```

Admin-created accounts have `password_must_change` set automatically.

---

### Get Current User

**`GET /api/user/me`** — Any authenticated user

Returns the full user object for the authenticated user, including onboarding state.

**Response:**
```json
{
  "uid": "username",
  "mail": "user@example.com",
  "givenName": "First",
  "sn": "Last",
  "dn": "uid=username,ou=people,dc=...",
  "onboardingRequired": "yes",
  "onboardingNeeds": ["tos", "dob", "password"],
  "memberOf": ["cn=group_name,ou=groups,dc=..."]
}
```

`onboardingRequired` is `"yes"` when `onboardingNeeds` is non-empty. Needs can be `"tos"`, `"dob"`, or `"password"`.

---

### Accept Terms of Service

Mark TOS as accepted for the authenticated user.

**`POST /api/user/accept-tos`** — Any authenticated user

**Response:**
```json
{ "success": true }
```

---

### Get Admin Stats

Returns user and group counts, recent signups, and inactive users.

**`GET /api/user/stats`** — `app_sso_admin` required

**Response:**
```json
{
  "totalUsers": 42,
  "activeUsers": 38,
  "inactiveUsers": 4,
  "totalGroups": 10,
  "recentSignups": [
    { "uid": "newuser", "givenName": "New", "sn": "User", "mail": "new@example.com", "createTimestamp": "20240101000000Z" }
  ],
  "inactiveList": [
    { "uid": "lockeduser", "givenName": "Locked", "sn": "User", "mail": "locked@example.com" }
  ]
}
```

---

### Export Users CSV

Download all users as a CSV file.

**`GET /api/user/export`** — `app_sso_admin` required

**Response:** `Content-Type: text/csv`, attachment download

Columns: `uid`, `givenName`, `sn`, `mail`, `mobile`, `uidNumber`, `isActive`, `createTimestamp`

---

### Get User Verification Status

**`GET /api/user/:uid/verification`** — `app_sso_admin` required

**Response:**
```json
{
  "uid": "username",
  "emailVerified": true,
  "emailVerifiedAt": 1234567890000,
  "phoneVerified": false,
  "phoneVerifiedAt": null,
  "tosAccepted": true,
  "tosAcceptedAt": 1234567890000
}
```

---

### Get User

**`GET /api/user/:uid`** — Any authenticated user

**Response:**
```json
{ "results": { "uid": "username", "mail": "user@example.com", "givenName": "First", "sn": "Last" } }
```

---

### Update User

**`PUT /api/user/:uid`** — Own account, or `app_sso_admin` for others

**Request:** Any subset of editable fields:
```json
{
  "givenName": "New First Name",
  "sn": "New Last Name",
  "mail": "newemail@example.com",
  "dateOfBirth": "1990-01-15",
  "mobile": "+15551234567",
  "sshPublicKey": "ssh-rsa AAAA..."
}
```

**Response:**
```json
{ "results": { <updated user object> }, "message": "Updated username user" }
```

---

### Set User Active/Inactive

Lock or unlock a user account.

**`PUT /api/user/:uid/active`** — `app_sso_admin` required

**Request:**
```json
{ "active": true }
```

**Response:**
```json
{ "uid": "username", "active": true, "message": "User username activated" }
```

---

### Delete User

**`DELETE /api/user/:uid`** — Own account, or `app_sso_admin` for others

**Response:**
```json
{ "uid": "username", "results": true }
```

---

### Change Own Password

**`PUT /api/user/password`** — Any authenticated user

**Request:**
```json
{ "password": "new_password", "confirm": "new_password" }
```

**Response:**
```json
{ "results": true }
```

Clears `password_must_change` on the account.

---

### Change User Password (Admin)

**`PUT /api/user/:uid/password`** — Own account, or `app_sso_admin` for others

**Request:**
```json
{ "password": "new_password", "confirm": "new_password" }
```

**Response:**
```json
{ "results": true, "message": "User username password changed." }
```

When an admin changes another user's password, `password_must_change` is set on that account.

---

### Generate Invite Token

Create an invite token, optionally emailing it to the invitee and pre-assigning
LDAP groups the new account should be added to on signup.

**`POST /api/user/invite`** — `app_sso_admin` or `app_sso_invite` required

**Request:**
```json
{ "mail": "invitee@example.com", "groups": ["group_name"] }
```

`mail` and `groups` are both optional. If `mail` is provided, a verification
email is sent to that address.

**Response:**
```json
{
  "token": "invite_token_string",
  "link": "https://your-domain.com/login/invite/invite_token_string",
  "mail_sent": true
}
```

---

### List Invite Tokens

**`GET /api/user/invite`** — `app_sso_admin` or `app_sso_invite` required

Admins (`app_sso_admin`) see all invite tokens; non-admin `app_sso_invite`
members see only invites they created.

**Response:**
```json
{
  "results": [
    {
      "token": "invite_token_string",
      "created_by": "username",
      "created_on": 1234567890000,
      "is_valid": true,
      "mail": "invitee@example.com",
      "groups": "[\"group_name\"]"
    }
  ]
}
```

---

### Update Invite Token

Update the groups an invite will assign, or change/clear the invitee's email
(re-sends verification if a new email is set).

**`PUT /api/user/invite/:token`** — `app_sso_admin`, or the `app_sso_invite`
member who created the invite

**URL Parameters:** `token` — invite token

**Request:** Any subset of:
```json
{ "groups": ["group_name"], "mail": "newinvitee@example.com" }
```

Set `mail` to `null`/empty to clear it. Fails with `400` if the token is no
longer valid.

**Response:**
```json
{ "results": { "token": "invite_token_string", "is_valid": true, "...": "..." } }
```

---

### Revoke Invite Token

**`DELETE /api/user/invite/:token`** — `app_sso_admin`, or the `app_sso_invite`
member who created the invite

**URL Parameters:** `token` — invite token

**Response:**
```json
{ "results": true }
```

---

### Add SSH Key

**`POST /api/user/key`** — Any authenticated user

**Request:**
```json
{ "key": "ssh-rsa AAAAB3NzaC1yc2E... user@host" }
```

**Response:**
- `200` — `{ "message": true }`
- `400` — `{ "message": "error description" }`

---

## Group Management Endpoints

Base path: `/api/group`

All endpoints require authentication.

### List Groups

**`GET /api/group/`** — Any authenticated user

**Query Parameters:**
- `detail` (optional) — return full group objects
- `member` (optional) — filter to groups containing this UID as a member

**Response:**
```json
{ "results": [{ "cn": "group_name", "description": "Group description" }] }
```

---

### Create Group

**`POST /api/group/`** — `app_sso_admin` required

**Request:**
```json
{ "name": "group_name", "description": "Group description" }
```

**Response:**
```json
{ "results": { "cn": "group_name" }, "message": "group_name was added!" }
```

The authenticated user is automatically set as the group owner.

---

### Get Group

**`GET /api/group/:name`** — Any authenticated user

**Response:**
```json
{
  "results": {
    "cn": "group_name",
    "description": "Group description",
    "member": ["uid=user1,ou=people,dc=...", "uid=user2,ou=people,dc=..."],
    "owner": ["uid=owner,ou=people,dc=..."]
  }
}
```

---

### Add Group Owner

**`PUT /api/group/owner/:group/:uid`** — `app_sso_admin` or group owner

**Response:**
```json
{ "results": true, "message": "Added owner uid to group group." }
```

---

### Remove Group Owner

**`DELETE /api/group/owner/:group/:uid`** — `app_sso_admin` or group owner

**Response:**
```json
{ "results": true, "message": "Removed Owner uid from group group." }
```

---

### Add User to Group

**`PUT /api/group/:group/:uid`** — `app_sso_admin` or group owner

**Response:**
```json
{ "results": true, "message": "Added user uid to group group." }
```

---

### Remove User from Group

**`DELETE /api/group/:group/:uid`** — `app_sso_admin` or group owner

**Response:**
```json
{ "results": true, "message": "Removed user uid from group group." }
```

---

### Delete Group

**`DELETE /api/group/:group`** — `app_sso_admin` or group owner

**Response:**
```json
{ "removed": true, "results": { "cn": "group_name" }, "message": "Group group_name Deleted" }
```

---

## Token Management Endpoints

Base path: `/api/token`

All endpoints require authentication.

### List Token Types

**`GET /api/token/`** — Any authenticated user

**Response:**
```json
{ "results": ["InviteToken", "PasswordResetToken"] }
```

---

### List Tokens by Type

**`GET /api/token/:name`** — Any authenticated user

**Query Parameters:** `detail` (optional) — include full token objects

**Response:**
```json
{
  "results": [
    { "token": "token_string", "created_by": "username", "created_on": 1234567890000, "is_valid": true }
  ]
}
```

---

### Get Specific Token

**`GET /api/token/:name/:token`** — Any authenticated user

**Response:**
```json
{ "results": { "token": "token_string", "created_by": "username", "created_on": 1234567890000, "is_valid": true } }
```

---

## Notification Endpoints

Base path: `/api/notification`

All endpoints require authentication and `app_sso_admin` membership.

Notifications send email blasts to filtered groups of users and record history.

### Send Notification

**`POST /api/notification`** — `app_sso_admin` required

**Request:**
```json
{
  "subject": "Maintenance window tonight",
  "message": "<p>We will be performing maintenance starting at midnight.</p>",
  "filter_type": "group",
  "filter_value": "host_hec-bot_admin, app_sso_admin",
  "active_only": true
}
```

**`filter_type` values:**

| Value | Description |
|-------|-------------|
| `all_active` | All active (unlocked) users |
| `all` | All users including inactive |
| `group` | Members of one or more LDAP groups |
| `users` | Specific users by UID |

**`filter_value`:**
- For `group`: comma-separated group names (e.g. `"host_hec-bot_admin, app_sso_admin"`)
- For `users`: JSON array of UIDs (e.g. `'["wmantly","jsmith"]'`)
- Unused for `all_active` and `all`

**`active_only`** (boolean, default `false`): when `true` with `group` or `all` filter types, only active (unlocked) users receive the notification. Has no effect on `all_active` (which is always active-only).

**Response:**
```json
{
  "results": {
    "notification_id": "uuid",
    "created_by": "wmantly",
    "created_on": 1234567890000,
    "subject": "Maintenance window tonight",
    "message": "<p>...</p>",
    "filter_type": "group",
    "filter_value": "host_hec-bot_admin",
    "active_only": true,
    "status": "sent",
    "sent_count": 5,
    "failed_count": 0,
    "sent_at": 1234567890123
  }
}
```

**External API usage example:**

```bash
# Login once, store token
TOKEN=$(curl -s -X POST https://sso.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"uid":"monitor","password":"..."}' | jq -r .token)

# Send notification to a group
curl -X POST https://sso.example.com/api/notification \
  -H "auth-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "subject": "hec-bot maintenance",
    "message": "<p>The hec-bot VM will restart at 3am.</p>",
    "filter_type": "group",
    "filter_value": "host_hec-bot_admin",
    "active_only": true
  }'
```

---

### List Notification History

**`GET /api/notification`** — `app_sso_admin` required

**Response:**
```json
{
  "results": [
    {
      "notification_id": "uuid",
      "subject": "Maintenance window",
      "filter_type": "group",
      "filter_value": "host_hec-bot_admin",
      "active_only": true,
      "status": "sent",
      "sent_count": 5,
      "failed_count": 0,
      "created_by": "wmantly",
      "created_on": 1234567890000,
      "sent_at": 1234567890123
    }
  ]
}
```

Results are sorted by `created_on` descending (most recent first).

---

### Get Notification Record

**`GET /api/notification/:id`** — `app_sso_admin` required

**Response:** `{ "results": { <notification object> } }`

---

## OAuth 2.0 / OpenID Connect

The SSO Manager acts as an OAuth 2.0 Authorization Server and OpenID Connect Provider.

### Discovery

**`GET /.well-known/openid-configuration`** — No auth required

Returns the OIDC discovery document with endpoint URLs, supported scopes, and signing algorithms.

---

### Authorization Endpoint

**`GET /oauth/authorize`** — No auth required (redirects to login if not authenticated)

**Query Parameters:**
- `response_type` — Must be `code`
- `client_id` — Registered OAuth client ID
- `redirect_uri` — Must match a URI registered for the client, either exactly
  or against a registered wildcard pattern (`*` = one hostname label, `**` =
  any number of labels)
- `scope` — Space-separated: `openid`, `profile`, `email`
- `state` — Opaque value returned unchanged in the redirect
- `code_challenge` — PKCE challenge (SHA-256 of code_verifier, base64url-encoded)
- `code_challenge_method` — Must be `S256`

Renders the consent screen.

---

### Authorize (Issue Code)

Issues the authorization code after the user approves the consent form shown
by the Authorization Endpoint above. This is called by the consent page itself
(an authenticated request, via `auth-token`), not by the OAuth client
directly.

**`POST /api/oauth/authorize`** — Auth required (`auth-token` header)

**Request:**
```json
{
  "response_type": "code",
  "client_id": "uuid",
  "redirect_uri": "https://ha.example.com/auth/external/callback",
  "scope": "openid profile email",
  "state": "opaque-state-value",
  "code_challenge": "pkce-challenge",
  "code_challenge_method": "S256"
}
```

Only scopes the client is actually registered for are granted, even if more
are requested. If the client has `allowed_groups` set, the authenticated user
must be a member of at least one of those groups or the request is rejected
with `403`.

**Response:**
```json
{ "redirect_url": "https://ha.example.com/auth/external/callback?code=<code>&state=<state>" }
```

The caller (the consent page) redirects the browser to `redirect_url`, which
completes the flow described in the Authorization Endpoint section above.

---

### Token Endpoint

**`POST /oauth/token`** — No auth required (client authenticates via credentials)

**Content-Type:** `application/x-www-form-urlencoded` or `application/json`

**Client Authentication:** `client_id` + `client_secret` in the request body, or HTTP Basic Auth.

#### Authorization Code Grant

```
grant_type=authorization_code
&code=<auth_code>
&redirect_uri=<redirect_uri>
&client_id=<client_id>
&client_secret=<client_secret>
&code_verifier=<pkce_verifier>
```

#### Refresh Token Grant

```
grant_type=refresh_token
&refresh_token=<refresh_token>
&client_id=<client_id>
&client_secret=<client_secret>
```

Refresh tokens are rotated on each use — the old token is invalidated and a new one is returned.

**Response:**
```json
{
  "access_token": "uuid",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "uuid",
  "id_token": "<jwt>"
}
```

---

### UserInfo Endpoint

**`GET /oauth/userinfo`** — Bearer token required (`Authorization: Bearer <access_token>`)

**Response** (claims vary by granted scopes):
```json
{
  "sub": "username",
  "name": "First Last",
  "given_name": "First",
  "family_name": "Last",
  "preferred_username": "username",
  "email": "user@example.com"
}
```

---

## OAuth Client Management

Base path: `/api/oauth/client`

All endpoints require authentication and `app_sso_oauth_admin` membership.

### List Clients

**`GET /api/oauth/client/`**

**Response:**
```json
{
  "results": [
    {
      "client_id": "uuid",
      "name": "Home Assistant",
      "description": "Home automation",
      "redirect_uris": ["https://ha.example.com/auth/external/callback"],
      "scopes": ["openid", "profile", "email"],
      "allowed_groups": [],
      "token_lifetime": { "access_token": 3600, "refresh_token": 2592000 },
      "created_by": "wmantly",
      "created_on": 1234567890000
    }
  ]
}
```

---

### Register Client

**`POST /api/oauth/client/`**

**Request:**
```json
{
  "name": "Home Assistant",
  "description": "Home automation dashboard",
  "redirect_uris": ["https://ha.example.com/auth/external/callback"],
  "scopes": ["openid", "profile", "email"],
  "allowed_groups": [],
  "token_lifetime": { "access_token": 3600, "refresh_token": 2592000 }
}
```

`redirect_uris` may also be a newline-separated string. `scopes` may also be a space-separated string.
`allowed_groups` restricts the client to members of the listed SSO groups (empty/omitted = any valid user).

**Response:**
```json
{
  "results": { "client_id": "uuid", "name": "Home Assistant" },
  "client_secret": "raw-secret-shown-once",
  "message": "OAuth client 'Home Assistant' created. Save the client secret — it will not be shown again."
}
```

The `client_secret` is shown **only once**. Store it immediately.

---

### Get Client

**`GET /api/oauth/client/:client_id`**

**Response:** `{ "results": { <client object> } }`

---

### Update Client

**`PUT /api/oauth/client/:client_id`**

**Request:** Any subset of `name`, `description`, `redirect_uris`, `scopes`, `allowed_groups`, `token_lifetime`, `is_valid`.

**Response:** `{ "results": { <updated client> }, "message": "..." }`

---

### Delete Client

**`DELETE /api/oauth/client/:client_id`**

**Response:** `{ "client_id": "uuid", "message": "OAuth client '...' deleted." }`

---

### Rotate Client Secret

**`POST /api/oauth/client/:client_id/rotate`**

**Response:**
```json
{
  "client_secret": "new-raw-secret-shown-once",
  "message": "Client secret rotated for '...'. Save it — it will not be shown again."
}
```

The old secret is invalidated immediately. The new secret is shown **only once**.

---

### Token Lifetimes

Configurable per-client via `token_lifetime`. Global defaults (in seconds):

```json
{ "access_token": 3600, "refresh_token": 2592000 }
```

---

## Error Responses

All endpoints return errors in this format:

```json
{ "name": "ErrorName", "message": "Error message description" }
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Bad Request — invalid input |
| `401` | Unauthorized — auth required, token invalid, or insufficient permission |
| `404` | Not Found |
| `429` | Too Many Requests — rate limit exceeded |
| `500` | Internal Server Error |
| `502` | Bad Gateway — upstream service failure (e.g. SMS delivery) |
