# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin marketplace with one skill, `skills/db-architecture-review/`, that documents a PostgreSQL schema and reviews its design in one run. It has two halves on purpose. `scripts/db-review.ts` runs deterministic checks and writes the docs. `SKILL.md` tells a Claude session how to do the judgment pass the script cannot (compare the narrative to the schema relationship by relationship, write the extension-pain scenarios) and how to feed each judgment back into `narratives.json` so it becomes a mechanical check on the next run. `FORCLAUDE.md` in the skill folder is the design history and explains why each tradeoff was made; read it before changing a heuristic.

The repo root is the public marketplace, laid out like `greenstevester/fastlane-skill`: `.claude-plugin/marketplace.json` lists the plugin with `source: ./skills/db-architecture-review`, `.claude-plugin/plugin.json` describes the marketplace, `README.md` is the front page with the `/plugin marketplace add` install steps, plus `LICENSE` (MIT) and `icon.png`. Users install with `/plugin marketplace add greenstevester/db-architecture-reviewer` then `/plugin install db-architecture-review@db-architecture-reviewer`; for local testing, `claude --plugin-dir skills/db-architecture-review` (the plugin root is the folder holding `SKILL.md`, not the marketplace root). The skill's own `README.md` inside `skills/db-architecture-review/` documents the script for people running it without Claude. Releases are tags `vX.Y.Z` with GitHub release notes. A version lives in four places and they move together: `.claude-plugin/marketplace.json` (the marketplace `version` and the plugin entry's `version`), `.claude-plugin/plugin.json`, `skills/db-architecture-review/.claude-plugin/plugin.json`, and `skills/db-architecture-review/package.json`. Users only receive an update when the plugin entry's version changes. `claude plugin validate .` and `claude plugin validate skills/db-architecture-review` must both pass before tagging.

## Commands

Node 24 or newer runs the `.ts` file directly; there is no build step. Install once inside the skill folder, then run:

```bash
cd skills/db-architecture-review
npm install
node scripts/db-review.ts examples/sample-schema.sql --narratives examples/narratives.json --out examples/out
```

`npm run typecheck` runs `tsc --noEmit` (TypeScript is a dev dependency used only for checking). `npm test` runs the suite described below. The one runtime dependency is `libpg-query`, a WebAssembly build of PostgreSQL's parser; every version in `package.json` is pinned exactly.

Flags: `--narratives` (optional; without it only the physical checks run), `--out` (default `docs/database`), `--fail-on error|warn|info|never` (default `error`; exit 1 when any finding at that severity or worse exists), `--quiet`.

### Testing

`npm test` (`node --test`, no framework) runs `test/db-review.test.ts`, 99 tests in four groups.

1. Golden runs. The tool is executed on `examples/sample-schema.sql` (19 tables, every flaw marked `⚠ FLAW`, expected `findings: 8 error, 18 warn, 12 info`, exit 1) and on `test/fixtures/edge-cases.sql` (every construct the sample lacks: schema-qualified table, ALTER ADD/DROP COLUMN, CHECKs of every shape, partial and expression indexes, composite keys, a foreign-key cycle, a wide table, block comments, unparsed statements, table-level CHECKs as pg_dump writes them, a one-row table guarded by CHECK (id = 1), and the `\restrict` lines pg_dump emits; expected `9 error, 8 warn, 11 info`). Every output file is compared with the committed golden directory, ignoring only the `generated_at` line and the HTML "Generated ... on" date. The sample's FINDINGS.md and findings came from the Python original; its README.md, domains/*.md and index.html now carry sections the Python never wrote (whole-schema diagram, Relationships, SVG diagrams). The edge-case golden came from this tool after a diff against the Python on the same input showed only the script name and the row-value fallback differing.
2. Model and findings. The parsed table model and the findings list are compared with `examples/out/schema.json` on their own, so a parse bug and a check bug fail different tests.
3. The printer. `test/fixtures/expressions.sql` holds 54 CHECK/DEFAULT expressions; each rendering is asserted against what pglast printed for the same file. 52 match; row values and `COLLATE` hit the `…` fallback by design.
4. Unit tests on single checks and renderers. Table-level CHECK attribution in both spellings, the singleton guard, the `\restrict` preamble with `source_line` intact, `svgErd()` (boxes, stubs, edge ends, self-reference, well-formedness, determinism), cross-domain Mermaid, `relationships()` and `describeRelationship()`, the `undocumented-relationship` finding, and the three writers.

After touching a check or the printer, run `npm test`. If a golden test fails and the new output is what you intended, regenerate with `npm run review -- <schema> --narratives <narratives> --out <golden dir>` and read `git diff` on the golden directory before accepting it. A new finding on either fixture is a flaw you deliberately added to the schema or a false positive to fix.

The script does not write `examples/out/REVIEW.md`. That file is the hand-written judgment pass and the reference for what one should look like.

## How the script is put together

One file, `scripts/db-review.ts`, in four sections that run in order, with the command-line entry point at the bottom. It was ported line for line from a Python original on 2026-08-31; the postscript in `FORCLAUDE.md` records what changed.

**Model.** Interfaces `Column`, `ForeignKey`, `Index`, `Table`, `Finding`, built by small `newColumn()`-style factories that assign fields in declaration order. `schema.json` is `JSON.stringify` of these objects, so field order in the interface is key order in the file. Add a field to the interface and its factory and it appears in the JSON. Tables live in a `Map` so iteration order is creation order.

