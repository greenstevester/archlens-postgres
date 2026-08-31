# Schema review — Portal database — 2026-08-31

## Verdict

The model is structurally sound: a clean Provider → Tenant spine, correct
junctioning for role ↔ permission, native ENUM where it matters (approval
state), RLS on most tenant tables. The one structural risk is that
*identity* is under-enforced — three business keys exist only in prose
(`tenant_settings` per tenant, `(tenant_id, installation_id)`,
`delivery_guid`), so retries and double-submits create rows the
application assumes cannot exist. Fix those three before the next release;
everything else can be scheduled.

## What this schema is

Nineteen tables in six domains. `tenant` is the hub (10 dependents) and
`users` the secondary hub (5). Everything tenant-scoped carries `tenant_id`
except `sessions`, `user_role`, `role_permission` and `webhook_delivery`,
which reach the tenant through one join. The GitHub integration is
provider-level: one `github_app_config` row serves all tenants, each tenant
maps to it via `github_app_installation`, and raw deliveries hang off the
installation.

Strongest decisions: `tenant_auth_config` uses the tenant id as its primary
key (1:1 enforced by construction — this is the pattern `tenant_settings`
should copy); `role_permission` has the composite PK and the reverse index;
`audit_event` is documented append-only with a `(tenant_id, occurred_at)`
index that matches the obvious query.

## Mechanical findings

8 errors · 18 warnings · 12 notes — see `FINDINGS.md`. The five that matter:

1. F015 `tenant_settings.tenant_id` not UNIQUE — intended 1:1, modelled 1:N.
2. F016 `github_app_installation (tenant_id, installation_id)` not enforced.
3. F017 `webhook_delivery.delivery_guid` not enforced — GitHub redelivers.
4. F002/F018 `user_role` has no key at all; duplicate grants are legal.
5. F029 `invoice_line.amount` is a float.

## Cardinality: claimed vs enforced

| Relationship | Narrative says | Schema enforces | Gap |
|---|---|---|---|
| tenant → tenant_settings | exactly one | 1:N | UNIQUE missing (F015) |
| tenant → tenant_auth_config | at most one | 1:1 (PK) | none |
| tenant → users | many | 1:N | none |
| github_app_config → github_app_installation | one App, many installations | *no FK at all* | installation does not reference the config; a second App row cannot be attributed |
| github_app_installation → webhook_delivery | many | 1:N, unindexed | index (F011) |
| users → sessions | many | 1:N, unindexed | index (F003) |
| approval_request → service_request / deployment | exactly one of | both nullable, no CHECK | F024 |

The `github_app_config → installation` row is new: the script can't flag a
relationship that has no FK unless it is asserted, and the narrative only
implied it. Added to `assertions.cardinality`.

## Where the next change will hurt

**A second GitHub App (e.g. one per provider, or a GHES instance).**
`github_app_config` is a singleton with no discriminator and no
`referenced_by`. Every reader does `LIMIT 1`. Adding `provider_id NOT NULL`
plus an FK from `github_app_installation.app_config_id` is a one-day change
today (one row to backfill) and a multi-week change once installations
exist for an App that cannot be identified. Do it now.

**Deleting a tenant (GDPR erasure).** Following `ON DELETE` from `tenant`:
`audit_event` and `invoice_line` use NO ACTION, so erasure fails until a job
handles them; `sessions`, `user_role`, `webhook_delivery` are reachable only
via joins. Erasure today is a five-table hand-written job. Decide the
policy — probably RESTRICT + an explicit offboarding procedure for the
audit/billing tables, CASCADE for the rest — and write it into the DDL.

**"Who changed this permission and when?"** `role`, `role_permission`,
`user_role` are mutable with no history. `audit_event` exists, but nothing
in the schema ties it to those tables. Cheap now: a trigger writing to
`audit_event`. Expensive later: reconstructing history that was never
recorded.

**1,000 tenants and the RLS policy on `webhook_delivery`.** No `tenant_id`,
so the policy is a subquery through `github_app_installation`. Fine at
today's volume; the first tenant with a million deliveries will find out.
Denormalise `tenant_id` onto the table with a composite FK
`(tenant_id, installation_id) → github_app_installation(tenant_id, id)`
(requires the UNIQUE from F016 first — the fixes chain).

**Bulk re-sync of installations from the GitHub API.** With F016 open, a
retry doubles the table; with the unindexed FK on `webhook_delivery`, the
cascade delete of a duplicate is a sequential scan per row.

## Recommended changes, ranked

| # | Change | Why | Cost |
|---|---|---|---|
| 1 | `UNIQUE (tenant_id)` on `tenant_settings` (or make it the PK like auth_config) | 1:1 is assumed by every reader | trivial; dedupe first |
| 2 | `UNIQUE (tenant_id, installation_id)`; `UNIQUE (delivery_guid)` | idempotency for external events | trivial if no duplicates yet |
| 3 | `PRIMARY KEY (user_id, role_id)` on `user_role` + index on `role_id` | duplicates double-count every permission join | trivial |
| 4 | `amount` → `NUMERIC(14,2)` | money | small; lock on a billing table — schedule |
| 5 | `provider_id` + FK on `github_app_config`; FK from installation | singleton escape hatch while it is one row | small now, large later |
| 6 | CHECK constraints on `tenant.status`, `github_app_config.status`, `target_type`, `repository_selection`, `actor_type` | the values are already known — they are in the comments | trivial |
| 7 | Partial unique on `users(email) WHERE deleted_at IS NULL` | re-registration after deletion | small |
| 8 | Indexes on the six unindexed FKs (CONCURRENTLY) | delete and join cost | zero risk |
| 9 | RLS on `invoice_line`; decide ON DELETE policy from `tenant` | isolation, erasure | small |
| 10 | `timestamptz` on `sessions.expires_at`, `audit_event.occurred_at` | DST correctness | small; rewrite |

## Assertions added to narratives.json

- `cardinality`: `{parent: github_app_config, child: github_app_installation, expect: "1:N"}` — will fail as "asserted relationship has no FK" until #5 lands, which is the point.
- `natural_keys`: `{table: user_role, columns: [user_id, role_id]}`.
- `singleton_tables` already lists `github_app_config`; left as is.
