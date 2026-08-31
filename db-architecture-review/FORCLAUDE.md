# FORCLAUDE.md — how the database review tool came together

*Over-coffee version. What I built, what I threw away, and what to steal.*

---

## 1. The approach, and why I started where I did

You showed me four photos of a colleague's script. I couldn't copy it — I
could barely read half of it — but the photos told me something more useful
than the code would have: **the shape of a solution that already worked for
a 162-table schema.** Parse DDL → typed model → hand-curated domains with
prose → render docs → fail the build if a table isn't claimed.

So my starting point wasn't "how do I detect wrong cardinality." It was:
"that pipeline stops one step too early." Everything a review needs was
already sitting in that script's `Table` interface — it just got rendered
to HTML and thrown away. My whole plan was to keep that pipeline and add a
step between *model* and *render* called *judge*.

Think of it like a building inspector. Your colleague's script was a
surveyor: it measured every wall and produced beautiful floor plans. Nobody
had walked the plans with a code book yet. Same measurements, one extra
person.

The second thing that shaped the approach: the words you used. "Rigorous
review," "wrong cardinality," "extension might mean pain." Those are three
different kinds of question:

- *Rigorous* → deterministic, repeatable, runs in CI without a model.
- *Wrong cardinality* → requires knowing what was *intended*. A parser
  can't know that `tenant_settings` was meant to be 1:1.
- *Extension pain* → requires imagining the future. No parser will ever
  do that.

That's why the tool is two halves with a JSON file in the middle. The
script handles what is decidable. The skill handles what needs a story. And
`narratives.json` is where the story gets written down so that, over time,
more of it becomes decidable.

## 2. Roads not taken

**Write it in TypeScript like the original.** Tempting for adoption —
their repo is Java + Node, and `node --experimental-strip-types` was the
original's whole install story. I rejected it because of the parser. The
original hand-rolled a regex parser (`/^CREATE TABLE …/`, count the
parentheses). That works for the DDL *you* write. It falls over on
`ALTER TABLE … ADD CONSTRAINT`, which is where Flyway migrations put most
foreign keys, and on partial indexes, and on `COMMENT ON`. A review tool
that silently drops half the foreign keys is worse than no tool, because it
looks authoritative. `pglast` wraps PostgreSQL's *own* parser. The Node
equivalent (`libpg-query`) exists and would have been fine too; I picked
Python because the sandbox had it and because Claude Code skills routinely
bundle Python scripts. Not a deep choice — the deep choice was "real
parser, not regex."

**One big LLM prompt: "here's the schema, review it."** This is what most
of the skills I found do. I rejected it because it fails the "rigorous"
test three ways: it's non-deterministic, it costs money every run, and it
can't be a CI gate. Worse, a model reading 162 tables will find *different*
things each time, and the team stops trusting it. The deterministic checks
are boring and that is their virtue.

**A pure linter with no prose file.** Also considered — just run physical
checks and skip narratives entirely. I kept this as a *mode* (the script
works without `--narratives`), but it can't do the thing you actually
asked for. Wrong cardinality is only wrong relative to a claim. Without a
claim, `tenant_settings.tenant_id` not being unique is just a fact.

**Infer domains automatically** from FK clusters or name prefixes instead
of asking a human. Rejected because the original's insight was correct:
the domain list is a *gate*, not a convenience. If a human has to add every
new table to a list, the human also writes the sentence that says what the
table is for, and that sentence is what the review checks against.

