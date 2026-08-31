# Spec: no Mermaid anywhere — every diagram is SVG

Date: 2026-08-31
Status: approved for implementation with the defaults in "Decisions"; Steve reviews the result before any commit.

## Goal

A developer runs the script at any time — with or without `narratives.json` — and gets a viewable entity-relationship diagram of their whole PostgreSQL schema. No output file contains Mermaid.

Today the bare run (no narratives) produces an `index.html` with zero diagrams, and the only whole-schema diagram is a Mermaid fence in `README.md`, which renders as source text anywhere Mermaid isn't supported.

## Behaviour changes

1. **The HTML always carries a whole-schema diagram.** `writeHtml` gains a "Schema" section before the domain sections: one inline SVG from the existing `svgErd()` covering every table, in the same scrollable wrapper the domain diagrams use. Present in every run, including a bare run with no narratives. Per-domain SVG sections stay as they are.
2. **Markdown diagrams become SVG image files.** `writeMarkdown` writes `erd.svg` (whole schema) into the output folder and `domains/<key>.svg` per domain, using the same `svgErd()`. `README.md`'s `## Diagram` section becomes `![Entity-relationship diagram](erd.svg)` (replacing the Mermaid fence at `db-review.ts:1453`); each domain page embeds `![<title> diagram](<key>.svg)` (replacing the fence at `db-review.ts:1462-1463`). GitHub renders these as pictures; the files are plain images, nothing executes.
3. **`mermaidErd()` (`db-review.ts:1200`) is deleted.** This change makes it dead code; removing it is in scope.

## What does not change

- `svgErd()`'s layout and drawing — same renderer, called with more table lists. The one real edit it needs: a "standalone" mode, because the inline HTML copies use the page's CSS variables and a standalone `.svg` file has no page. Standalone files get a small embedded default palette (light background, dark strokes).
- The self-contained-HTML rule: still one file, nothing loaded, inline everything.
- `schema.json`, `FINDINGS.md`, findings, checks, severities: untouched. Finding counts on both fixtures must not change; a new finding is a bug in this change.

## Output tree after the change

```
out/
  README.md          <- links erd.svg
  erd.svg            <- NEW, whole schema
  FINDINGS.md
  index.html         <- whole-schema SVG section + per-domain SVGs
  schema.json
  domains/
    core.md          <- links core.svg
    core.svg         <- NEW, per domain
```

## Tests (written first, each watched failing)

1. No output file from either fixture contains the string `mermaid` — the ratchet that keeps it out for good.
2. Bare run: `index.html` contains a whole-schema SVG with one box per table.
3. Narratives run: the whole-schema SVG appears above the domain sections.
4. `writeMarkdown` writes `erd.svg` and one `.svg` per domain; `README.md` and each domain page reference them by relative path.
5. Standalone `.svg` files are well-formed, carry no `var(--` references, and are deterministic (same input, same bytes).
6. The five existing Mermaid tests are removed with the feature and replaced by the SVG equivalents above. This behaviour change must be called out explicitly in the PR body (per the standing testing rule: never silently delete tests).

Goldens: regenerated for both fixtures with `npm run review -- <schema> --narratives <narratives> --out <golden dir>`, diff read before accepting; new `.svg` files join the golden directories.

## Docs

`CLAUDE.md` (rendering paragraph, testing section), both `README.md`s (output tree), `SKILL.md` step 5 mentions, release notes.

## Sequencing and release

- Build on a worktree off `main`. Rebase onto `fix/relationship-columns` once that branch lands — it is now committed (551d402 feature, 43ae076 release chore, claiming v1.2.0) but not yet pushed or merged. Both changes touch the domain-section emit near `db-review.ts:1679` (that branch adds `<h3 class="rels-h">Relationships</h3>` there, above the no-foreign-keys fallback too) and the relationship area, so order matters.
- Version bump in the four usual places, moving together: `.claude-plugin/marketplace.json` (both fields), `.claude-plugin/plugin.json`, `skills/db-architecture-review/.claude-plugin/plugin.json`, `skills/db-architecture-review/package.json`. `claude plugin validate .` and `claude plugin validate skills/db-architecture-review` must pass.

## Decisions (defaults standing unless Steve overrides)

1. **Whole-schema SVG legibility.** 19 tables in one drawing will be large; `svgErd`'s layout has only been eyeballed on 4-6 table domains. Acceptance step: render the sample's whole-schema SVG and look at it. If it is spaghetti, stop and show Steve rather than building a grouped layout unasked.
2. **Per-domain `.md` diagrams stay** — they cost nothing once the `.svg` files exist.
3. **Version is 1.3.0** — output format changes; nothing a reader of `schema.json` sees breaks. (1.2.0 was originally specced here, but `fix/relationship-columns` took it with Steve's approval on 2026-08-31.) Steve may call 2.0.0 at commit time instead.
