# Design review findings

Deterministic checks run by `archlens.ts`. Each finding states what the schema allows today, why it hurts, and the smallest change that fixes it. The LLM review pass (see SKILL.md) builds on top of these.

## Errors (8)

### F016 · github_app_installation `tenant_id, installation_id` — Asserted natural key is not enforced

`(tenant_id, installation_id)` is declared to identify a `github_app_installation` row, but nothing enforces it. Retries, double-submits and webhook redeliveries create duplicates.

**Fix:** Add a unique constraint (partial if the table is soft-deleted).

```sql
ALTER TABLE github_app_installation ADD CONSTRAINT github_app_installation_tenant_id_installation_id_key UNIQUE (tenant_id, installation_id);
```

### F029 · invoice_line `amount` — Monetary value stored as float

`amount` is binary floating point. 0.1 + 0.2 ≠ 0.3; sums drift; reconciliation against the ledger will be off by cents.

**Fix:** Use NUMERIC(p, s) or integer minor units.

```sql
ALTER TABLE invoice_line ALTER COLUMN amount TYPE numeric(14,2);
```

### F034 · invoice_line `tenant_id` — Tenant table without row-level security

`invoice_line` carries `tenant_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.

**Fix:** Enable RLS and add the standard policy.

```sql
ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_line_tenant_isolation ON invoice_line USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### F001 · legacy_import_staging — Table is in no domain

Every table must be claimed by a domain in narratives.json, otherwise it silently falls out of the documentation and of any per-domain backup/retention policy.

**Fix:** Add it to the right domain's `tables` list, or delete the table if it is dead.

### F015 · tenant_settings `tenant_id` — Modelled 1:N but intended 1:1

The narrative says each `tenant` has exactly one `tenant_settings`, but `tenant_id` is not UNIQUE, so the database happily stores five. Application code that does `.single()` or `LIMIT 1` will return an arbitrary row.

**Fix:** Make the FK column(s) unique — or make it the primary key.

```sql
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_tenant_id_key UNIQUE (tenant_id);
```

### F002 · user_role — No primary key

Without a primary key rows are not individually addressable: no safe UPDATE/DELETE of one row, no logical replication, ORMs misbehave, and duplicates are legal.

**Fix:** Add a natural composite key or a surrogate id.

```sql
ALTER TABLE user_role ADD PRIMARY KEY (...);
```

### F018 · user_role `role_id, user_id` — Junction table allows duplicate links

`user_role` looks like a many-to-many link table but has no unique constraint across (role_id, user_id). The same pair can be inserted twice; every join through it will double-count.

**Fix:** Use the FK pair as the primary key (or add a UNIQUE).

```sql
ALTER TABLE user_role ADD PRIMARY KEY (role_id, user_id);
```

### F017 · webhook_delivery `delivery_guid` — Asserted natural key is not enforced

`(delivery_guid)` is declared to identify a `webhook_delivery` row, but nothing enforces it. Retries, double-submits and webhook redeliveries create duplicates.

**Fix:** Add a unique constraint (partial if the table is soft-deleted).

```sql
ALTER TABLE webhook_delivery ADD CONSTRAINT webhook_delivery_delivery_guid_key UNIQUE (delivery_guid);
```

## Warnings (18)

### F008 · approval_request `service_request_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `service_request` must scan `approval_request` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `approval_request` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `service_request` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add a partial index, scoped to the rows that have a value. `service_request_id` is nullable, so the NULL rows are not indexed at all and the write cost is a fraction of a full index, while the constraint check still uses it.

```sql
CREATE INDEX CONCURRENTLY idx_approval_request_service_request_id ON approval_request(service_request_id) WHERE service_request_id IS NOT NULL;
```

### F009 · approval_request `deployment_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `deployment` must scan `approval_request` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `approval_request` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `deployment` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add a partial index, scoped to the rows that have a value. `deployment_id` is nullable, so the NULL rows are not indexed at all and the write cost is a fraction of a full index, while the constraint check still uses it.

```sql
CREATE INDEX CONCURRENTLY idx_approval_request_deployment_id ON approval_request(deployment_id) WHERE deployment_id IS NOT NULL;
```

### F010 · approval_request `approved_by` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `users` must scan `approval_request` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `approval_request` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `users` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add a partial index, scoped to the rows that have a value. `approved_by` is nullable, so the NULL rows are not indexed at all and the write cost is a fraction of a full index, while the constraint check still uses it.

```sql
CREATE INDEX CONCURRENTLY idx_approval_request_approved_by ON approval_request(approved_by) WHERE approved_by IS NOT NULL;
```

### F026 · approval_request `service_request_id, deployment_id` — Either/or foreign keys without a CHECK

`approval_request` has several nullable FKs (service_request_id, deployment_id) that look like an exclusive arc — a row should point at exactly one of them. Nothing stops zero or both.

