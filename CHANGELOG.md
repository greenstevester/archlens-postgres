# Changelog

Every release, newest first. Each heading links to its full notes on GitHub, which
carry the reasoning and the test counts; this file is the summary you can read in one
sitting.

The version in `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`,
`skills/db-architecture-review/.claude-plugin/plugin.json` and
`skills/db-architecture-review/package.json` always match the tag. Users only receive an
update when the marketplace entry's version changes.

## [2.0.0](https://github.com/greenstevester/archlens-postgres/releases/tag/v2.0.0) — 2026-09-05

The project is now **ArchLens Postgres**. Repository, marketplace, plugin, skill folder and script
all carry the new name. Nothing about what the tool does changed; the major bump is for the
install path, which did.

**Changed**

- Repository: `greenstevester/db-architecture-reviewer` → `greenstevester/archlens-postgres`.
  GitHub redirects the old address for clones and links.
- Marketplace `db-architecture-reviewer` → `archlens-postgres`; plugin and skill
  `db-architecture-review` → `archlens-postgres`; the skill folder is `skills/archlens-postgres/`
  and the script is `scripts/archlens.ts`. The generated `FINDINGS.md` names the script, so both
  golden directories were regenerated; no finding appears or disappears.
- Install is now `/plugin marketplace add greenstevester/archlens-postgres` then
  `/plugin install archlens-postgres@archlens-postgres`.

**For existing users**

Remove the old marketplace and plugin, then add and install the new names. Installed copies of
`db-architecture-review` will not receive this or later updates.

## [1.7.1](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.7.1) — 2026-09-03

Past forty tables the whole-schema diagram at the top of `index.html` was a strip of unreadable
boxes. It is now a map of the 3D layout that opens the explorer when clicked, and the explorer
has a way back.

**Changed**

- The Schema section of `index.html` shows `svgSchemaMap()`: the explorer's island layout seen
  from above, one block per table, one curve per foreign key in the child's domain colour, wrapped
  in a link to `schema-3d.html`. The whole-schema flat diagram is gone from the page; each domain
  section keeps its own, and `erd.svg` is still written.
- `README.md`'s Diagram section leads with the same map as a new file, `schema-map.svg`, linked
  to the explorer, and names `erd.svg` in a sentence instead of embedding it.
- `schema-3d.html` starts its controls with "← Docs & findings", back to `index.html`; scroll
  now zooms toward what is under the pointer, carrying the orbit centre with it; and a Recenter
  button frames the whole schema again without clearing the selection (Reset view still does both).

No finding appears or disappears — counts and severities are identical on both fixtures. One test
changed with the behaviour: the README diagram test now expects the map, not the flat diagram.

## [1.7.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.7.0) — 2026-09-03

A schema past forty tables was unreadable in the flat diagram. Every run now also writes
`schema-3d.html`, a self-contained page you rotate: one island per domain, the hub domain in the
middle, every foreign key drawn as an arc, click any table or any arc for its detail.

**Added**

- `schema-3d.html`. Domain islands on a ring, cards on a grid inside each, arcs low inside an
  island and lifted across islands, a dashed arc where the key has an `fk-index` finding, a red or
  amber mark on a table with an error or warning. Click a table: its arcs stay lit, the rest fade,
  a panel lists columns, references and findings. Click an arc: cardinality in words, nullable,
  index, ON DELETE, the narrative why, findings on that key. Search, domain chips, a hub-edge
  control (All, Muted, Hidden), deep links (`#t=orders`, `#fk=orders.tenant_id`), and a
  "View in 3D" link on every table in `index.html`. Without narratives, islands are dependency
  depths.
- `three` 0.185.1 as the second pinned runtime dependency. The script rewrites its minified
  modules into one classic script and inlines it, so the page still loads nothing from the web.
- Two ratchets: no output file may load anything from the web, and the browser files must parse.

No finding appears or disappears — counts and severities are identical on both fixtures.

## [1.6.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.6.0) — 2026-09-02

`fk-index` says what the index it asks for will cost, and asks for the cheaper one where
that is the right instrument.

**Changed**

- A nullable foreign key gets a **partial** index, `WHERE col IS NOT NULL`. Nullable foreign
  keys are overwhelmingly audit columns that are NULL for almost every row, so those rows are
  not indexed at all. Measured on a 500k-row table: 200k inserts at 1006 ms bare, 1119 ms
  with a full index, 1046 ms partial; the constraint check at 20.177 ms bare, 0.159 ms full,
  0.040 ms partial — 4% on writes rather than 11%, and faster on the check than a full index.
  A `NOT NULL` foreign key still gets a plain index.
- The `detail` prices the index rather than only praising it: every write maintains it, it
  takes disk, and if the parent's rows are never deleted or re-keyed the scan never happens
  and the index only costs.

No finding appears or disappears — counts and severities are identical on both fixtures.

## [1.5.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.5.0) — 2026-09-02

A finding you have reviewed and judged wrong can be recorded as such, instead of being
re-derived on every run.

