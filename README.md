<p align="center">
  <img src="icon.png" alt="Database Architecture Review icon" width="128" height="128">
</p>

# Database Architecture Review for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-purple.svg)](https://claude.ai/code)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Node 24+](https://img.shields.io/badge/Node-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

> **Document your PostgreSQL schema and review its design in one run.** Every finding points at a table you can click through to, and the docs show each flaw next to the table it belongs to.

## Why review a schema?

Application code is reviewed on every pull request. The data model under it is usually reviewed once, on the day it was designed, and then grows by accretion: a `status` column that accepts any string, a settings table meant to hold one row per tenant that quietly holds five, a webhook table that stores the same delivery twice on every retry. Each of those is a one-line fix while the table is empty and a migration project a year later.

## Why this skill?

The review has two halves, kept apart on purpose.

| The script decides | Claude judges |
|---|---|
| Parses your schema with PostgreSQL's own parser, not a regex | Compares what your narrative *claims* with what the schema *enforces* |
| Runs 23 design checks, the same way every run | Writes the "where will the next feature hurt" scenarios |
| Writes browsable docs with the findings inline | Turns each judgment into an assertion the script checks next time |
| Exits non-zero, so it can gate a build | Produces a `REVIEW.md` written for the engineer who has to defend the change |

**Example prompts:**
```
"Review the data model"
"Document our database schema"
"Is tenant isolation enforced everywhere?"
"What breaks if we add a second GitHub App?"
```

> The skill adds to Claude's knowledge; ask naturally. PostgreSQL only: the parser is PostgreSQL's own.

## Prerequisites

