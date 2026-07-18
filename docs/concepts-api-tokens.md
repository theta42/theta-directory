---
layout: default
title: API Tokens
description: A plain-language guide to personal access tokens in SSO Manager.
---

# API Tokens

This page explains what an API token is and when you'd want one. For the
full list of API endpoints a token can call, see the
[API reference](api.html).

## What's an API token, in plain terms?

Normally, you interact with this app by logging in through a web browser.
An **API token** (also called a personal access token, or PAT) is an
alternative way in — a long, random string that a script, a scheduled job,
or another program can use instead of a username and password, to act on
your behalf without a human typing a login in each time.

If you've ever set up a script to talk to GitHub, GitLab, or a similar
service using a "token" instead of your real password, this is the same
idea.

## When would you actually need one?

Most people never need to create one of these — you'll only want a token
if you're automating something, for example:

- A script that syncs users or groups from somewhere else into this SSO
  Manager on a schedule.
- A backup or monitoring job that checks this app's health via its API.
- A CI/CD pipeline that needs to register or update an OAuth client
  automatically.

If you're not doing any of that, you don't need an API token — just log in
normally through the web UI.

## How it works

Create a token from your Profile page, give it a name so you remember what
it's for later, and optionally an expiry. You'll be shown the token's
value **exactly once** — copy it somewhere safe immediately, because it
can't be viewed again afterward (only revoked or rotated). Whatever script
or tool you're using it with sends it along with each request, the same
way a browser sends your login session.

A token acts **as you**, with **your** permissions — if you're not an
admin, a token you create can't do admin-only things either. If you ever
suspect a token has leaked (ended up somewhere it shouldn't have, like a
public script or log file), revoke it immediately from your Profile page;
it stops working right away.

## Want more detail?

This page doesn't attempt to list every API endpoint or show request/
response examples — for that, see the full [API reference](api.html).

[← Back to Home](index.html)
