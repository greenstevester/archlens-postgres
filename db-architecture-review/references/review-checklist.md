# Review checklist — the questions a parser can't answer

Use with `schema.json` open. Each item says what to look at, what "wrong"
looks like, and how to phrase it so it lands. Skip items that don't apply;
don't pad the review.

## A. Cardinality — does the schema enforce what the prose says?

1. **Read every relationship sentence in the domain blurbs** ("each tenant
   has one…", "a request belongs to…", "users can have many…"). For each,
   find the FK in `tables[child].fks` and check `cardinality` and `unique`.
   - Prose says *one*, FK not unique → accidental 1:N (script catches this
     only for pairs listed in `assertions.cardinality`; add the pair).
   - Prose says *many*, FK unique → second child cannot be inserted.
   - Prose says *belongs to*, FK `nullable: true` → orphans are legal.
2. **Column names that lie about cardinality.** `user_id` on a table whose
   blurb says "shared between users"; `roles` (plural) as a VARCHAR;
   `parent_id` with no CHECK against self-reference loops.
3. **Missing relationships.** Two tables in the same domain with no FK
   path between them but obviously related by name (`invoice`,
   `invoice_line` with only `tenant_id` in common). The relationship lives
   in application code, which means it lives nowhere.
4. **Wrong direction.** A FK from parent to child (`tenant.settings_id`)
   is a 1:1 pretending to be an ownership; deletion order and RLS both
   get awkward.

## B. Identity — what makes a row *that* row?

5. **Every table with a surrogate UUID PK and no other unique constraint.**
   Ask: what would a human use to say "this one"? `(tenant_id, slug)`,
   `(installation_id)`, `(external_ref)`. If it exists in prose and not in
   the schema, it's a `natural_keys` assertion waiting to be added.
6. **Idempotency keys for anything that arrives from outside** (webhooks,
   imports, message queues): delivery GUID, event id, provider reference.
   Retries are the norm, not the exception.

## C. Multi-tenancy — can every row be attributed to exactly one tenant?

7. Tables without `tenant_id`: is the transitive path (`tenant-derivable`
   finding) acceptable? It usually is for junction tables and is usually
   not for anything queried per tenant in a hot path, exported per tenant,
   or erased per tenant.
8. **Tenant hierarchy depth.** If the blurb mentions sub-tenants, is that a
   self-reference on `tenant` (then: closure table or recursive CTE cost)
   or a separate table? What happens to RLS policies keyed on a single
   `tenant_id` when a parent must see children?
9. **Cross-tenant references.** Any FK whose parent and child are both
   tenant-scoped needs the tenant to match. A composite FK
   `(tenant_id, x_id) → parent(tenant_id, id)` enforces it; a plain FK
   allows tenant A's row to point at tenant B's.

## D. State and time

10. **Status columns are state machines.** For each `status`/`state`:
    what are the transitions, and is there an audit of them? A CHECK gives
    you the set; nothing gives you the graph. If the blurb describes a
    workflow, note whether transitions are recoverable.
11. **Mutable tables that the business will ask "what was this last
    month?" about** (pricing, permissions, config). No `valid_from`/
    `valid_to` or history table → the answer will be "we don't know".
12. **`updated_at` without a trigger** is a column that lies. Check for
    `CREATE TRIGGER` in the DDL; if absent, say so once.
13. **Soft delete semantics.** Beyond the UNIQUE collision the script
    finds: do FKs from other tables filter `deleted_at IS NULL`? (They
    can't. Deleted parents keep live children.)

## E. Entities hiding in the wrong place

14. **JSONB columns with a described structure** in the blurb or comment
    ("settings holds notification prefs") — that's a table with no
    constraints. Fine for opaque payloads (webhook bodies), not for data
    the app queries by key.
15. **Comma/pipe-separated lists in VARCHAR** (`tags`, `scopes`, `roles`).
16. **Two tables that are the same entity** with a discriminator missing
    (`user_github_token` and `tenant_github_token`): would one table with
    an `owner_type` be worse? Usually yes — but say why.
17. **Wide tables** where column groups change together (address_*,
    billing_*). Not urgent; note it.

## F. Extension scenarios — write these as short stories

Pick the 3–5 most plausible for *this* product. For each: the change →
which tables/findings it touches → cost now vs cost after a year of data.

- A second instance of anything documented as single (`singleton-table`):
  second provider, second GitHub App, staging config beside prod config.
- One more level in a hierarchy (sub-tenants, sub-projects).
- "Delete a tenant completely" (GDPR): follow `ON DELETE` actions from the
  tenant table; every `NO ACTION` on the path is a manual step; every
  `tenant-derivable` table is a join in the erasure job.
- "Show history of X" for a mutable table with no temporal columns.
- "Shard / partition by tenant": every table without `tenant_id` needs a
  denormalisation migration first.
- "Bulk import" against tables whose natural key is not enforced
  (duplicates on retry) or whose FK is unindexed (import is O(n²)).
- Renaming a hub table's key or changing its type: count `referenced_by`.

## G. Physical layer — only what the script doesn't already report

18. Indexes that exist but never get used: composite indexes whose leading
    column is low-cardinality (`status`, boolean) — say so when obvious.
19. Missing indexes for the access paths the blurb implies ("list a
    tenant's open requests" → `(tenant_id, status)` or partial).
20. Partitioning candidates: append-only tables with a time column and no
    retention story (`audit_event`, `webhook_delivery`).
21. `BIGSERIAL` vs identity columns: cosmetic; mention only if the project
    says it standardises.

## H. Things that are fine — say so

If RLS is on everywhere it should be, if junction tables have composite
PKs, if money is NUMERIC, if the tenant hierarchy is enforced with
composite FKs: name the two or three strongest decisions in the schema.
Reviews that only find fault get skimmed; reviews that show they
understood the good choices get acted on.