- [Node 24](https://nodejs.org/) or newer. The script is TypeScript run directly by Node; there is no build step.
- Your schema as one SQL file: `pg_dump --schema-only` from a dev database, a checked-in `schema.sql`, or concatenated migrations. Claude helps produce it.

## Installation

**1. Register the marketplace:**

```
/plugin marketplace add greenstevester/db-architecture-reviewer
```

**2. Install the skill** (adding the marketplace alone doesn't install anything):

```
/plugin install db-architecture-review@db-architecture-reviewer
```

Or run `/plugin`, open the `db-architecture-reviewer` marketplace, and enable it from the menu. The one dependency, a WebAssembly build of PostgreSQL's parser, installs with the plugin; no compiler needed.

Restart Claude Code.

**Verify:** ask Claude "What database review skills do you have?"

## Usage

Open Claude Code in the repo that owns the schema and ask for a review. Claude walks this path:

```
  ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
  │  SCHEMA  │───▶│ NARRATIVE │───▶│  SCRIPT  │───▶│  REVIEW  │───▶│ RATCHET  │
  └──────────┘    └───────────┘    └──────────┘    └──────────┘    └──────────┘
       │               │                │               │               │
       ▼               ▼                ▼               ▼               ▼
  one DDL file    what each table   23 checks,     claims vs.       judgments
  (pg_dump or     is for, and the   docs, and      enforcement,     become
  migrations)     claims to check   FINDINGS.md    what hurts next  assertions
```

| Step | What Claude does |
|---|---|
| **Schema** | Finds or produces one PostgreSQL DDL file: `pg_dump --schema-only`, Flyway migrations in order, or the ORM's own SQL output |
| **Narrative** | Drafts `narratives.json`: a domain per group of tables, a plain-words blurb, and the claims to check (tenant table, one-to-one pairs, business keys). Shows it to you before running, because a wrong claim produces a confident wrong finding |
| **Script** | Runs the deterministic checks and writes `docs/database/` |
| **Review** | Works through the checklist the script can't answer and writes `docs/database/REVIEW.md` |
| **Ratchet** | Adds each judgment to `narratives.json` as an assertion, so the next run catches it mechanically and the build fails if it regresses |

## What you get

```
docs/database/
├── index.html      self-contained browsable docs, findings inline, filter box, a whole-schema SVG diagram plus an inline SVG diagram and a relationship list per domain
├── schema.json     the model + findings (input for the judgment pass)
├── README.md       markdown index embedding the whole-schema diagram
├── erd.svg         whole-schema entity-relationship diagram (plain SVG, renders anywhere)
├── FINDINGS.md     findings by severity, each with cause, effect and fix SQL
├── REVIEW.md       Claude's judgment pass: verdict, claims vs. enforcement, where the next change hurts
└── domains/        one .md page per domain with its own .svg diagram and a Relationships list (facts + why)
```

## The checks

| id | severity | what it catches |
|---|---|---|
| domain-coverage | error | table in no domain / domain lists a phantom table |
| primary-key | error | table without a primary key |
| cardinality | error/warn | asserted 1:1 modelled as 1:N (no UNIQUE on the foreign key) or vice versa; asserted relationship with no foreign key |
| natural-key | error | asserted business key not UNIQUE |
| junction-uniqueness | error | many-to-many link table that allows duplicate pairs |
| money-float | error | amount/price/… stored as float |
| rls-missing / rls-no-policy | error | tenant table without row-level security, or with it enabled but no policy |
| tenant-unscoped | error | tenant-scoped domain, no path to the tenant at all |
| tenant-derivable | warn (info for junctions) | no `tenant_id`, tenant only reachable via joins |
| fk-index | warn | foreign-key column with no index (PostgreSQL does not add one) |
| undocumented-enum | warn | short `status`/`type`/… string with no CHECK |
| soft-delete-unique | warn | `deleted_at` + non-partial UNIQUE |
| polymorphic-reference | warn | `x_type` + `x_id` pair with no foreign key |
| exclusive-arc | warn/info | several nullable foreign keys, no CHECK that exactly one is set |
| fk-cycle | warn | circular foreign-key dependencies |
| fk-nullable | info | optional relationship: confirm it's intentional |
| fk-on-delete | info | tenant foreign key relying on the default NO ACTION |
| timestamp-tz | info | TIMESTAMP without time zone |
| orphan-table | info | references nothing, referenced by nothing |
| singleton-table | info | documented single-row table with nothing enforcing it |
| undocumented-relationship | info | foreign key with no `why` in narratives.json (only with `require_relationship_notes`) |
| blast-radius | info | hub tables (5 or more dependents) |
| wide-table | info | 30 or more columns |

Every finding carries `detail` (what the schema allows and why it hurts), `suggestion`, and usually `fix_sql`.

## Run it without Claude

The script stands on its own, in a build pipeline or by hand:

```bash
git clone https://github.com/greenstevester/db-architecture-reviewer
cd db-architecture-reviewer/skills/db-architecture-review && npm ci
node scripts/db-review.ts /path/to/schema.sql --narratives /path/to/narratives.json --out docs/database
```

Exit code 1 when an error-severity finding exists (`--fail-on warn|info|never` to tune). The [skill's own README](skills/db-architecture-review/README.md) covers the two input files and a GitHub Actions snippet.

## Update

```
/plugin marketplace update db-architecture-reviewer
```

## Troubleshooting

| Issue | Fix |
|---|---|
| Skill not loading | Restart Claude Code after install |
| `Cannot find module 'libpg-query'` | Run `npm ci` inside the installed plugin folder under `~/.claude/plugins/cache/` |
| `syntax error at or near ...` | The file isn't PostgreSQL DDL. Use `pg_dump --schema-only` from a PostgreSQL database |
| "Table is in no domain" | Add the table to a domain in `narratives.json`. That error is the point: a new table cannot silently fall out of the docs |

## Local development

```bash
claude --plugin-dir /path/to/db-architecture-reviewer/skills/db-architecture-review
cd skills/db-architecture-review && npm test && npm run typecheck
```

The design history — what was tried, what was rejected, and why the tool is two halves with a JSON file in the middle — lives in the repo's git log and in `docs/specs/`. What changed in each release is in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT - [github.com/greenstevester/db-architecture-reviewer](https://github.com/greenstevester/db-architecture-reviewer)
