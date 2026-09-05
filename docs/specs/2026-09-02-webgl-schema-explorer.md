# Spec: a rotatable 3D explorer for large schemas

Date: 2026-09-02
Status: design agreed in conversation; Steve reviews this file before the implementation plan is written. Nothing is committed yet.

## Goal

A developer with a schema of 70 to 300 tables opens one file, sees every table grouped by domain with every foreign key drawn between them, rotates and zooms the whole thing, and clicks any table or any relationship line for its detail.

The flat SVG the tool draws today stops being readable somewhere past 40 tables. On a 73-table schema it is five rows of tiny boxes joined by vertical lines that all look the same. That SVG stays as the printable diagram. The new file is the one you explore.

## Decisions taken in the brainstorm

Each was chosen against live prototypes of a made-up 120-table, 11-domain schema with one hub table most others point at.

1. **Target size.** Comfortable up to about 300 tables. Labels fade with distance; tables past that are out of scope.
2. **Layout: domain districts.** One island per domain, the hub domain in the middle, foreign keys as arcs. Chosen over dependency rings (height is dependency depth) and a force-directed cloud (physics places everything). Rings hide domains; the cloud turns into a hairball around the hub and moves between runs.
3. **Delivery: its own self-contained file.** `schema-3d.html` with Three.js inlined from a pinned dependency. Chosen over loading Three.js from a CDN (needs internet, breaks the "loads nothing from the web" rule) and over embedding inside `index.html` (adds a megabyte to the printable docs and a blank rectangle to every PDF export).
4. **Hub edges: all on by default.** Every foreign key at full strength. Muted and Hidden stay as one-click toggles.
5. **Lines are clickable.** Hovering a line names the relationship; clicking it opens the relationship detail.

## Behaviour changes

1. **A new output file, `schema-3d.html`,** written on every run, with or without narratives, by a fourth writer in `archlens.ts`.
2. **`index.html` links to it.** The Schema section gains an "Open the 3D explorer" link above the SVG, and every table section gains a "View in 3D" link to `schema-3d.html#t=<table>`, which opens the explorer focused on that table.
3. **The generated `README.md` links to it** from its Diagram section.
4. **A second runtime dependency.** `three` pinned at exactly `0.185.1` in `package.json`, beside `libpg-query`.

## The file

### What is inside

One HTML document, in this order:

1. Our CSS, inline.
2. The model as compact JSON in a `<script>` that assigns `window.SCHEMA3D`.
3. The vendored Three.js block, between the comments `/* three:start */` and `/* three:end */`, as one classic script that defines `THREE` and `OrbitControls`. About 750 KB.
4. The layout module and the app, inline.
5. A "Generated from `<source>` on `<date>`" line in the page footer, like `index.html`.

No `src` or `href` points at `http`. No import map. No fonts. Open it from disk, from an email attachment, or from a USB stick and it works.

### Vendoring Three.js

Three.js 0.185.1 ships its minified build as two ES modules, `three.module.min.js` (366 KB), which imports everything it needs from `three.core.min.js` (385 KB), plus `examples/jsm/controls/OrbitControls.js` (40 KB), which imports from `three`. Browsers cannot import an inline module, so at generation time the writer reads the three files from `node_modules` and rewrites them into one classic script:

- `three.core.min.js`: the trailing `export{A as Name,...}` becomes `return{Name:A,...}`; the whole file is wrapped as `const THREE_CORE=(()=>{...})();`.
- `three.module.min.js`: the leading `import{Name as a,...}from"./three.core.min.js"` becomes `const{Name:a,...}=THREE_CORE;`; the export tail becomes a return; wrapped as `THREE_MAIN`; then `const THREE={...THREE_CORE,...THREE_MAIN};`.
- `OrbitControls.js`: `import {A, B} from 'three';` becomes `const {A, B} = THREE;`; `export { OrbitControls };` becomes `return OrbitControls;`; wrapped as `const OrbitControls=(()=>{...})();`.

The rewrite is four regular expressions against a pinned input. A test runs the result in a Node sandbox and asserts `THREE.REVISION === '185'` and that `OrbitControls` is a function, so a Three.js upgrade that changes the file shape fails the suite instead of shipping a broken page. If that ever happens, the fallback is `three.cjs`, a single 2.1 MB CommonJS file with no `require` calls, wrapped whole with a fake `module` object. The rewrite carries a `ponytail:` comment naming that fallback.

### The model JSON

Built by a new `schema3dModel(tables, extras, narratives, findings)` from the same objects the other writers use, so nothing is parsed twice.