**Parsing.** `parseSchema()` walks the parse tree from `libpg-query` (a WebAssembly build of PostgreSQL's own parser, loaded once through `loadModule()`, which is why `parseSchema` is async). It handles CREATE TABLE, ALTER TABLE ADD CONSTRAINT and ENABLE ROW LEVEL SECURITY, CREATE INDEX including partial, CREATE POLICY, CREATE TYPE AS ENUM, COMMENT ON, CREATE EXTENSION. A table-level CHECK that mentions exactly one column (the only way `pg_dump` writes a CHECK) is attributed to that column's `check` as well as the table's `checks`. Lines starting with `\` (psql's `\restrict` / `\unrestrict`, emitted by `pg_dump` 16.10+ and 17.6+) are blanked to the same length before parsing, so byte offsets and line numbers still hold. Everything else (triggers, views, functions) is recorded by statement kind in `extras.unparsed`. `-- comments` directly above a table and at the end of a column line become descriptions. The walk is typed against `@pgsql/types` (re-exported by `libpg-query`): every node is `{ <Kind>: {...} }`, narrowed with `'CreateStmt' in stmt`, and enum fields are string unions, so a misspelt `case 'CONSTR_...'` is a compile error. Two things to know about the tree: the parser omits zero, false and empty values (so `{ ival: {} }` means 0), and it reports each statement's location as the byte after the previous semicolon, so `firstToken()` skips whitespace and comments forward before line numbers and descriptions are read (pglast did the same; verified by running it). `renderExpr()` and `renderType()` turn expression and type nodes back into SQL text in pglast's format: `CAST(x AS type)`, nested operator expressions in parentheses, `NOT(...)` around boolean groups, `ANY(`, plus `CASE`, `COALESCE`, `GREATEST`/`LEAST` and subscripts. Unknown node kinds render as `…` plus the column names inside them, which keeps the either/or check working; row values and `COLLATE` are the known cases (marked `ponytail:`; swap in `pgsql-deparser` if CHECK bodies get exotic). Then `derive()` runs once over the finished model and computes `fk.nullable`, `fk.unique`, `fk.indexed`, `fk.cardinality` (`1:1` only when a non-partial unique index covers exactly the foreign-key columns, otherwise `1:N`) and `parent.referenced_by`. Because it runs after every statement has been read, a foreign key added by ALTER TABLE at the bottom of a file is treated the same as an inline one.

**Checks.** The `Reviewer` class. `run()` calls the `chk*` methods in a fixed list, then sorts findings by severity, table, id. Checks only read what `derive()` computed; none of them derive anything, which is why each is about ten lines. `Reviewer.add(checkId, severity, table, columns, title, detail, suggestion, fixSql)` is the single place a severity is assigned, so a severity change is a one-line edit at the call site. Finding ids (`F001`, `F002`, ...) are numbered in execution order before the sort, so reordering checks renumbers every finding. The full list of check ids and severities is the table in `README.md`.

**Rendering.** `modelToJson`, `writeMarkdown` (README.md with a whole-schema Mermaid diagram, plus `domains/*.md` with a Mermaid diagram and a Relationships list each — `relationships()` and `describeRelationship()` turn every foreign key into words) and `writeHtml` (one self-contained `index.html`, with an inline SVG entity-relationship diagram per domain from `svgErd()` — parents above children, stub boxes for parents outside the domain, crow's-foot ends from the schema, no Mermaid and nothing loaded). All three read the same `findings` list, which is how a finding in the HTML links to its table and the table links back. `escapeHtml` escapes the same five characters as Python's `html.escape`. The HTML loads nothing from the web, uses no framework, and uses flexbox rather than grid; "a file you can email that also survives a PDF exporter" is a hard requirement inherited from the tool this was modelled on.

## narratives.json

The file where human intent lives, and what the interesting checks compare against. Three parts: `domains[]` (key, title, blurb, `tenant_scoped`, `tables[]`), `conventions[]` (printed in the docs, not checked), and `assertions` (`tenant_table`, `tenant_column`, `require_rls`, `global_tables`, `singleton_tables`, `cardinality[]`, `natural_keys[]`, `exclusive_arcs[]`, `require_relationship_notes`). A `cardinality[]` entry may carry a `why` (and `columns`, required when a table has two foreign keys to the same parent); the docs print it beside the relationship, and with `require_relationship_notes` every foreign key without one becomes an `undocumented-relationship` note. Every table must be claimed by exactly one domain; otherwise `domain-coverage` raises an error and the run exits 1. That gate is what keeps the docs accurate as the schema grows. See `examples/narratives.json` for the shape.

## Decisions to keep

- Precision over recall. `isJunction()` requires exactly two non-tenant, NOT NULL foreign keys and at most one payload column. It was tightened after firing on `approval_request`. Don't loosen a heuristic to catch one more real case if it adds a false positive on the sample.
- When domains exist, unclaimed tables are skipped by the tenant checks, so one root cause does not produce two errors.
- Tenant-derivability on a table that looks like a junction is `info`, not `warn`.
- Fix SQL is a template on purpose (literal dots in `ADD PRIMARY KEY (...)`, `CHECK (status IN (...))`). Copy-pasting an incomplete constraint is safer than copy-pasting a subtly wrong one.
- PostgreSQL only. A multi-dialect parser would weaken every check. If Oracle or MySQL support is ever needed, `FORCLAUDE.md` names `sqlglot` as the pivot and lists what you would lose.

## The skill workflow

Script first, judgment second, then ratchet. A session using the skill gets one schema SQL file (concatenate Flyway migrations with `sort -V`, not plain `sort`, or `V10` runs before `V2`), drafts or refreshes `narratives.json` and shows it to the user before running (a wrong assertion yields a confident wrong error), runs the script, works through `references/review-checklist.md` against `schema.json`, and writes `REVIEW.md` in the fixed section order given in `SKILL.md` step 5. Every judgment that can be phrased as data goes back into `assertions` so the next run catches it mechanically.