**Fix:** Add a CHECK that exactly one is non-null, or restructure with a supertype.

```sql
ALTER TABLE approval_request ADD CONSTRAINT approval_request_one_target CHECK ((service_request_id IS NOT NULL)::int + (deployment_id IS NOT NULL)::int = 1);
```

### F023 · audit_event `actor_type` — Enum-like column with no CHECK

`actor_type` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code. The comment lists `user | system`, i.e. the values are known.

**Fix:** Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need metadata. Avoid native ENUM types unless the set is truly frozen.

```sql
ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN (...));
```

### F025 · audit_event `actor_type, actor_id` — Polymorphic reference without referential integrity

`actor_id` points at different tables depending on `actor_type`. No FK can express that, so orphans accumulate silently and every join needs a CASE. Acceptable for append-only audit data; painful anywhere the target must still exist.

**Fix:** Either one nullable FK per target with a CHECK that exactly one is set, or a supertype table that the targets reference.

### F006 · github_app_config `created_by` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `users` must scan `github_app_config` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `github_app_config` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `users` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add a partial index, scoped to the rows that have a value. `created_by` is nullable, so the NULL rows are not indexed at all and the write cost is a fraction of a full index, while the constraint check still uses it.

```sql
CREATE INDEX CONCURRENTLY idx_github_app_config_created_by ON github_app_config(created_by) WHERE created_by IS NOT NULL;
```

### F020 · github_app_config `status` — Enum-like column with no CHECK

`status` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code.

**Fix:** Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need metadata. Avoid native ENUM types unless the set is truly frozen.

```sql
ALTER TABLE github_app_config ADD CONSTRAINT github_app_config_status_check CHECK (status IN (...));
```

### F021 · github_app_installation `target_type` — Enum-like column with no CHECK

`target_type` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code. The comment lists `Organization | User`, i.e. the values are known.

**Fix:** Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need metadata. Avoid native ENUM types unless the set is truly frozen.

```sql
ALTER TABLE github_app_installation ADD CONSTRAINT github_app_installation_target_type_check CHECK (target_type IN (...));
```

### F022 · github_app_installation `repository_selection` — Enum-like column with no CHECK

`repository_selection` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code. The comment lists `all | selected`, i.e. the values are known.

**Fix:** Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need metadata. Avoid native ENUM types unless the set is truly frozen.

```sql
ALTER TABLE github_app_installation ADD CONSTRAINT github_app_installation_repository_selection_check CHECK (repository_selection IN (...));
```

### F003 · sessions `user_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `users` must scan `sessions` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `sessions` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `users` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_sessions_user_id ON sessions(user_id);
```

### F030 · sessions — No `tenant_id`; tenant only reachable via 2 join(s)

`sessions` belongs to a tenant only transitively (sessions → users → tenant). Row-level security, per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 tenants and hurts at 1,000.

**Fix:** Denormalise `tenant_id` onto the table (with a composite FK to keep it consistent), or accept the join and write the RLS policy as a subquery now, while it is cheap.

### F019 · tenant `status` — Enum-like column with no CHECK

`status` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code.

**Fix:** Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need metadata. Avoid native ENUM types unless the set is truly frozen.

```sql
ALTER TABLE tenant ADD CONSTRAINT tenant_status_check CHECK (status IN (...));
```

### F004 · user_role `user_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `users` must scan `user_role` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `user_role` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `users` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_user_role_user_id ON user_role(user_id);
```

### F005 · user_role `role_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `role` must scan `user_role` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `user_role` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `role` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_user_role_role_id ON user_role(role_id);
```

### F024 · users `email` — Soft delete collides with non-partial UNIQUE

`users` soft-deletes via `deleted_at`, but `(email)` is unique across live AND deleted rows. A user who deletes their account can never sign up again with the same value, and `ON CONFLICT` upserts will resurrect ghosts.

**Fix:** Replace with a partial unique index scoped to live rows.

```sql
DROP CONSTRAINT/INDEX ...; CREATE UNIQUE INDEX users_email_live ON users(email) WHERE deleted_at IS NULL;
```

### F007 · webhook_delivery `installation_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `github_app_installation` must scan `webhook_delivery` to check the constraint, and every join from the parent side is a sequential scan. The scan cost grows with the child table forever, so this gets worse on its own.

