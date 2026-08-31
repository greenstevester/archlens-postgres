# TypeScript Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `db-architecture-review/scripts/db_review.py` with `scripts/db-review.ts` that produces identical output on the sample schema, then remove the Python and update every reference.

**Architecture:** One TypeScript file with the same four sections as the Python (model, parse, checks, render) plus a command-line entry point. The PostgreSQL parse tree comes from `libpg-query` (WebAssembly build of PostgreSQL's parser). A small hand-written printer turns expression and type nodes back into SQL text. A `node:test` suite compares the tool's output against the committed `examples/out/`.

**Tech Stack:** Node 24 (runs `.ts` directly), `libpg-query` 17.7.4, `typescript` and `@types/node` for `tsc --noEmit` only, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-31-typescript-port-design.md`

**Commit policy:** the repo owner commits. Each task ends with "show the diff, stop"; never run `git commit` or stage files.

All paths below are relative to `db-architecture-review/` unless they start with `/`.

---

### Task 1: Scaffold the Node project

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Generated: `package-lock.json`

- [x] Write `package.json` with `"type": "module"`, `"private": true`, `"engines": {"node": ">=24"}`, `dependencies.libpg-query = "17.7.4"`, dev dependencies `typescript` and `@types/node` pinned to exact versions (latest 5.x of typescript first; move to 7.x only if `tsc --noEmit` passes with it), and scripts: Done: pinned 5.9.3 first; 7.0.2 later checked clean with `tsc --noEmit` and adopted.
  - `review`: `node --disable-warning=ExperimentalWarning scripts/db-review.ts`
  - `test`: `node --disable-warning=ExperimentalWarning --test test/`
  - `typecheck`: `tsc --noEmit`
- [x] Write `tsconfig.json`: `strict`, `module: nodenext`, `target: es2023`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `types: ["node"]`, `include: ["scripts", "test"]`.
- [x] Write `.gitignore` containing `node_modules/`.
- [x] Run `npm install`. Verify: `npm ls --depth=0` lists exactly libpg-query, typescript, @types/node; `package-lock.json` exists.

### Task 2: Write the failing tests

**Files:**
- Create: `test/db-review.test.ts`

- [x] Golden test: spawn `node scripts/db-review.ts examples/sample-schema.sql --narratives examples/narratives.json --out <tmpdir>` with `cwd` = skill folder. Assert exit status 1 and that stdout contains `findings: 8 error, 18 warn, 12 info`. For each of `schema.json`, `README.md`, `FINDINGS.md`, `index.html`, `domains/{tenant,auth,permission,github,approvals,billing}.md`, read generated and committed text, drop lines matching `/"generated_at":/` and `/Generated from .* on \d{4}-\d{2}-\d{2}/`, assert equal.
- [x] Parse test: `import { parseSchema } from '../scripts/db-review.ts'`; parse the sample; deep-equal the `tables` object (with `domain: null`, `findings: []` on every table) against `examples/out/schema.json` `.tables` after the same normalisation.
- [x] Checks test: `parseSchema` then `new Reviewer(tables, narratives).run()`; deep-equal to `examples/out/schema.json` `.findings`.
- [x] Printer tests for `renderExpr`: string constant → `'x'`, integer → `42`, boolean → `TRUE`/`FALSE`, null → `NULL`, function call with args, cast → `expr::type`, column reference (multi-part), binary operator, AND/OR/NOT, IS NULL / IS NOT NULL, unknown node kind → `…` plus embedded column names.
- [x] `escapeHtml` test: `&<>"'` → `&amp;&lt;&gt;&quot;&#x27;`.
- [x] Run `npm test`. Verify: every test fails with "Cannot find module" for `scripts/db-review.ts`.

### Task 3: Port the model, parser and printer

**Files:**
- Create: `scripts/db-review.ts` (sections 1 and 2)
- Source: `scripts/db_review.py:44-352`

- [x] Model: plain TypeScript interfaces `Column`, `ForeignKey`, `Index`, `Table`, `Finding` with fields in the exact Python dataclass order (JSON key order depends on it). `Table.col(name)` becomes a helper function `col(t, name)`.
- [x] Printer `renderExpr(node)` and `renderType(typeName)`. Type names: strip `pg_catalog.`, map `int4→integer`, `int8→bigint`, `int2→smallint`, `float8→double precision`, `float4→real`, `bpchar→char`, `bool→boolean`, `serial8→bigserial`, `serial4→serial`, `serial2→smallserial`; append `(typmods)` when present; append `[]` per array bound. Length is taken only for `varchar`/`char`, as in `_type_info`.
- [x] `parseSchema(sql, path)`: `loadModule()` once, `parseSync(sql)`, then the same statement switch as the Python (`stmt_location ?? 0`), `applyTableConstraint`, deferred ALTER TABLE, `harvestTrailingComments`, `derive`. Foreign-key delete actions map `a/r/c/n/d` exactly as `DEL_ACTIONS`. Use a `Map<string, Table>` for tables; iteration order is insertion order.
- [x] Run `npm test -- --test-name-pattern parse`. Verify: parse test passes. Done after the fact; the whole file was ported in one pass and the parse, checks and golden tests were run together. The name filter did not narrow the run when passed through `npm test --`.

### Task 4: Port the checks

**Files:**
- Modify: `scripts/db-review.ts` (section 3)
- Source: `scripts/db_review.py:353-765`

- [x] `Reviewer` class: constructor sets `domain_of` and `table.domain`; `add()` numbers findings `F${seq.padStart(3,'0')}`; `run()` calls the 21 `chk*` methods in the Python's order then sorts by (severity rank, table, id). Set helpers `sameSet`, `isSuperset`, `prefixSet` replace Python set comparisons. `shortestPath` is breadth-first with a queue. `chkFkCycles` uses insertion-ordered `Set` (the Python iterated a hash-randomised set; the sample has no cycles).
- [x] Every `detail`, `suggestion`, `fix_sql` string copied verbatim, including `→`, `≠`, `⚠` and line breaks.
- [x] Run `npm test -- --test-name-pattern checks`. Verify: findings deep-equal the committed 38. Done after the fact, see the note on the parse step.

### Task 5: Port rendering and the command line

**Files:**
- Modify: `scripts/db-review.ts` (section 4 and `main`)
- Source: `scripts/db_review.py:766-1070`

- [x] `modelToJson`: `generated_at` as `YYYY-MM-DDTHH:MM:SS+00:00` (Python `isoformat(timespec="seconds")` in UTC). Write with `JSON.stringify(doc, null, 2)` and no trailing newline.
- [x] `mermaidErd`, `writeMarkdown`, `writeHtml` line for line; `escapeHtml` matches Python `html.escape` (five characters). Markdown files end with one `\n`; HTML has none. The HTML "Generated ... on" date is the local date. FINDINGS.md header says `db-review.ts`.
- [x] `main(argv)`: same flags and defaults; `--fail-on` choices `error|warn|info|never`; missing `libpg-query` prints `libpg-query is required:  npm install` to stderr and exits 2; summary printed unless `--quiet`, severity padded to 5 characters. Guard: run `main` only when the file is the entry point (compare `process.argv[1]` to `fileURLToPath(import.meta.url)`).
- [x] Run `npm test`. Verify: all tests pass except the FINDINGS.md golden line naming the script (expected; fixed in Task 6).
- [x] Run `npm run typecheck`. Verify: no errors.

### Task 6: Regenerate the example output

- [x] Run `npm run review -- examples/sample-schema.sql --narratives examples/narratives.json --out examples/out`. Verify exit 1.
- [x] `git diff --stat examples/out/` and read the diff. Allowed changes only: `generated_at`, the HTML "Generated ... on" date, `db_review.py` → `db-review.ts` in FINDINGS.md. Anything else is a port bug: fix the script, not the golden file.
- [x] Run `npm test`. Verify: everything passes.

### Task 7: Update the documents

**Files:**
- Modify: `README.md`, `SKILL.md`, `FORCLAUDE.md`, `/CLAUDE.md`

- [x] `README.md`: run command, Install section (`npm install` inside the skill folder, Node 24+), CI snippet (`actions/setup-node@v4` with `node-version: 24`, `npm ci`, `node scripts/db-review.ts ...`), Try-it command, and the "python" mention in Limits if any.
- [x] `SKILL.md`: `compatibility:` line, step 3 install and run commands. Everything else unchanged.
- [x] `FORCLAUDE.md`: append `## Postscript — 2026-08-31: ported to TypeScript`, five to eight sentences: why (no Python on the target machines), what stayed (real parser, four sections, checks verbatim), what changed (hand-written printer replaces pglast's RawStream; cycle iteration is now deterministic), and how it was verified (golden comparison).
- [x] `/CLAUDE.md`: Commands, Testing, "How the script is put together" (file name, function names, `Map` instead of dict), the interpreter paragraph replaced with the Node requirement.
- [x] Verify: `grep -rniE 'python|pglast|db_review\.py|pip install' README.md SKILL.md /CLAUDE.md` returns nothing except deliberate historical mentions in FORCLAUDE.md.

### Task 8: Remove the Python, sync mirrors, rebuild the skill archive

- [x] `rm scripts/db_review.py` and `rm /db_review.py` (working tree only; do not touch the index).
- [x] Copy the nested `README.md`, `SKILL.md`, `FORCLAUDE.md`, `scripts/db-review.ts` (as `/db-review.ts`), `examples/out/FINDINGS.md` → `/example-FINDINGS.md`, `examples/out/REVIEW.md` → `/example-REVIEW.md`, `examples/out/index.html` → `/example-index.html`. Verify with `diff` that each pair is identical.
- [x] Rebuild `/db-architecture-review.skill`: from `/`, `rm db-architecture-review.skill && zip -r db-architecture-review.skill db-architecture-review -x 'db-architecture-review/node_modules/*' -x '*/.DS_Store'`. Verify: `unzip -l` lists no `.py`, includes `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/db-review.ts`, `test/db-review.test.ts`, and no `node_modules`.
- [x] Final: `npm test` and `npm run typecheck` pass; `git status` shows the expected adds, modifications and deletions. Show the owner the summary and stop.

### Task 9 (added after review): coverage, typing, honesty

- [x] Write `test/fixtures/edge-cases.sql` and `edge-cases.narratives.json` covering every construct and finding branch the sample lacks.
- [x] Run the Python original (from the git index, via `uv run --with pglast`) and the port on it; diff. Fix the printer until only the script name and the deliberate fallback differ. Commit the port's output as `test/fixtures/edge-cases.out/`.
- [x] Write `test/fixtures/expressions.sql`; assert each rendering against pglast's output for the same file.
- [x] Type the parse section with `@pgsql/types`.
- [x] Try TypeScript 7.0.2; adopt it if `tsc --noEmit` passes.
- [x] Verify pglast's statement positions by running pglast.
- [x] Screenshot `examples/out/index.html` with headless Chrome and look at it.
- [x] Re-sync mirrors, rebuild the skill archive, run `npm test` and `npm run typecheck`, then commit and push on the owner's instruction.