**Mermaid ERD in the HTML** via CDN. Rejected to keep the HTML
self-contained (the original's requirement: a file you can email). The
ERDs went into the markdown pages instead, where GitHub renders them.

## 3. How the pieces fit

```
schema.sql ──► parse_schema() ──► Table/Column/FK/Index model
                                        │
narratives.json ─────────────────► Reviewer.run() ── findings[]
  (domains, blurbs, assertions)         │
                                        ▼
                    schema.json ── the model + findings, for machines (and Claude)
                    index.html  ── the same, for humans, findings inline per table
                    FINDINGS.md ── findings only, with fix SQL, for the PR
                    domains/*.md ── docs per domain with ERDs, for GitHub
                                        │
                  SKILL.md + checklist ──► Claude reads schema.json, writes REVIEW.md
                                        │
                              new assertions ──► back into narratives.json
```

The order matters. `_derive()` runs after *all* statements are parsed, so a
FK declared in an `ALTER TABLE` at the bottom of the file still gets its
`unique` / `indexed` / `cardinality` computed. Checks run after derive so
they never compute anything themselves — they only *read* the model. That's
why each check is ten lines. And the renderers run last and share the same
`findings` list, which is why a finding in the HTML links to the table and
the table links back to the finding.

The loop at the bottom is the part I'm proudest of. Every time Claude
notices something the script couldn't — "the narrative implies
`github_app_config` → `installation` but there's no FK" — that observation
becomes one JSON line, and next run it's a red finding in CI. The review
document should get *shorter* over time. That's the ratchet.

## 4. Tools and frameworks, and what would have changed

- **pglast** — the real parser. Everything else was optional; this wasn't.
  Alternative: `sqlglot` (pure Python, multi-dialect, weaker on Postgres
  extras like RLS). If you ever need Oracle DDL for the Avaloq side,
  sqlglot is the pivot — you'd lose RLS/policy parsing and keep everything
  else.
- **Dataclasses + `asdict()`** for the model. Means the JSON output is
  free and the model is the documentation. A class hierarchy or pydantic
  would have added nothing.
- **Hand-written HTML/CSS, no framework.** Self-contained was a hard
  requirement. I did switch from CSS grid to flexbox after a screenshot in
  an old renderer collapsed — not because grid is wrong but because "works
  in whatever the PDF exporter uses" is a real constraint for docs.
- **wkhtmltoimage** to actually *look* at the output. I nearly skipped
  this. The screenshot caught that all finding text was rendering red
  (a `.error` class bleeding into body text) and that backticks were
  showing literally. Twenty seconds of looking beats reading CSS.
- **A seeded sample schema** with every flaw marked `⚠ FLAW`. This is the
  test suite. Not unit tests — a small realistic schema where I know the
  answer key. Every check earns its place by catching its flaw and nothing
  else.

## 5. Tradeoffs

**Precision over recall in the checks.** The junction-table heuristic
originally fired on `approval_request` (five FKs, tiny payload). I
tightened it to "exactly two non-tenant, NOT NULL FKs." That will now miss
some real junction tables with a third optional FK. I accepted that,
because a reviewer who cries wolf gets muted. Every false positive costs
more trust than a false negative costs correctness.

**Severity is opinionated.** Money-as-float is an error; timestamp-without-
tz is a note. You may disagree. The tradeoff is that a tool with no
opinion produces a list nobody reads. Change the severities in one place
(`self.add(...)` calls) if your team's pain ranks differently.

**Narratives are extra work.** Someone has to write the JSON. The payoff
only arrives after the first time it catches a regression. I made the file
optional so the tool has value on day one, but the honest sales pitch is:
the first hour of writing assertions is the most valuable hour.

**PostgreSQL only.** Deliberate. A multi-dialect parser would have made
every check weaker.

**Findings include fix SQL that is *nearly* right.** `ADD PRIMARY KEY (...)`
with literal dots; `CHECK (status IN (...))`. I chose "obviously a
template" over "plausibly correct but subtly wrong," because copy-paste of
a wrong constraint is worse than copy-paste of an incomplete one.

## 6. The mess

- First run: 46 findings, including `approval_request` as a junction table
  and `legacy_import_staging` flagged twice (no domain *and* no tenant
  path). Both were the same class of bug: a check running on a table that
  another check had already disqualified. Fix: unclaimed tables are
  skipped by the tenant checks when domains exist.
- `role_permission` got a *warning* for tenant-derivability. Correct fact,
  wrong volume — junction tables reach the tenant through a join by
  design. Downgraded to a note when the table looks like a junction.
- The sample schema had RLS on one table only, so twelve "no RLS" errors
  drowned everything else. I turned RLS on for most sample tables so two
  real gaps remained visible. Lesson: your test fixture's noise level is a
  design decision.
- Pipes in a column comment (`Organization | User`) broke the markdown
  table. Escaped. The kind of thing you only find by looking.
- I could not see HEIC files natively — had to convert them. Minor, but
  it's why the first tool call was image conversion, not code.

## 7. Pitfalls for next time

- **Don't trust a schema file that was written by hand.** `pg_dump
  --schema-only` from a dev database is the truth; the checked-in
  `schema.sql` is what someone remembered to update. Run the tool on the
  dump at least once and diff the findings.
- **Assertions are claims, and claims can be wrong.** A wrong `expect:
  "1:1"` yields a confident red error. The SKILL.md says "show the draft
  to the user before running" for exactly this reason.
- **Concatenated migrations need ordering.** `sort -V`, not `sort`.
  `V10` sorts before `V2` otherwise and your DROP COLUMN runs before the
  ADD.
- **Hub tables are where migrations hurt.** The `blast-radius` finding is
  informational, but it's the one to read before scheduling any change.
- **Don't let the docs and the review drift.** They're one command here.
  If they ever become two, one of them will rot.

## 8. What an expert notices

A beginner reads the findings list top to bottom and starts fixing. An
expert reads the *dependencies between findings* first. In the sample:
denormalising `tenant_id` onto `webhook_delivery` requires a composite FK,
which requires `UNIQUE (tenant_id, id)` on the installation table, which
is the F016 fix. Three findings, one migration, one order.

An expert also notices what's *absent* from the findings. `tenant_auth_config`
uses the tenant id as its primary key — 1:1 enforced by construction, no
UNIQUE needed, no finding. That's the pattern `tenant_settings` should have
copied, and the review says so. Naming the good decisions is not
politeness; it's how you show the reader you understood the model rather
than pattern-matched it.

And an expert distrusts singletons. `github_app_config` has no finding
above "info," but every expert who has run a multi-tenant platform knows
the day a second one is needed arrives, and that the migration is cheap
while there is one row. The tool can't rank that; the review can.

## 9. Lessons for completely different projects

**Separate the decidable from the judgment, and put a data file between
them.** Terraform plan reviews, Kubernetes manifest reviews, IAM policy
reviews — same shape. A linter for what a linter can know, a model for the
rest, and a file where the model's conclusions become the linter's rules.
Conftest/OPA is this pattern for infra; this tool is it for schemas.

**Intent has to be written down somewhere the machine can read it.** "Each
tenant has one settings row" lived in a developer's head. Now it lives in
`narratives.json`, and the head can go on holiday. Any system where the
recurring bug is "the code allows something that everyone knows shouldn't
happen" has this gap.

**Test fixtures with an answer key beat unit tests for heuristics.** A
small realistic input where you know every expected output tells you about
precision *and* recall at once. Works for log parsers, alert rules, cost
anomaly detectors.

**Look at the output.** Render it, screenshot it, read the markdown in a
viewer. Every visual bug I fixed today was invisible in the code.

**The gate is the product.** Your colleague's script had one non-negotiable
rule — every table must be claimed — and that rule is why the docs were
still accurate at 162 tables. Add one rule that fails the build and the
tool survives; add ten warnings nobody reads and it doesn't.


---

## Postscript — 2026-08-31: ported to TypeScript

The Python version described above is gone. The machines this runs on have no
Python, so the script is now `scripts/db-review.ts`, run directly by Node 24
(no build step) with `libpg-query`, a WebAssembly build of the same PostgreSQL
parser that pglast wrapped. Section 2's reasoning still holds: the deep choice
was "real parser, not regex", and that survived the port. Go was considered and
rejected because its binding compiles the C parser at build time, which means a
C compiler or a pre-built binary per platform for anyone copying the skill in.

What stayed: the four sections (model, parse, checks, render), the check order,
every finding's wording, the JSON key order, the self-contained HTML. What
changed: pglast's built-in printer is replaced by a hand-written one
(`renderExpr`) that reproduces pglast's formatting for the node kinds that occur
in table DDL — constants, casts as `CAST(x AS type)`, operators with nested
operands in parentheses, `NOT(...)` around boolean groups, `IN`, `BETWEEN`,
`LIKE`, `ANY`, `CASE`, `COALESCE`, `GREATEST`/`LEAST`, subscripts. Anything
else renders as `…` plus the column names inside it, so the either/or check
still sees its columns; row values and `COLLATE` are the two known cases. The
parse walk is typed against `@pgsql/types`, so a misspelt enum value or field
is a compile error rather than a silent miss. The foreign-key-cycle check now
walks tables in insertion order, where the Python iterated a hash-randomised
set. libpg_query reports a statement's location as the byte after the previous
semicolon; pglast moves it to the first token (checked: it reports 674 for
`CREATE TABLE provider`, and that is where the text starts), so `firstToken()`
does the same before line numbers and descriptions are read.

Verification has three parts, all in `npm test`. The sample schema's committed
output, produced by the Python, is compared byte for byte; only the timestamp
and the script's name in the FINDINGS.md header differ. A second fixture,
`test/fixtures/edge-cases.sql`, holds every construct the sample lacks; its
golden output came from this tool after diffing it against the Python on the
same input, where the only differences were that header line and the row-value
CHECK. And `test/fixtures/expressions.sql` holds 54 expressions whose expected
renderings are what pglast printed for the same file; 52 match, the other two
are the documented fallback.