An index is not free. Every write to `webhook_delivery` maintains it — insert, update and delete alike — and it takes disk. Weigh that against how often `github_app_installation` rows are actually deleted or re-keyed — if the answer is never, the scan never happens and the index only costs.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_webhook_delivery_installation_id ON webhook_delivery(installation_id);
```

### F033 · webhook_delivery — No `tenant_id`; tenant only reachable via 2 join(s)

`webhook_delivery` belongs to a tenant only transitively (webhook_delivery → github_app_installation → tenant). Row-level security, per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 tenants and hurts at 1,000.

**Fix:** Denormalise `tenant_id` onto the table (with a composite FK to keep it consistent), or accept the join and write the RLS policy as a subquery now, while it is cheap.

## Notes (12)

### F012 · approval_request `approved_by` — Nullable foreign key

`approval_request.approved_by` may be NULL, so the relationship to `users` is optional. That is legitimate (e.g. approved_by before approval) but often a modelling shrug: a row with no owner, or two nullable FKs that are secretly an either/or.

**Fix:** Confirm the optionality is a domain rule; document it in the column comment.

### F013 · audit_event `tenant_id` — Tenant FK relies on the default ON DELETE NO ACTION

Deleting a `tenant` row will fail while `audit_event` rows exist. Fine if tenants are never hard-deleted; a surprise the day offboarding/GDPR erasure is built.

**Fix:** State the intent explicitly: CASCADE, RESTRICT, or an offboarding job.

### F028 · audit_event `occurred_at` — TIMESTAMP without time zone

`occurred_at` stores wall-clock time with no zone. It reads back differently depending on the session's TimeZone, and DST transitions produce ambiguous values.

**Fix:** Use TIMESTAMPTZ.

```sql
ALTER TABLE audit_event ALTER COLUMN occurred_at TYPE timestamptz;
```

### F011 · github_app_config `created_by` — Nullable foreign key

`github_app_config.created_by` may be NULL, so the relationship to `users` is optional. That is legitimate (e.g. approved_by before approval) but often a modelling shrug: a row with no owner, or two nullable FKs that are secretly an either/or.

**Fix:** Confirm the optionality is a domain rule; document it in the column comment.

### F036 · github_app_config — Single-row configuration table

`github_app_config` is documented as holding exactly one row. Nothing enforces that (no unique constraint besides the PK), and the day a second instance is needed (a second GitHub App, a staging vs prod config) every reader that does `SELECT * ... LIMIT 1` becomes wrong.

**Fix:** Either enforce one row (CHECK on a constant column with a UNIQUE) or give it a discriminator now (`provider_id`, `environment`) while there is only one row to backfill.

```sql
ALTER TABLE github_app_config ADD COLUMN singleton boolean NOT NULL DEFAULT true CHECK (singleton);
CREATE UNIQUE INDEX github_app_config_one_row ON github_app_config(singleton);
```

### F014 · invoice_line `tenant_id` — Tenant FK relies on the default ON DELETE NO ACTION

Deleting a `tenant` row will fail while `invoice_line` rows exist. Fine if tenants are never hard-deleted; a surprise the day offboarding/GDPR erasure is built.

**Fix:** State the intent explicitly: CASCADE, RESTRICT, or an offboarding job.

### F035 · legacy_import_staging — Isolated table

`legacy_import_staging` references nothing and nothing references it. Either it is a staging/log table (fine, say so), or it is dead, or it is the seed of a second data model growing beside the first.

**Fix:** Document its purpose or drop it.

### F031 · role_permission — No `tenant_id`; tenant only reachable via 2 join(s)

`role_permission` belongs to a tenant only transitively (role_permission → role → tenant). Row-level security, per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 tenants and hurts at 1,000.

**Fix:** Denormalise `tenant_id` onto the table (with a composite FK to keep it consistent), or accept the join and write the RLS policy as a subquery now, while it is cheap.

### F027 · sessions `expires_at` — TIMESTAMP without time zone

`expires_at` stores wall-clock time with no zone. It reads back differently depending on the session's TimeZone, and DST transitions produce ambiguous values.

**Fix:** Use TIMESTAMPTZ.

```sql
ALTER TABLE sessions ALTER COLUMN expires_at TYPE timestamptz;
```

### F037 · tenant — Hub table: referenced by 10 tables

Any change to its key, its delete semantics, or its partitioning touches every dependent. Migrations on hub tables need the longest lock windows and the most careful rollout.

**Fix:** Treat schema changes here as breaking changes with a written rollout plan.

### F032 · user_role — No `tenant_id`; tenant only reachable via 2 join(s)

`user_role` belongs to a tenant only transitively (user_role → users → tenant). Row-level security, per-tenant export/erasure, and per-tenant sharding all need that join. It works at 10 tenants and hurts at 1,000.

**Fix:** Denormalise `tenant_id` onto the table (with a composite FK to keep it consistent), or accept the join and write the RLS policy as a subquery now, while it is cheap.

### F038 · users — Hub table: referenced by 5 tables

Any change to its key, its delete semantics, or its partitioning touches every dependent. Migrations on hub tables need the longest lock windows and the most careful rollout.

**Fix:** Treat schema changes here as breaking changes with a written rollout plan.

