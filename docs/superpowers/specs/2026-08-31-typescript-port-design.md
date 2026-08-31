# TypeScript port of db_review.py

Date: 2026-08-31. Approved in chat by the repo owner.

## Goal

Replace `db-architecture-review/scripts/db_review.py` (Python, pglast) with a TypeScript script that produces the same five output files, the same findings, the same exit codes and the same flags, then remove the Python.

## Decision: TypeScript on Node 24

The Go binding to PostgreSQL's parser (`pg_query_go`) compiles the C parser at build time, so a skill folder copied into `.claude/skills/` would need a C compiler or a pre-built binary per platform. `libpg-query` 17.7.4 on npm is a WebAssembly build of the same parser; `npm install` is the whole install. Node 24 runs `.ts` files directly, so there is no build step. FORCLAUDE.md records that the target team is Java + Node and that the tool this was modelled on was TypeScript.

## Decision: hand-written expression printer

pglast rendered parsed expressions back to SQL text (`now()`, `'UTC'`, `FALSE`, `varchar(255)`). The Node parser package has no printer. A hand-written printer of about 70 lines covers the node kinds that occur in table definitions: constants, function calls, casts, column references, operators, AND/OR/NOT, IS NULL, arrays and type names. Unknown nodes render as `…` followed by every column name found inside them, so the either/or foreign-key check, which looks for column names in CHECK text, still works.

Rejected: `pgsql-deparser` from npm. It matched pglast on the sample apart from `false` vs `FALSE`, but it adds 1.1 MB and its current line targets the PostgreSQL 18 tree while the parser emits 17.

## Layout, inside `db-architecture-review/`

| File | Purpose |
|---|---|
| `package.json` | `type: module`, `engines.node >= 24`, `libpg-query` pinned 17.7.4, `typescript` and `@types/node` pinned as dev dependencies; scripts `review`, `test`, `typecheck` |
| `package-lock.json` | committed |
| `tsconfig.json` | strict, `erasableSyntaxOnly` so Node can strip types, `noEmit` |
| `.gitignore` | `node_modules/` |
| `scripts/db-review.ts` | the port, same four sections as the Python: model, parse, checks, render |
| `test/db-review.test.ts` | `node:test`, no framework |

Same flags (`--narratives`, `--out`, `--fail-on`, `--quiet`), same exit codes (1 on findings at or above `--fail-on`, 2 if the parser package is missing), same output files with the same JSON key order.

## Testing

Test first, then port until it passes.

1. Run the tool on `examples/sample-schema.sql` with `examples/narratives.json` into a temporary directory. Assert exit code 1 and the summary line `findings: 8 error, 18 warn, 12 info`.
2. Compare every output file to `examples/out/`, ignoring only the `generated_at` line in `schema.json` and the "Generated from ... on <date>" line in `index.html`.
3. Unit tests for the expression printer (each node kind and the fallback) and the HTML escaper.

Expected text differences that the comparison will show and the golden files will absorb: the FINDINGS.md header names the script (`db_review.py` becomes `db-review.ts`). The Python's foreign-key-cycle check iterated a hash-randomised set, so its cycle order varied between runs; the port iterates in insertion order. The sample has no cycles, so no output changes.

## Cleanup once the test passes

- Delete both `db_review.py` copies from the working tree. The git index is left alone.
- Update `README.md`, `SKILL.md` (compatibility line, step 3 command, install) and `CLAUDE.md`. Add a dated postscript to `FORCLAUDE.md` rather than rewriting its history.
- Regenerate `examples/out/` with the new tool, re-sync the root-level mirror copies, rebuild `db-architecture-review.skill` (zip of the skill folder without `node_modules`).
- No commit without the owner's approval.

## Amendments, same day, after review

Asked what had been skipped, the honest list was: test coverage only for what the sample schema contained, plan checkboxes ticked wholesale, "identical output" claimed beyond what was proven, an untyped parse walk, and an inference about pglast stated as fact. Resolutions:

- `test/fixtures/edge-cases.sql` (plus narratives and golden output) exercises every construct the sample lacks. Its golden output was diffed against the Python original run on the same input via `uv run --with pglast`; the only differences are the script's name in the FINDINGS.md header and the row-value CHECK that hits the printer's fallback.
- `test/fixtures/expressions.sql` holds 54 expressions; the test asserts each rendering against what pglast printed for the same file. The printer was changed to match pglast's formatting (casts as `CAST(x AS type)`, parentheses around nested operators, `NOT(...)`, `ANY(`, and support for `CASE`, `COALESCE`, `GREATEST`/`LEAST`, subscripts). 52 match; row values and `COLLATE` fall back to `…` by design.
- The parse section is typed against `@pgsql/types` (re-exported by `libpg-query`) instead of `Record<string, any>`.
- TypeScript 7.0.2 was tried as the plan said and adopted, since `tsc --noEmit` passes.
- The pglast statement-position behaviour was verified by running pglast, not inferred.
- The rendered HTML was screenshotted with headless Chrome and inspected.
