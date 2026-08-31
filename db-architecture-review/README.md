# db-architecture-review

Document a PostgreSQL schema **and** review its design in one run. Docs and
review come from the same model, so a finding always points at a table you
can click through to, and the docs show every flaw next to the table it
belongs to.

```
python scripts/db_review.py schema.sql --narratives narratives.json --out docs/database
```

produces

```
docs/database/
├── index.html      self-contained browsable docs, findings inline, filter box
├── schema.json     the model + findings (input for the Claude Code judgment pass)
├── README.md       markdown index
├── FINDINGS.md     findings by severity, each with cause, effect and fix SQL
└── domains/*.md    one page per domain with a Mermaid ERD
```

and exits `1` if any error-severity finding exists (`--fail-on` to tune).

## Install

```
pip install pglast          # bundles libpg_query — the real PostgreSQL parser
```

Python 3.10+. No other dependencies.

## The two files you give it

**`schema.sql`** — one PostgreSQL DDL file. `pg_dump --schema-only` from a
dev database is the most honest source; concatenated Flyway migrations work
too. `CREATE TABLE`, `ALTER TABLE … ADD CONSTRAINT / ENABLE ROW LEVEL
SECURITY`, `CREATE INDEX` (incl. partial), `CREATE POLICY`, `CREATE TYPE …
AS ENUM`, `COMMENT ON` are all understood. `-- comments` directly above a
table and at the end of a column line become descriptions.

**`narratives.json`** — human intent, in two parts. See
`examples/narratives.json`.

- `domains[]`: key, title, blurb, `tenant_scoped`, `tables[]`. Every table
  must be claimed by exactly one domain or the run fails — that is the
  "a new table cannot silently fall out of the docs" gate.
- `assertions`: claims the script can check mechanically —
  `tenant_table` / `tenant_column` / `require_rls`, `global_tables`,
  `singleton_tables`, `cardinality[]` (`{parent, child, expect: "1:1"|"1:N"}`),
  `natural_keys[]`, `exclusive_arcs[]`.

The narratives are optional (`--narratives` omitted → docs + physical checks
only), but the interesting findings — wrong cardinality, unenforced natural
keys, tenant gaps — need a claim to check against.

## Checks

| id | severity | what it catches |
|---|---|---|
| domain-coverage | error | table in no domain / domain lists a phantom table |
| primary-key | error | table without PK |
| cardinality | error/warn | asserted 1:1 modelled as 1:N (no UNIQUE on FK) or vice versa; asserted relationship with no FK |
| natural-key | error | asserted business key not UNIQUE |
| junction-uniqueness | error | M:N link table that allows duplicate pairs |
| money-float | error | amount/price/… stored as float |
| rls-missing / rls-no-policy | error | tenant table without RLS, or RLS with no policy |
| tenant-unscoped | error | tenant-scoped domain, no path to the tenant at all |
| tenant-derivable | warn (info for junctions) | no `tenant_id`, tenant only reachable via joins |
| fk-index | warn | FK column with no index (Postgres does not add one) |
| undocumented-enum | warn | short `status`/`type`/… string with no CHECK |
| soft-delete-unique | warn | `deleted_at` + non-partial UNIQUE |
| polymorphic-reference | warn | `x_type` + `x_id` pair with no FK |
| exclusive-arc | warn/info | several nullable FKs, no CHECK that exactly one is set |
| fk-cycle | warn | circular FK dependencies |
| fk-nullable | info | optional relationship — confirm it's intentional |
| fk-on-delete | info | tenant FK relying on default NO ACTION |
| timestamp-tz | info | TIMESTAMP without time zone |
| orphan-table | info | references nothing, referenced by nothing |
| singleton-table | info | documented single-row table with nothing enforcing it |
| blast-radius | info | hub tables (≥5 dependents) |
| wide-table | info | ≥30 columns |

Every finding has `detail` (what is allowed and why it hurts), `suggestion`,
and usually `fix_sql`.

## In CI

```yaml
- run: pip install pglast
- run: python scripts/db_review.py db/schema.sql --narratives db/narratives.json --out docs/database --fail-on error
```

Commit `docs/database/` so the review lives next to the schema.

## With Claude Code

This folder is a skill. Drop it in `.claude/skills/db-architecture-review/`
(or your shared config repo) and ask Claude to "review the data model". It
runs the script, then does the part the script can't — comparing the
narrative to the schema relationship by relationship and writing the
extension-pain scenarios — into `docs/database/REVIEW.md`. See `SKILL.md`
and `references/review-checklist.md`.

## Try it

```
python scripts/db_review.py examples/sample-schema.sql --narratives examples/narratives.json --out examples/out
open examples/out/index.html
```

The sample schema has 19 tables with every flaw marked `⚠ FLAW`; the run
finds all of them and nothing else.

## Limits

PostgreSQL only (the parser is PostgreSQL's own). Triggers, views and
functions are recorded as "unparsed" statement kinds in `schema.json`, not
analysed. The script cannot see application code — that is what the
narratives and the Claude pass are for.
