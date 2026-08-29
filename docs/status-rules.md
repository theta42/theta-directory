---
layout: default
title: Status Rules
nav_order: 8
---

# Status Rules

[← Back to Home](index.html)

A resource's dot in the directory tree, and the badge at the top of its Status
tab, are not read from telemetry directly. They are *computed*: a background
job walks every resource, finds the `SubtypeTemplate` for its subtype, and
evaluates that template's `status_rules` against the facts the system has
about it. The result is written to `metadata.status` and
`metadata.status_message`.

The job is `runStateEvaluation` in `nodejs/services/scheduler.js`. It runs on
the scheduler's tick; nothing evaluates rules on the request path, so a rule
that is slow or wrong degrades a dot, never a page load.

## Where rules live

On the subtype template, as a JSON array:

```json
{
  "slug": "linux",
  "name": "Linux Server",
  "target_kind": "host",
  "status_rules": [
    { "condition": "telemetry.cpu_usage_percent == null", "status": "unknown", "message": "No telemetry yet" },
    { "condition": "telemetry.disk_usage_percent > 90",   "status": "critical", "message": "Disk nearly full" },
    { "condition": "telemetry.cpu_usage_percent > 80",    "status": "warning",  "message": "High CPU" },
    { "condition": "true",                                 "status": "ok",       "message": "Healthy" }
  ]
}
```

Rules are evaluated **in order, first match wins**. Put the most serious
conditions first, and end with a `"condition": "true"` catch-all — without one,
a resource that matches nothing is left `unknown`.

A rule is:

| field       | required | meaning                                                    |
|-------------|----------|------------------------------------------------------------|
| `condition` | yes      | expression, below. A rule with no condition is skipped.     |
| `status`    | no       | `ok`, `warning`, `critical`, `error`, `unknown`. Default `unknown`. |
| `message`   | no       | shown in the tooltip and the Status tab.                    |

`status` is free text as far as the evaluator is concerned, but only the values
above have colours in the UI (`ok` green, `warning` amber, `critical`/`error`
red, `unknown` grey). Anything else renders grey.

## The expression language

Deliberately small. Rules are rows in a database that any directory admin can
edit, so the evaluator has no way to call a function, construct one, or reach
anything that was not explicitly put in its context. Anything outside the
grammar below is a syntax error, and a rule that fails to parse is logged and
skipped — it never matches, and never stops the other rules from running.

**Operators**, in precedence order (tightest first):

```
!                     logical not (prefix)
<  <=  >  >=          comparison
==  !=                equality  (loose, JS ==)
&&                    and
||                    or
( )                   grouping
```

**Values**: numbers (`80`, `0.5`), single- or double-quoted strings
(`'prod'`), and the literals `true`, `false`, `null`.

**Paths**: dotted, and must start with one of these five roots.

| root                  | is                                                                 |
|-----------------------|--------------------------------------------------------------------|
| `metadata`            | the resource's own `metadata` object                                |
| `telemetry`           | the last telemetry payload from the agent on this resource's host    |
| `plugin`              | the `lastStatus` **string** of a discovery plugin that reported it   |
| `environment`         | this resource's own `metadata.environment`                          |
| `bubbled_environment` | the most critical environment among this resource and its descendants |

Two things about paths are worth knowing:

* **Missing is `null`-ish, not an error.** `telemetry.cpu_usage_percent` on a
  host with no agent is `undefined`, so `== null` is true. That is the idiom
  for "no data yet", and it is why a rule can distinguish *unknown* from
  *healthy*.
* **Own properties only.** `metadata.constructor` reads as absent, not as the
  `Object` constructor. There is no way to walk the prototype chain.

`plugin` is a bare string, not an object — `plugin == 'ok'` works,
`plugin.status` does not.

### `environment` vs `bubbled_environment`

`environment` is what an operator declared this one resource to be: `prod`,
`testing`, or `dev`. Nothing else writes it — in particular no discovery plugin
does, because power state is not an environment (a prod database that is
powered off is still prod).

`bubbled_environment` is that value rolled **up** the tree: a resource is as
critical as the most critical thing running under it. If one LXC is `prod`,
then its host, its cluster and its site all report `bubbled_environment` of
`prod`. This is the same string the graph API and the directory tree show.

Which makes the useful pattern:

```json
{ "condition": "bubbled_environment == 'prod' && telemetry.disk_usage_percent > 80",
  "status": "critical", "message": "Disk filling on a production host" },
{ "condition": "telemetry.disk_usage_percent > 80",
  "status": "warning", "message": "Disk filling" }
```

— the same disk threshold is an emergency on a machine carrying production
work and a note on a lab box, without needing two subtypes.

## Examples

```
telemetry.cpu_usage_percent > 80
telemetry.disk_usage_percent > 90 || telemetry.ram_usage_percent > 95
metadata.powerState == 'Off'
plugin == 'error'
!metadata.managed
telemetry.cpu_usage_percent == null && metadata.managed
bubbled_environment == 'prod' && plugin != 'ok'
true
```

## What is deliberately not here

No arithmetic (`+`, `-`, `*`), no function calls, no regular expressions, no
`in`, no array indexing. Each of those is a reasonable thing to want and a
reasonable thing to add later; none of them is worth adding speculatively to an
evaluator whose entire value is that its grammar is small enough to audit in
one sitting.

If a rule needs something the language cannot express, the answer is usually to
compute it where the data is produced — a discovery plugin or the agent — and
put the result in `metadata`, where a rule can simply compare it.