```
domains: [{ key, title, blurb, color }]
tables:  [{ name, domain, description, source_line,
            columns: [{ name, type, pk, fk, not_null }],
            findings: [{ id, severity, title, check }] }]
fks:     [{ child, columns, parent, ref_columns, name,
            cardinality, nullable, unique, indexed, on_delete,
            why, words,
            findings: [{ id, severity, title, check }] }]
hubs:    [table names referenced by at least a third of the other tables, and by at least 4]
```

`color` is taken by position from a fixed list of 12 colours, cycling past 12. `words` is the sentence `describeRelationship()` already writes for the docs. `why` comes from `narratives.json` or is `null`. A finding attaches to a foreign key when its `columns` equal that key's columns and its check is one of the five key-level checks (`fk-index`, `fk-nullable`, `fk-on-delete`, `cardinality`, `undocumented-relationship`); every other finding attaches to its table.

The hub rule is relative rather than a fixed count so it holds from the 19-table sample (where `tenant` has 10 inbound keys and `users` 5) to a 300-table schema (where only a column every table carries, such as `tenant_id`, reaches a hundred).

Tables claimed by no domain go into a synthetic domain `unclaimed` (grey, titled "Unclaimed"). With no narratives at all there is one synthetic domain per dependency depth, keyed `depth-0`, `depth-1`, ..., titled "Depth 0: tables that depend on nothing", "Depth 1: 1 step below a root" and so on, so the bare run still produces a usable picture.

### Layout: `scripts/schema-3d-layout.js`

Pure functions, no Three.js import, run by Node in the tests and by the browser in the page. Same input gives the same coordinates.

- **Islands.** The domain holding the most-referenced table sits at the origin. The others go round a ring in `narratives.json` order. Ring radius starts at the larger of the summed island footprints (plus a gap each) over 2π and the clearance the centre island needs from the largest ring island, then widens in 10% steps until no two islands overlap, so islands never touch. With one domain there is no ring.
- **Grid inside an island.** Columns are the ceiling of the square root of the table count. Tables sort by dependency depth inside the island, then by name, so arcs inside an island mostly run one way. Spacing is 3.6 across and 2.4 deep, set from the 3.4-unit column card so close-up cards never overlap.
- **Arcs.** A quadratic curve from child to parent. Lift is 1.2 inside an island and `3 + 0.16 × distance` across islands. A self-reference is an arc over its own card, from one long edge to the other, lifted 2.2. A composite foreign key is one arc.
- **Hubs.** A table referenced by at least a third of the other tables, and by at least 4.

### Scene: `scripts/schema-3d-app.js` and `scripts/schema-3d.css`

- **Cards.** A flat slab, 1.8 by 0.16 by 1.1, in the domain colour, on a translucent plate per island with the domain title in front of it. A name label that always faces the camera. Within 22 units of the camera the name swaps for the column card: name, up to 8 columns with PK and FK marks, then "+N more". A table with an error finding gets a red mark on its slab, a warning an amber one.
- **Arcs.** Child's domain colour, a dot at the parent end. A foreign key carrying an `fk-index` finding is dashed. Default opacity is 0.7 inside an island and 0.45 across. Hub edges follow the Hub edges control: All (default), Muted (0.09), Hidden.
- **Hover.** A card brightens and shows its name. An arc turns white and shows a tooltip such as `orders.tenant_id → tenant.id · N:1 · nullable`.
- **Click a table.** Focus mode. Its arcs and its neighbours stay at full strength, everything else fades to 0.08. The side panel shows name, domain, description, columns with type and key marks, References and Referenced by as clickable rows that select the arc, the table's findings with severity, and a link to `index.html#t-<table>`.
- **Click an arc.** The panel shows child column to parent column, `words`, cardinality, nullable, unique, index name or "no index", ON DELETE, constraint name, `why` or "not documented", and any finding on the key. Both table names select and fly to that table.
- **Moving about.** Orbit with damping, right-drag pan, scroll zoom between 4 and 180 units, polar angle capped so the camera never goes under the ground, fog from 90 to 220 units. Double-click flies to a table or to the midpoint of an arc: 800 ms, eased, time-based, exact end pose. Esc and the Reset view button clear the selection and fly home. Home frames every island. A slow idle rotation runs until the first pointer, wheel or key event.
- **Search.** The box fades tables whose name and column names do not contain the text. Enter flies to the first match. Pressing `/` anywhere focuses the box.
- **Domain chips.** Clicking a chip when all are on isolates that domain. Further clicks toggle. An "all" chip restores everything.
- **Deep links.** On load the page reads `#t=<table>` or `#fk=<child>.<column>` and opens focused and flown to it. Selecting anything updates the hash, so a view can be copied and sent.
- **Accessibility.** Every control has a visible or `aria-label` name. A polite live region announces selections ("orders selected, 5 foreign keys out, referenced by 3"). Under `prefers-reduced-motion` there is no idle rotation, no damping, and flights are instant.
- **No WebGL.** The canvas is replaced by a sentence saying so and a link to `index.html#schema`.
- **Scale.** Under 300 tables, cards are separate meshes and arcs are separate line objects, and picking raycasts against all of them on pointer move. Merging arcs into one geometry is a marked `ponytail:` for schemas past about a thousand foreign keys. Not built now.
- **Look.** Dark scene only: background `#0e1116`, labels on translucent dark plates, domain colours from the palette. No light theme.

