# db-architecture-review

Document a PostgreSQL schema **and** review its design in one run. Docs and
review come from the same model, so a finding always points at a table you
can click through to, and the docs show every flaw next to the table it
belongs to.

```
node scripts/db-review.ts schema.sql --narratives narratives.json --out docs/database
```

produces

```
docs/database/
├── index.html      self-contained browsable docs, findings inline, filter box, a whole-schema SVG diagram plus an inline SVG diagram and a relationship list per domain
├── schema.json     the model + findings (input for the Claude Code judgment pass)
├── README.md       markdown index embedding the whole-schema diagram
├── erd.svg         whole-schema entity-relationship diagram (plain SVG, renders anywhere)
├── FINDINGS.md     findings by severity, each with cause, effect and fix SQL
└── domains/        one .md page per domain with its own .svg diagram and a Relationships list (facts + why)
```

and exits `1` if any error-severity finding exists (`--fail-on` to tune).

## Install

```
npm install                 # one dependency: libpg-query, a WebAssembly build of the real PostgreSQL parser
```

Node 24 or newer. Node runs the `.ts` file directly, so there is no build step.

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
  `singleton_tables`, `cardinality[]` (`{parent, child, expect: "1:1"|"1:N", why, columns}` —
  `expect` and `why` are optional; `why` is printed beside the relationship in the docs;
  `columns` names which foreign key the entry means and is needed when a table has two
  foreign keys to the same parent), `natural_keys[]`, `exclusive_arcs[]`,
  `accepted[]` (`{check, table, columns, why}` — a finding reviewed and judged wrong
  for this schema; see below).

### Dismissing a finding you have checked

Some findings are wrong for a particular schema, and a checker cannot know it. A
`CHECK` on a column holding Apple's webhook vocabulary would reject the next value
Apple invents; a partial unique index on a soft-delete column is wrong when the
soft delete is meant to be reversible. Record the judgement so it stops being
re-litigated:

```json
"accepted": [
  {
    "check": "undocumented-enum",
    "table": "subscription_events",
    "columns": ["event_type"],
    "why": "Apple owns this vocabulary and adds to it. A CHECK would fail the webhook insert on any type Apple invents, dropping a real purchase event."
  }
]
```

An entry is matched on `check`, `table` and `columns` — never on the finding id,
which is renumbered whenever a check moves. Omit `columns` for a finding about the
whole table (`orphan-table`, `wide-table`); a columns-less entry never matches a
column finding, so it cannot silently swallow the next one that appears.

Dismissed findings are **printed, not hidden** — FINDINGS.md gets a "Reviewed and
dismissed" section carrying each `why`, and `schema.json` gets a `dismissed` array.
They do not count toward the severity totals and do not trip `--fail-on`.

Two ways an entry is refused, both reported as an `accepted-entry` warning rather
than applied quietly: an entry with no `why` (the reasoning is the whole value of
the record), and an entry that matches no finding, which means either the problem
was fixed or something was renamed and the entry is now dismissing nothing while
looking like it does.

The narratives are optional (`--narratives` omitted → docs + physical checks
only), but the interesting findings — wrong cardinality, unenforced natural
keys, tenant gaps — need a claim to check against.

## Checks

| id | severity | what it catches |
|---|---|---|
| domain-coverage | error | table in no domain / domain lists a phantom table |
| primary-key | error | table without PK |
| cardinality | error/warn | asserted 1:1 modelled as 1:N (no UNIQUE on FK) or vice versa; asserted relationship with no FK; ambiguous or empty-`columns` entry |
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
| undocumented-relationship | info | foreign key with no `why` in narratives.json (only with `require_relationship_notes`) |
| blast-radius | info | hub tables (≥5 dependents) |
| wide-table | info | ≥30 columns |
| accepted-entry | warn | an `accepted[]` entry with no `why`, or matching no finding |

Every finding has `detail` (what is allowed and why it hurts), `suggestion`,
and usually `fix_sql`.

## In CI

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npm ci
- run: node scripts/db-review.ts db/schema.sql --narratives db/narratives.json --out docs/database --fail-on error
```

`npm ci` runs where `package.json` lives; add `working-directory:` if the skill sits under `.claude/skills/`. Commit `docs/database/` so the review lives next to the schema.

## With Claude Code

This folder is a Claude Code plugin. Install it from the marketplace at the
repo root:

```
/plugin marketplace add greenstevester/db-architecture-reviewer
/plugin install db-architecture-review@db-architecture-reviewer
```

or, for local development, `claude --plugin-dir /path/to/this/folder`. Then
ask Claude to "review the data model". It runs the script, then does the
part the script can't — comparing the narrative to the schema relationship
by relationship and writing the extension-pain scenarios — into
`docs/database/REVIEW.md`. See `SKILL.md` and `references/review-checklist.md`.

## Try it

```
node scripts/db-review.ts examples/sample-schema.sql --narratives examples/narratives.json --out examples/out
open examples/out/index.html
```

The sample schema has 19 tables with every flaw marked `⚠ FLAW`; the run
finds all of them and nothing else. `npm test` runs that sample and a second
fixture (`test/fixtures/edge-cases.sql`, every construct the sample lacks) and
compares every output file with the committed output, so a change to a check
shows up as a diff. It also renders 54 CHECK and DEFAULT expressions and
compares each with what the original Python tool printed.

## Limits

PostgreSQL only (the parser is PostgreSQL's own). Triggers, views and
functions are recorded as "unparsed" statement kinds in `schema.json`, not
analysed. The script cannot see application code — that is what the
narratives and the Claude pass are for.