**Added**

- `assertions.accepted[]` — `{check, table, columns, why}`. Matched on check, table and
  columns, never on the finding id, which is renumbered whenever a check moves. A
  columns-less entry matches only table-level findings, so it cannot swallow the next
  column finding that appears.
- Dismissed findings are printed rather than hidden: a "Reviewed and dismissed" section in
  `FINDINGS.md` and a `dismissed` array in `schema.json`, both omitted entirely when
  nothing was dismissed. They do not count toward the severity totals or trip `--fail-on`.
- `accepted-entry` warning, on by default, for an entry with no `why` (the finding stays
  reported) or one matching no finding. The second is the anti-rot guard and fires with the
  original finding restored, so a renamed column produces two warnings rather than silence.

**Fixed**

- A dismissed finding's id had to leave `table.findings` as well as the findings list. Both
  writers render a table's findings by looking each id up, so an id left behind
  dereferenced to `undefined` and took the whole run down.

## [1.4.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.4.0) — 2026-08-31

A narrative entry is matched to one foreign key by a single resolver, used by both the
cardinality check and the documentation.

**Added**

- Two `cardinality` warnings: an entry that does not say which foreign key it means, and an
  entry whose `columns` is empty and so matches nothing.

**Fixed**

- An entry with no `columns`, on a table with two foreign keys to the same parent, had its
  `expect` enforced against every one of those keys while its `why` printed beside none of
  them — a wrong error on one key and a silently dropped narrative on another, in one run.

## [1.3.2](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.3.2) — 2026-08-31

Diagram labels are legible everywhere, and a run without narratives can no longer delete
documentation. Carries the 1.3.1 work, never tagged on its own.

**Fixed**

- A run without `--narratives` deleted every `domains/*.md` and `.svg` in the output
  directory: the stale-page cleanup saw an empty domain list and reconciled everything away.
- Edge labels overprinted into a smudge when several foreign keys left one child. Labels are
  now packed into three heights per row, the drawing grows to fit its longest label instead
  of clipping it, and each label paints a background halo so a crossing line breaks behind
  the text.

## [1.3.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.3.0) — 2026-08-31

Every diagram is SVG, and no output contains Mermaid.

**Added**

- `index.html` always carries a whole-schema diagram, including bare runs with no
  narratives, which previously produced HTML with no diagrams at all.
- The Markdown docs get `.svg` files written beside the pages — `erd.svg` for the whole
  schema, one per domain — embedded as images. GitHub renders them; nothing executes.

**Removed**

- Mermaid, everywhere, along with `mermaidErd()`. A reader without a Mermaid renderer had
  been seeing fence-block source text where the diagram should be. A ratchet test now fails
  the build if any output file mentions it again.

## [1.2.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.2.0) — 2026-08-31

One `why` per foreign key, and a heading for the HTML relationship list.

**Added**

- `assertions.cardinality[]` entries accept `columns`, so a table with two foreign keys to
  the same parent can carry a separate `why` per key. An entry without `columns` is refused
  on an ambiguous pair, so two keys never share one sentence.

**Fixed**

- The relationship list in `index.html` had no heading and read as loose lines between the
  diagram and the first table card.

## [1.1.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.1.0) — 2026-08-31

Diagrams draw every relationship, including ones crossing a domain boundary, and every
foreign key is described in words.

**Added**

- A whole-schema diagram in `README.md`, and cross-domain edges on domain diagrams, so a hub
  schema's pages no longer show boxes with no lines between them.
- An inline SVG diagram per domain in `index.html`: parents above children, dashed stubs for
  parents from other domains, crow's-foot ends read from the schema, self-references as a
  loop, and long edges in their own lane. Nothing loaded from the network.
- A Relationships list on every domain page and HTML section, each foreign key written out
  followed by the `why` from the matching `cardinality[]` entry.
- `assertions.require_relationship_notes`, off by default: a foreign key with no `why`
  becomes an `undocumented-relationship` note.

## [1.0.1](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.0.1) — 2026-08-31

Three false positives on schemas produced by `pg_dump --schema-only`, found when a real dump
produced 6 wrong findings out of 28.

**Fixed**

- `pg_dump` writes every CHECK as a table-level constraint and only inline CHECKs were
  attributed to a column, so every guarded `status` column was reported as unguarded.
- `singleton-table` fired on every asserted singleton whether or not a one-row guard existed.
- The `\restrict` / `\unrestrict` lines `pg_dump` 16.10+ and 17.6+ emit made the parser
  throw. They are blanked to the same length before parsing, so line numbers still hold.

## [1.0.0](https://github.com/greenstevester/db-architecture-reviewer/releases/tag/v1.0.0) — 2026-08-31

First public release. Documents a PostgreSQL schema and reviews its design in one run: 23
deterministic checks, browsable HTML and Markdown docs with the findings inline, and a
`SKILL.md` guiding Claude through the judgment pass the script cannot do.
