---
name: db-architecture-review
description: Document a project's PostgreSQL schema and rigorously review its logical and physical design in one pass — wrong cardinality, unenforced natural keys, junction tables that allow duplicates, tenant-isolation gaps, enum-ish columns with no CHECK, soft-delete/UNIQUE collisions, polymorphic references, and the places where the next feature will hurt. Use this whenever the user asks to review, audit, document, or sanity-check a database schema, data model, ERD, migrations, or "our tables"; when they ask whether a data model will scale or what an extension would break; or when a PR touches schema.sql / migrations and they want a design opinion, not just a syntax check. Also use it when asked to generate database documentation — the docs and the review come from the same run.
compatibility: Python 3.10+ and `pip install pglast` (bundles the real PostgreSQL parser). PostgreSQL DDL only.
---

# Database architecture review

Two halves, deliberately separated:

1. **Mechanical** — `scripts/db_review.py` parses the DDL with the real
   PostgreSQL parser, builds a model, joins it with human intent from
   `narratives.json`, runs ~20 deterministic checks, and writes browsable
   docs + `schema.json` + `FINDINGS.md`. It exits non-zero on errors, so it
   can gate CI.
2. **Judgment** — you read `schema.json` and the findings, compare what the
   narratives *claim* against what the schema *allows*, and reason about
   extension scenarios the script cannot see. Output: `REVIEW.md`.

The split matters. Anything the script can decide, the script decides, every
run, for free. Your job is the part that needs the domain story — and to
convert every judgment you make into an assertion in `narratives.json` so it
becomes a mechanical check next time (the "ratchet").

## Workflow

### 1. Get a single DDL file

The script wants one PostgreSQL DDL file. Find or produce it:

| Source | How |
|---|---|
| `schema.sql` / `db/schema.sql` | use directly |
| Flyway migrations `V*.sql` | `cat $(ls db/migration/V*.sql \| sort -V) > /tmp/schema.sql` — DROP/ALTER of columns are applied in order |
| Liquibase | `liquibase updateSQL > /tmp/schema.sql` |
| Prisma / Drizzle / Django / SQLAlchemy | generate the SQL with the ORM's own tool (`prisma migrate diff --to-schema-datamodel --script`, `drizzle-kit generate`, `manage.py sqlmigrate`) |
| Live database | `pg_dump --schema-only --no-owner --no-privileges $DB > /tmp/schema.sql` (best: this is the truth) |

Non-PostgreSQL DDL (Oracle, MySQL) will not parse. Say so rather than
guessing; `pg_dump` from a Postgres-compatible replica is the workaround.

### 2. Build or refresh `narratives.json`

This file is where intent lives. Without it the script still documents and
still finds the physical problems, but cardinality, tenant scoping and
natural keys can only be checked against a claim. If the file is missing:

- Draft domains from the codebase: package/module names, table prefixes,
  the section comments in the DDL (`-- PHASE 3 — GitHub integration`).
- Write a one-paragraph blurb per domain that states relationships in
  plain words ("each tenant has exactly one settings row").
- Fill `assertions` from those blurbs and from the code — see
  `examples/narratives.json` for the shape. The important ones:
  `tenant_table`/`tenant_column`/`require_rls`, `global_tables`,
  `singleton_tables`, `cardinality` (parent, child, expect `1:1`|`1:N`),
  `natural_keys`, `exclusive_arcs`.
- **Show the draft to the user and ask them to correct it before running.**
  A wrong assertion produces a confident wrong finding.

### 3. Run the script

```bash
pip install pglast --break-system-packages   # once
python scripts/db_review.py /tmp/schema.sql --narratives narratives.json --out docs/database
```

Read the summary it prints, then `docs/database/FINDINGS.md`. Open
`docs/database/schema.json` for the model (tables → columns, fks with
inferred `cardinality`, `indexed`, `unique`, `nullable`; `referenced_by`;
`rls_enabled`; `findings`). Do not re-parse the SQL yourself.

### 4. The judgment pass

Work through `references/review-checklist.md`. It is organised as questions
the script cannot answer. Anchor every observation to a table or column
name and to the narrative sentence it contradicts. If you can't point at
either, it isn't a finding, it's a preference — leave it out.

Specifically produce:

- **Cardinality claims vs reality.** For each relationship the blurbs
  mention, what does the schema enforce? Use `fks[].cardinality` and
  `fks[].unique`. The script only checks the pairs listed in
  `assertions.cardinality`; you check the rest of the prose.
- **Extension-pain scenarios.** Pick 3–5 plausible next features for this
  product (a second provider, per-environment config, tenant hierarchy
  depth +1, history/audit of a mutable table, deleting a tenant, sharding
  by tenant). For each: what breaks, which findings it activates, and
  whether the fix is cheap now and expensive later. This is the section
  people actually read.
- **Ranked recommendations.** Order by (pain avoided ÷ migration cost).
  Migration cost on a hub table (`blast-radius` finding) is high; adding a
  CHECK to an empty column is near zero.

### 5. Write `docs/database/REVIEW.md`

Use this structure:

```markdown
# Schema review — <database title> — <date>
## Verdict            (3 sentences: is this model sound, what is the one structural risk)
## What this schema is (2 paragraphs, from the narratives + hub tables)
## Mechanical findings (counts by severity, the five that matter most, link to FINDINGS.md)
## Cardinality: claimed vs enforced   (table: relationship · narrative says · schema enforces · gap)
## Where the next change will hurt    (3–5 scenarios as above)
## Recommended changes, ranked        (each: change · why · fix SQL or migration outline · cost)
## Assertions added to narratives.json (the ratchet — list them)
```

### 6. Ratchet

Every judgment finding that can be phrased as data goes into
`narratives.json` under `assertions` (a cardinality pair, a natural key, an
exclusive arc, a singleton). Re-run the script; those findings now appear
in `FINDINGS.md` mechanically and will fail CI if regressed. The review
gets shorter every time; the linter gets stronger.

### 7. Wire it in (offer, don't assume)

- CI: run with `--fail-on error` on any change to the DDL path.
- Claude Code hook: `PostToolUse` on `Write|Edit` matching the schema file
  → run the script, surface new findings in the session.
- Commit `docs/database/` so the docs and the review live next to the code.

## What the script checks (so you don't repeat it)

`domain-coverage`, `primary-key`, `fk-index`, `fk-nullable`, `fk-on-delete`,
`cardinality` (asserted pairs), `natural-key` (asserted), `junction-uniqueness`,
`undocumented-enum`, `soft-delete-unique`, `polymorphic-reference`,
`exclusive-arc`, `timestamp-tz`, `money-float`, `tenant-derivable`,
`tenant-unscoped`, `rls-missing`, `rls-no-policy`, `orphan-table`,
`singleton-table`, `fk-cycle`, `blast-radius`, `wide-table`.

Each finding carries `detail` (what the schema allows and why it hurts),
`suggestion`, and where possible `fix_sql`. Quote them; don't paraphrase
them into something weaker.

## Tone of the review

Write for the engineer who has to defend the change to a reviewer. Every
finding: what is allowed today → the concrete bad thing that follows → the
smallest fix. No "consider", no "best practice says". If something is fine,
say it is fine and why — a review that only lists problems is not trusted.
