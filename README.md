<p align="center">
  <a href="https://github.com/greenstevester/postgres-schema-gallery"><img src="https://greenstevester.github.io/postgres-schema-gallery/banner.gif" alt="A real PostgreSQL schema turning in the 3D explorer: islands per domain, every foreign key as an arc" width="800"></a>
</p>
<p align="center">
  <a href="https://github.com/greenstevester/postgres-schema-gallery"><b>See it on real schemas: the postgres-schema-gallery</b></a><br>
  <sub>Temporal, Miniflux, Listmonk, Matrix Synapse, Sourcegraph, Cal.com and GitLab (1,429 tables), each reviewed, each with a 3D explorer you can rotate.</sub>
</p>

# ArchLens Postgres for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-purple.svg)](https://claude.ai/code)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Node 24+](https://img.shields.io/badge/Node-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

## What is this?

It's a Claude Code skill that reads one PostgreSQL DDL file, writes browsable documentation for it, and reviews the design while it is there.

- Is your database schema structurally sound?
- Has anyone reviewed it lately after all those PRs?
- Missing any essential indexes or FK constraints?
- Is it still performant where it needs to be?

I asked those same questions recently on a few of my projects and now we have models that are capable enough to both visualise the overall database schema whilst providing indicators/pointers where things might have gone stale or need attention - so let's leverage that workhorse!

*NOTE #1: This is not meant to be a fire-and-forget skill, but one where the model prompts you, the human in the loop, to check your own stuff (an ironic inversion of control). Enjoy and let me know if it helps.*

*NOTE #2: PostgreSQL only. The parser is PostgreSQL's own, compiled to WebAssembly, so Oracle and MySQL DDL will not parse.*

---

### INSTALL AND RUN:

You need [Node 24](https://nodejs.org/) or newer. The script is TypeScript run directly by Node, with no build step.

**1. Register the marketplace:**

```
/plugin marketplace add greenstevester/archlens-postgres
```

**2. Install the skill** (adding the marketplace alone doesn't install anything):

```
/plugin install archlens-postgres@archlens-postgres
```

Or run `/plugin`, open the `archlens-postgres` marketplace, and enable it from the menu. The one dependency, a WebAssembly build of PostgreSQL's parser, installs with the plugin; no compiler needed.

Restart Claude Code, then ask "What database review skills do you have?" to check it loaded. Later, update with `/plugin marketplace update archlens-postgres`.

**3. Run the skill:**

```
/archlens-postgres
```

### What it writes

```
docs/database/
├── index.html      browsable docs, findings inline, filter box, an SVG diagram per domain
├── schema-3d.html  the whole schema in 3D: one island per domain, every foreign key an arc,
│                   click a table or a line for its detail. Self-contained, about 0.8 MB
├── schema.json     the model and the findings, which is what the judgment pass reads
├── README.md       markdown index, leading with the schema map
├── schema-map.svg  the 3D layout seen from above: islands, tables, one curve per foreign key
├── erd.svg         whole-schema entity-relationship diagram, plain SVG
├── FINDINGS.md     findings by severity, each with cause, effect and fix SQL
├── REVIEW.md       Claude's judgment pass: verdict, claims vs enforcement, what hurts next
└── domains/        one .md page per domain, its own .svg, and a Relationships list
```

### What it checks

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
| fk-index | warn | foreign-key column with no index (PostgreSQL does not add one); suggests a partial index for a nullable key and prices the write cost |
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

## Why?

### Why review a schema?

Application code is reviewed on every pull request. The data model under it is usually reviewed once, on the day it was designed, and then grows by accretion: a `status` column that accepts any string, a settings table meant to hold one row per tenant that quietly holds five, a webhook table that stores the same delivery twice on every retry. Each of those is a one-line fix while the table is empty and a migration project a year later.

### Why two halves?

The review has two halves, kept apart on purpose.

| The script decides | Claude judges |
|---|---|
| Parses your schema with PostgreSQL's own parser, not a regex | Compares what your narrative *claims* with what the schema *enforces* |
| Runs 24 design checks, the same way every run | Writes the "where will the next feature hurt" scenarios |
| Writes browsable docs with the findings inline | Turns each judgment into an assertion the script checks next time |
| Exits non-zero, so it can gate a build | Produces a `REVIEW.md` written for the engineer who has to defend the change |

Anything the script can decide, it decides on every run, for free, and fails your build. Claude's time goes only on what needs the product story, like whether "each tenant has exactly one settings row" is enforced, or what breaks when you add a second payment provider. Then you turn that judgment into data, so it never needs a human again.

## How

### The whole run


```
 USER: "review our schema"  /  "document our tables"  /  PR touches migrations
    │
    │  Claude matches the skill's description and loads SKILL.md
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1   Get ONE PostgreSQL DDL file                                │
│          schema.sql · pg_dump --schema-only · Liquibase updateSQL   │
│          Flyway:  cat $(ls V*.sql | sort -V)   <- sort -V, or       │
│                                                   V10 lands before  │
│                                                   V2 and DROPs      │
│                                                   replay wrong      │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 2   Draft narratives.json  — where human intent lives          │
│          domains[] · conventions[] · assertions{}                   │
│                                                                     │
│          ►► SHOWN TO YOU FOR CORRECTION BEFORE ANYTHING RUNS ◄◄     │
│          A wrong assertion doesn't fail quietly. It produces a      │
│          confident, wrong error.                                    │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 3   node scripts/archlens.ts schema.sql \                      │
│                 --narratives narratives.json --out docs/database    │
│                                                                     │
│          THE MACHINE HALF. Deterministic. Same input, same bytes.   │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 4/5 Claude reads schema.json + FINDINGS.md, works through      │
│          references/review-checklist.md, writes REVIEW.md           │
│                                                                     │
│          THE JUDGMENT HALF. The script never writes REVIEW.md.      │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 6   RATCHET — every judgment that can be phrased as data goes  │
│          back into assertions{}, and is mechanical from now on      │
└─────────────────────────────────────────────────────────────────────┘
```

### Inside the script (step 3)

```
  schema.sql
      │
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │ parseSchema()   libpg-query — PostgreSQL's OWN parser,   │
  │                 compiled to WebAssembly. Not a regex,    │
  │                 not a second dialect's guess.            │
  │                 psql's \restrict lines are blanked to    │
  │                 the same length so line numbers hold.    │
  └──────────────────────────────────────────────────────────┘
      │  tables · columns · foreign keys · indexes · policies
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │ derive()        ONE pass after every statement is read,  │
  │                 so a foreign key added by ALTER TABLE at │
  │                 the bottom counts the same as an inline  │
  │                 one. Computes nullable · unique ·        │
  │                 indexed · cardinality · referenced_by.   │
  └──────────────────────────────────────────────────────────┘
      │
      ▼                          narratives.json ──┐
  ┌──────────────────────────────────────────────────────────┐
  │ Reviewer.run()  ~24 checks in a FIXED order. Each only   │
  │                 READS what derive() computed, which is   │
  │                 why each is about ten lines.             │
  │                 domain-coverage · primary-key · fk-index │
  │                 · tenant-unscoped · rls-missing · …      │
  └──────────────────────────────────────────────────────────┘
      │
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │ applyAccepted() Runs AFTER the checks, never as one of   │
  │                 them — it can only judge an entry once   │
  │                 every finding exists. Findings you       │
  │                 already reviewed and rejected move to    │
  │                 "dismissed" instead of being re-argued.  │
  │                 An entry matching nothing warns, so a    │
  │                 renamed column gives you noise, not      │
  │                 silence.                                 │
  └──────────────────────────────────────────────────────────┘
      │
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │ writers   schema.json      the model, for Claude to read │
  │           FINDINGS.md      every finding, with fix SQL   │
  │           README.md        + schema-map.svg, erd.svg     │
  │           domains/*.md     + one .svg each               │
  │           index.html       self-contained, printable     │
  │           schema-3d.html   Three.js inlined, ~0.8 MB     │
  │                                                          │
  │           NOTHING loads from the web. A ratchet test     │
  │           fails the build if any output gains an http    │
  │           src/href or an import map.                     │
  └──────────────────────────────────────────────────────────┘
      │
      ▼
   exit 0  clean            exit 1  a finding at or above --fail-on
   exit 2  bad arguments, unreadable file, libpg-query missing
```

### The ratchet

```
   run 1 ──► script finds 8 errors ──► Claude judges, finds 5 more
                                            │
                          those 5 become assertions{} in narratives.json
                                            │
   run 2 ──► script finds 13 ◄──────────────┘   Claude judges, finds 2 more
                                            │
   run 3 ──► script finds 15 ◄──────────────┘   Claude finds 0 new

        The review gets shorter every time. The linter gets stronger.
        Work moves one way: judgment → machine. Never back.
```

### Without Claude

The script stands on its own, in a build pipeline or by hand:

```bash
git clone https://github.com/greenstevester/archlens-postgres
cd archlens-postgres/skills/archlens-postgres && npm ci
node scripts/archlens.ts /path/to/schema.sql --narratives /path/to/narratives.json --out docs/database
```

It exits 1 when an error-severity finding exists; `--fail-on warn|info|never` tunes that. The [skill's own README](skills/archlens-postgres/README.md) covers the two input files and a GitHub Actions snippet.

### When it goes wrong

| Issue | Fix |
|---|---|
| Skill not loading | Restart Claude Code after install |
| `Cannot find module 'libpg-query'` | Run `npm ci` inside the installed plugin folder under `~/.claude/plugins/cache/` |
| `syntax error at or near ...` | The file isn't PostgreSQL DDL. Use `pg_dump --schema-only` from a PostgreSQL database |
| "Table is in no domain" | Add the table to a domain in `narratives.json`. That error is the point: a new table cannot silently fall out of the docs |

### Working on the tool itself

```bash
claude --plugin-dir /path/to/archlens-postgres/skills/archlens-postgres
cd skills/archlens-postgres && npm test && npm run typecheck
```

What was tried, what was rejected, and why the tool is two halves with a JSON file in the middle lives in the git log and in `docs/specs/`. What changed in each release is in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT - [github.com/greenstevester/archlens-postgres](https://github.com/greenstevester/archlens-postgres)