## What does not change

- `svgErd()`, `erd.svg`, `domains/*.svg`, `schema.json`, `FINDINGS.md`, the checks, the severities. Finding counts on both fixtures stay at `8 error, 18 warn, 12 info` and `9 error, 8 warn, 11 info`; a new finding is a bug in this change.
- `index.html` apart from the two kinds of link. Still one file, still printable.
- The rule that no output loads anything from the web. The new file obeys it.

## Output tree after the change

```
out/
  README.md          <- links schema-3d.html
  erd.svg
  FINDINGS.md
  index.html         <- "Open the 3D explorer" + "View in 3D" per table
  schema-3d.html     <- NEW, about 0.8 MB plus the data
  schema.json
  domains/
    core.md
    core.svg
```

## Tests (written first, each watched failing)

Added to `test/archlens.test.ts` in the existing four groups.

1. **Golden runs.** Both fixtures write `schema-3d.html`; the whole file is compared with the committed golden, ignoring only the generated-on line, exactly as `index.html` is today. A Three.js upgrade therefore regenerates both goldens, and that diff is accepted as the price of a self-contained file. Bare run: the file exists and its domains are `depth-0`, `depth-1`, ...
2. **Model.** `schema3dModel()` on the sample: one entry per table and per foreign key; every foreign key carries every field the panel reads; `fk-index` findings land on their key and `primary-key` findings on their table; `hubs` is exactly `['tenant']` on the sample (10 of 18 other tables) and `['org']` on the edge-case fixture (6 of 9).
3. **Layout.** The centre island is the hub's domain; inside an island parents sort before children; the same model gives the same coordinates twice; no two islands overlap on the sample; with no narratives every island key starts with `depth-`.
4. **Bundle.** The rewritten Three.js runs in a Node sandbox: `THREE.REVISION` is `'185'`, `THREE.WebGLRenderer` and `OrbitControls` are functions.
5. **Ratchets.** No output file contains `src="http`, `href="http`, or `importmap`. The existing `mermaid` ratchet covers the new file without change.
6. **Links.** `index.html` contains the explorer link and one "View in 3D" link per table with the right hash; `README.md` contains the explorer link.
7. **Syntax.** `node --check` passes on `schema-3d-layout.js` and `schema-3d-app.js`.

Before the pull request, both fixture outputs are opened in a headed browser: zero console errors, click one table, click one arc, follow one deep link, resize the window.

## Docs

`CLAUDE.md` (what the repo is, commands, testing groups, the rendering paragraph, a new paragraph on the explorer and the vendoring rewrite), both `README.md` files (output tree, install notes mentioning the second dependency), `SKILL.md` step 5, `CHANGELOG.md` entry for 1.7.0.

## Sequencing and release

- A worktree off `main` at `28217a2`, branch `feat/schema-3d-explorer`.
- Add `.superpowers/` to `.gitignore` in the same branch; the brainstorm mockups live there.
- Version 1.7.0 in the four places that move together: `.claude-plugin/marketplace.json` (both fields), `.claude-plugin/plugin.json`, `skills/archlens-postgres/.claude-plugin/plugin.json`, `skills/archlens-postgres/package.json`. `claude plugin validate .` and `claude plugin validate skills/archlens-postgres` must pass.
- Commits are atomic and asked for one at a time, per the standing rule.

## Defaults standing unless Steve overrides

1. Dark scene only.
2. The hub rule (a third of the other tables, minimum 4) is fixed, not a flag. The prototypes used a flat 12, which would have made the sample's `tenant` an ordinary table.
3. Golden files are complete on disk, about 0.8 MB each for two fixtures. Section 4 of the design discussion said the vendored block would be masked in the comparison; whole-file comparison is simpler, matches every other golden, and a stale vendor block in a golden would otherwise go unnoticed, so the mask is dropped.
4. Twelve palette colours, cycling. A schema with more than 12 domains repeats colours and the island titles carry the distinction.
5. The file is named `schema-3d.html`.
6. The 120-table synthetic schema used for the prototypes is not committed; the two existing fixtures are the tests.
