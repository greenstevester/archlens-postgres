# 3D Schema Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `archlens.ts` writes one more file, `schema-3d.html`, a self-contained rotatable 3D view of the whole schema: one island per domain, every foreign key as an arc, click any table or arc for its detail.

**Architecture:** A new `schema3dModel()` in `archlens.ts` turns the existing table map, findings and narratives into compact JSON. A pure layout module (`scripts/schema-3d-layout.js`) places islands, cards and arcs and runs both under `node --test` and in the browser. A browser app (`scripts/schema-3d-app.js` + `scripts/schema-3d.css`) draws it with Three.js. `writeSchema3d()` inlines the JSON, a rewritten copy of the pinned Three.js modules, the layout module and the app into one HTML file. Nothing is loaded from the web.

**Tech Stack:** Node 24 (runs `.ts` directly), `node --test`, Three.js 0.185.1 (pinned, vendored at generation time), plain JavaScript and CSS for the page.

**Spec:** `docs/specs/2026-09-02-webgl-schema-explorer.md`. Read it first.

**Working directory:** every command below runs from `skills/archlens-postgres/` inside the worktree unless it says otherwise. The worktree is `.claude/worktrees/schema-3d-explorer` on branch `feat/schema-3d-explorer`.

**Commits:** Steve's standing rule is to ask before every commit. At each commit step, show `git status --short` and the message and wait for a yes, unless he has approved this plan's commit list in advance. Conventional commits, no emoji, imperative mood, each ending with the attribution trailer the session prescribes.

---

## File structure

| File | Responsibility |
|---|---|
| `skills/archlens-postgres/scripts/archlens.ts` | Gains one section, "3D explorer", before the CLI section: the model builder, the Three.js rewrite, the writer. `writeHtml` and `writeMarkdown` gain links. `main()` calls the writer. |
| `skills/archlens-postgres/scripts/schema-3d-layout.js` | Pure functions: dependency depth, island ring, card grid, arc lifts. No Three.js. ES module for the tests; inlined as a classic script (its `export` keywords stripped) in the page. |
| `skills/archlens-postgres/scripts/schema-3d-app.js` | The scene, picking, focus mode, panel, search, chips, hub control, deep links, flights, level of detail. Classic script; expects the globals `THREE`, `OrbitControls`, `SCHEMA3D`, `layout`, `CARD`. |
| `skills/archlens-postgres/scripts/schema-3d.css` | The page's styles. |
| `skills/archlens-postgres/test/archlens.test.ts` | New describe blocks; golden lists gain `schema-3d.html`. |
| `skills/archlens-postgres/examples/out/schema-3d.html`, `test/fixtures/edge-cases.out/schema-3d.html` | New golden files, generated. |
| `skills/archlens-postgres/package.json`, `package-lock.json` | `three` pinned at `0.185.1`. |
| `.gitignore`, `CLAUDE.md`, `README.md`, `skills/archlens-postgres/README.md`, `CHANGELOG.md`, the four version files | Housekeeping, docs, release. |

---

### Task 1: Housekeeping commits (spec, gitignore)

**Files:**
- Modify: `.gitignore` (repo root)
- Already present, uncommitted: `docs/specs/2026-09-02-webgl-schema-explorer.md`, `docs/plans/2026-09-02-webgl-schema-explorer.md`

- [ ] **Step 1: Ignore the brainstorm mockups**

Append to the repo-root `.gitignore`:

```
.superpowers/
```

- [ ] **Step 2: Confirm the ignore works**

Run from the repo root of the worktree: `git status --short`
Expected: `.gitignore` modified, the two docs untracked, nothing under `.superpowers/` listed.

- [ ] **Step 3: Commit (ask first)**

```bash
git add .gitignore docs/specs/2026-09-02-webgl-schema-explorer.md docs/plans/2026-09-02-webgl-schema-explorer.md
git commit -m "docs: spec and plan for the 3D schema explorer"
```

---

### Task 2: Pin Three.js as a runtime dependency

**Files:**
- Modify: `skills/archlens-postgres/package.json`
- Modify: `skills/archlens-postgres/package-lock.json`

- [ ] **Step 1: Install with an exact pin**

Run: `npm install three@0.185.1 --save-exact --no-audit --no-fund`
Expected: `package.json` `dependencies` now reads

```json
  "dependencies": {
    "libpg-query": "17.7.4",
    "three": "0.185.1"
  },
```

- [ ] **Step 2: Confirm the files the rewrite needs exist**

Run: `ls node_modules/three/build/three.core.min.js node_modules/three/build/three.module.min.js node_modules/three/examples/jsm/controls/OrbitControls.js`
Expected: three paths printed, no error.

- [ ] **Step 3: Baseline still green**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 145`, `fail 0`.

- [ ] **Step 4: Commit (ask first)**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): pin three 0.185.1 for the 3D explorer"
```

---

### Task 3: `bundleThree()`: the pinned modules as one classic script

**Files:**
- Modify: `skills/archlens-postgres/scripts/archlens.ts` (imports at line 24; new section before the `// CLI` banner, currently around line 1899)
- Test: `skills/archlens-postgres/test/archlens.test.ts` (imports at lines 9-13; new block at the end of the file)

- [ ] **Step 1: Write the failing test**

Add to the import list from `'../scripts/archlens.ts'` in the test file: `bundleThree, threeDir`. Add `import vm from 'node:vm';` after the `node:url` import. Append at the end of the file:

```ts
describe('bundleThree', () => {
  it('rewrites the pinned Three.js modules into one classic script that runs', () => {
    const bundle = bundleThree(threeDir());
    assert.match(bundle, /^\/\* three:start Three\.js 0\.185\.1 /);
    assert.match(bundle, /\/\* three:end \*\/\n$/);
    // A classic script may not contain module syntax; the sandbox would throw a SyntaxError.
    // The bundle needs no browser globals to evaluate, so the context starts empty.
    const ctx: Record<string, unknown> = {};
    // The sandbox realm has its own Object.prototype, so hand the result out as JSON: strict deep
    // equality would otherwise reject an object built inside it.
    vm.runInNewContext(`${bundle}\nresult = JSON.stringify({ rev: THREE.REVISION, renderer: typeof THREE.WebGLRenderer, orbit: typeof OrbitControls, v3: typeof THREE.Vector3 });`, ctx);
    assert.deepEqual(JSON.parse(ctx.result as string), { rev: '185', renderer: 'function', orbit: 'function', v3: 'function' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test 2>&1 | grep -E "bundleThree|fail [0-9]"`
Expected: the suite fails to load because `bundleThree` is not exported (a `SyntaxError: The requested module ... does not provide an export named 'bundleThree'`), or `fail 1`.

- [ ] **Step 3: Implement**

In `archlens.ts`, change the imports at the top to add `createRequire`:

```ts
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
```

Insert a new section immediately before the `// CLI` banner (the three-line `// ---- / // CLI / // ----` comment above `const USAGE`):

```ts
// ----------------------------------------------------------------------------
// 3D explorer: vendored Three.js, model, writer
// ----------------------------------------------------------------------------

const THREE_FILES = {
  core: 'build/three.core.min.js',
  main: 'build/three.module.min.js',
  orbit: 'examples/jsm/controls/OrbitControls.js',
};
/** How three.module.min.js names its core chunk in its own import and re-export. */
const CORE_CHUNK = './three.core.min.js';

/** Where npm put three. Its exports map hides package.json, so resolve the main entry
 *  (build/three.cjs) and step up out of build/. */
export function threeDir(): string {
  return path.resolve(path.dirname(createRequire(import.meta.url).resolve('three')), '..');
}

/** `export{a as Name,b}` at the end of a module becomes `return{Name:a,b:b}`. */
function exportToReturn(src: string): string {
  return src.replace(/export\s*\{([^}]*)\};?\s*$/, (_, list: string) =>
    `return{${list.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [local, exported] = p.split(/\s+as\s+/);
      return `${exported ?? local}:${local}`;
    }).join(',')}};`);
}

/** `import{Name as a,b}from"<from>"` becomes `const{Name:a,b}=<obj>;`. */
function importToConst(src: string, from: string, obj: string): string {
  const quoted = from.replace(/[./]/g, '\\$&');
  return src.replace(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${quoted}['"];?`), (_, list: string) =>
    `const{${list.split(',').map((p) => {
      const [imported, local] = p.trim().split(/\s+as\s+/);
      return local ? `${imported}:${local}` : imported;
    }).filter(Boolean).join(',')}}=${obj};`);
}

/** `export{a,b}from"<from>"` re-exports vanish: the merged THREE object carries those names already. */
function dropReexports(src: string, from: string): string {
  const quoted = from.replace(/[./]/g, '\\$&');
  return src.replace(new RegExp(`export\\s*\\{[^}]*\\}\\s*from\\s*['"]${quoted}['"];?`, 'g'), '');
}

/**
 * Three.js as one classic script defining `THREE` and `OrbitControls`. The npm package ships only
 * ES modules, which an inline <script> cannot import, so each file is wrapped in a function that
 * returns its exports and every import becomes destructuring from the previous one.
 * ponytail: four regular expressions against a pinned input, held by the bundleThree test. If an
 * upgrade changes the file shape, wrap build/three.cjs (2.1 MB, no require calls) whole instead.
 */
export function bundleThree(dir: string): string {
  const src = (f: string): string => readFileSync(path.join(dir, f), 'utf8');
  const version = JSON.parse(src('package.json')).version as string;
  const core = exportToReturn(src(THREE_FILES.core));
  const mainSrc = dropReexports(importToConst(src(THREE_FILES.main), CORE_CHUNK, 'THREE_CORE'), CORE_CHUNK);
  const main = exportToReturn(mainSrc);
  const orbit = importToConst(src(THREE_FILES.orbit), 'three', 'THREE')
    .replace(/export\s*\{\s*OrbitControls\s*\};?/, 'return OrbitControls;');
  return `/* three:start Three.js ${version} MIT https://threejs.org */\n`
    + `const THREE_CORE=(()=>{${core}})();\n`
    + `const THREE_MAIN=(()=>{${main}})();\n`
    + 'const THREE={...THREE_CORE,...THREE_MAIN};\n'
    + `const OrbitControls=(()=>{${orbit}})();\n`
    + '/* three:end */\n';
}
```

- [ ] **Step 4: Run the test**

Run: `npm test 2>&1 | grep -E "bundleThree|✔ rewrites|pass [0-9]|fail [0-9]"`
Expected: `✔ rewrites the pinned Three.js modules into one classic script that runs`, `pass 146`, `fail 0`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit (ask first)**

```bash
git add scripts/archlens.ts test/archlens.test.ts
git commit -m "feat(db-review): bundle the pinned Three.js modules into one classic script"
```

---

### Task 4: `schema3dModel()`, `dependencyDepths()`, `hubTables()`

**Files:**
- Modify: `skills/archlens-postgres/scripts/archlens.ts` (same new section, after `bundleThree`)
- Test: `skills/archlens-postgres/test/archlens.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `dependencyDepths, hubTables, schema3dModel` and `type Schema3dModel` to the import from `'../scripts/archlens.ts'`. Append:

```ts
describe('schema3dModel', () => {
  let tables: Map<string, Table>;
  let model: Schema3dModel;
  before(async () => {
    ({ tables } = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql'));
    const narratives = json('examples/narratives.json');
    const findings = new Reviewer(tables, narratives).run();
    model = schema3dModel(tables, narratives, findings, 'examples/sample-schema.sql');
  });

  it('has one entry per table and per foreign key', () => {
    assert.equal(model.tables.length, tables.size);
    assert.equal(model.fks.length, [...tables.values()].reduce((n, t) => n + t.fks.length, 0));
    assert.equal(model.title, 'Portal database');
    assert.equal(model.source, 'examples/sample-schema.sql');
  });

  it('carries every field the panel reads on every foreign key', () => {
    const fields = ['child', 'columns', 'parent', 'ref_columns', 'name', 'cardinality', 'nullable', 'unique',
      'indexed', 'on_delete', 'why', 'words', 'findings'];
    for (const fk of model.fks) {
      for (const k of fields) assert.ok(k in fk, `${k} missing on ${fk.child}.${fk.columns.join(',')}`);
      assert.match(fk.words, /^one .* · (required|optional) · ON DELETE /);
    }
  });

  it('attaches fk-index findings to their key and primary-key findings to their table', () => {
    const keyed = model.fks.flatMap((fk) => fk.findings.map((f) => f.check));
    const tabled = model.tables.flatMap((t) => t.findings.map((f) => f.check));
    assert.ok(keyed.includes('fk-index'));
    assert.ok(!tabled.includes('fk-index'));
    assert.ok(tabled.includes('primary-key'));
    assert.ok(!keyed.includes('primary-key'));
    const sessions = model.fks.find((fk) => fk.child === 'sessions' && fk.columns.join() === 'user_id')!;
    assert.deepEqual(sessions.findings.map((f) => f.check), ['fk-index']);
  });

  it('names tenant as the only hub of the sample (10 of 18 other tables)', () => {
    assert.deepEqual(model.hubs, ['tenant']);
    assert.deepEqual(hubTables(tables), ['tenant']);
  });

  it('gives every table a domain that exists in the domain list, with a colour', () => {
    const keys = new Map(model.domains.map((d) => [d.key, d]));
    for (const t of model.tables) assert.ok(keys.has(t.domain), `${t.name} → ${t.domain}`);
    for (const d of model.domains) assert.match(d.color, /^#[0-9a-f]{6}$/);
    assert.deepEqual(model.domains.map((d) => d.key), ['tenant', 'auth', 'permission', 'github', 'approvals', 'billing', 'unclaimed']);
  });

  it('puts the table no domain claims (legacy_import_staging) into an unclaimed domain, listed last', () => {
    assert.equal(model.tables.find((t) => t.name === 'legacy_import_staging')!.domain, 'unclaimed');
    assert.equal(model.domains.at(-1)!.title, 'Unclaimed');
    assert.equal(model.domains.at(-1)!.color, '#7f8a99');
  });

  it('without narratives, groups tables by dependency depth', async () => {
    const { tables: bare } = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    const m = schema3dModel(bare, {}, [], 'examples/sample-schema.sql');
    assert.ok(m.domains.length > 1);
    assert.ok(m.domains.every((d) => /^depth-\d+$/.test(d.key)));
    assert.equal(m.tables.find((t) => t.name === 'provider')!.domain, 'depth-0');
    assert.equal(m.tables.find((t) => t.name === 'tenant')!.domain, 'depth-1');
    assert.equal(m.title, 'Database');
    const depth = dependencyDepths(bare);
    assert.equal(depth.get('provider'), 0);
    assert.equal(depth.get('tenant'), 1);
  });

  it('names org as the hub of the edge-case fixture (6 of 9 other tables) and cuts its site/region cycle', async () => {
    const { tables: edge } = await parseSchema(read('test/fixtures/edge-cases.sql'), 'test/fixtures/edge-cases.sql');
    assert.deepEqual(hubTables(edge), ['org']);
    // site and region reference each other; without the cut, dependencyDepths would never return.
    const depth = dependencyDepths(edge);
    assert.equal(depth.get('site'), 1);
    assert.equal(depth.get('region'), 2);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test 2>&1 | grep -E "schema3dModel|fail [0-9]"`
Expected: load failure on the missing export, or `fail 8`.

- [ ] **Step 3: Implement**

Append to the "3D explorer" section of `archlens.ts`, after `bundleThree`:

```ts
export interface Schema3dFinding { id: string; severity: Severity; title: string; check: string }
export interface Schema3dColumn { name: string; type: string; pk: boolean; fk: boolean; not_null: boolean }
export interface Schema3dTable {
  name: string;
  domain: string;
  description: string;
  source_line: number;
  columns: Schema3dColumn[];
  findings: Schema3dFinding[];
}
export interface Schema3dFk {
  child: string;
  columns: string[];
  parent: string;
  ref_columns: string[];
  name: string | null;
  cardinality: string;
  nullable: boolean;
  unique: boolean;
  indexed: boolean;
  on_delete: string;
  why: string | null;
  words: string;
  findings: Schema3dFinding[];
}
export interface Schema3dDomain { key: string; title: string; blurb: string; color: string }
export interface Schema3dModel {
  title: string;
  source: string;
  domains: Schema3dDomain[];
  tables: Schema3dTable[];
  fks: Schema3dFk[];
  hubs: string[];
}

// Twelve colours by domain position, cycling past twelve; grey for tables no domain claims.
const PALETTE = ['#f5c542', '#4f8cff', '#38c7d6', '#3ecf8e', '#ff7a59', '#c27cff',
  '#ff5e8a', '#a3d139', '#f08a24', '#e06bd1', '#8fa3bf', '#5ad1b0'];
const UNCLAIMED_COLOR = '#7f8a99';
/** Checks whose finding is about one foreign key rather than the table as a whole. */
const KEY_CHECKS = new Set(['fk-index', 'fk-nullable', 'fk-on-delete', 'cardinality', 'undocumented-relationship']);

/** Longest parent chain above each table, memoized; a cycle is cut where it closes (svgErd() layers the same way). */
export function dependencyDepths(tables: Map<string, Table>): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (n: string): number => {
    if (depth.has(n)) return depth.get(n)!;
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const parents = tables.get(n)!.fks.map((fk) => fk.ref_table).filter((p) => p !== n && tables.has(p));
    const d = parents.reduce((m, p) => Math.max(m, depthOf(p) + 1), 0);
    visiting.delete(n);
    depth.set(n, d);
    return d;
  };
  for (const n of tables.keys()) depthOf(n);
  return depth;
}

/** Tables whose inbound foreign keys number at least a third of the other tables, and at least four; most-referenced first. */
export function hubTables(tables: Map<string, Table>): string[] {
  const min = Math.max(4, Math.ceil((tables.size - 1) / 3));
  const inbound = (n: string): number => tables.get(n)!.referenced_by.length;
  return [...tables.keys()].filter((n) => inbound(n) >= min)
    .sort((a, b) => inbound(b) - inbound(a) || (a < b ? -1 : 1));
}

/** Everything schema-3d.html needs, from the same objects the other writers use. */
export function schema3dModel(tables: Map<string, Table>, narratives: Narratives, findings: Finding[], source: string): Schema3dModel {
  const fmap = new Map(findings.map((f) => [f.id, f]));
  const brief = (f: Finding): Schema3dFinding => ({ id: f.id, severity: f.severity, title: f.title, check: f.check });
  const declared = (narratives.domains ?? []) as Narratives[];
  const domains: Schema3dDomain[] = declared.map((d, i) => ({
    key: d.key as string, title: (d.title ?? d.key) as string, blurb: (d.blurb ?? '') as string, color: PALETTE[i % PALETTE.length],
  }));
  const domainOf = new Map<string, string>();
  if (declared.length) {
    for (const t of tables.values()) domainOf.set(t.name, t.domain ?? 'unclaimed');
    if ([...tables.values()].some((t) => t.domain === null)) {
      domains.push({ key: 'unclaimed', title: 'Unclaimed', blurb: 'Present in the schema, absent from every domain.', color: UNCLAIMED_COLOR });
    }
  } else {
    const depth = dependencyDepths(tables);
    const deepest = Math.max(0, ...depth.values());
    for (let d = 0; d <= deepest; d += 1) {
      domains.push({
        key: `depth-${d}`,
        title: d === 0 ? 'Depth 0: tables that depend on nothing' : `Depth ${d}: ${d} step${d === 1 ? '' : 's'} below a root`,
        blurb: '', color: PALETTE[d % PALETTE.length],
      });
    }
    for (const t of tables.values()) domainOf.set(t.name, `depth-${depth.get(t.name)}`);
  }

  const out: Schema3dTable[] = [];
  const fks: Schema3dFk[] = [];
  for (const t of tables.values()) {
    const mine = t.findings.flatMap((id) => { const f = fmap.get(id); return f ? [f] : []; });
    const taken = new Set<Finding>();
    const rels = relationships(t, narratives);
    t.fks.forEach((fk, i) => {
      const onKey = mine.filter((f) => KEY_CHECKS.has(f.check) && f.columns.length > 0 && sameSet(f.columns, fk.columns));
      onKey.forEach((f) => taken.add(f));
      fks.push({
        child: t.name, columns: fk.columns, parent: fk.ref_table, ref_columns: fk.ref_columns, name: fk.name,
        cardinality: fk.cardinality, nullable: fk.nullable, unique: fk.unique, indexed: fk.indexed, on_delete: fk.on_delete,
        why: rels[i].why, words: describeRelationship(rels[i]), findings: onKey.map(brief),
      });
    });
    out.push({
      name: t.name, domain: domainOf.get(t.name)!, description: t.description.join(' '), source_line: t.source_line,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.is_pk, fk: c.is_fk, not_null: c.not_null })),
      findings: mine.filter((f) => !taken.has(f)).map(brief),
    });
  }
  return {
    title: ((narratives.database ?? {}).title ?? 'Database') as string,
    source, domains, tables: out, fks, hubs: hubTables(tables),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "schema3dModel|pass [0-9]|fail [0-9]"`
Expected: `pass 154`, `fail 0`. If the unclaimed test fails because the Reviewer assigns `t.domain` differently from what the test assumes, read `chkDomainCoverage` in `archlens.ts` (search for `'domain-coverage'`) and adjust the test's expectation, not the model.

- [ ] **Step 5: Typecheck, then commit (ask first)**

Run: `npm run typecheck` → exit 0.

```bash
git add scripts/archlens.ts test/archlens.test.ts
git commit -m "feat(db-review): build the 3D explorer model from tables, findings and narratives"
```

---

### Task 5: The layout module

**Files:**
- Create: `skills/archlens-postgres/scripts/schema-3d-layout.js`
- Test: `skills/archlens-postgres/test/archlens.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the test file's imports:

```ts
import { CARD, ISLAND_GAP, depths, layout } from '../scripts/schema-3d-layout.js';
```

Append:

```ts
describe('schema-3d layout', () => {
  let model: Schema3dModel;
  let bare: Schema3dModel;
  before(async () => {
    const { tables } = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    const narratives = json('examples/narratives.json');
    model = schema3dModel(tables, narratives, new Reviewer(tables, narratives).run(), 'x.sql');
    const { tables: t2 } = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    bare = schema3dModel(t2, {}, [], 'x.sql');
  });
  type Island = ReturnType<typeof layout>['islands'][number];
  const overlap = (a: Island, b: Island): boolean =>
    Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + ISLAND_GAP && Math.abs(a.cz - b.cz) < (a.d + b.d) / 2 + ISLAND_GAP;

  it("puts the hub's domain at the origin and the rest on a ring", () => {
    const L = layout(model);
    const centre = L.islands.find((i) => i.cx === 0 && i.cz === 0)!;
    assert.equal(centre.key, 'tenant');
    assert.ok(L.radius > 0);
    for (const i of L.islands) if (i !== centre) assert.ok(Math.abs(Math.hypot(i.cx, i.cz) - L.radius) < 1e-6, i.key);
  });

  it('sorts parents before children inside an island, then by name', () => {
    const L = layout(model);
    const depth = depths(model);
    for (const i of L.islands) {
      for (let k = 1; k < i.tables.length; k += 1) {
        const a = i.tables[k - 1], b = i.tables[k];
        assert.ok(depth.get(a)! < depth.get(b)! || (depth.get(a) === depth.get(b) && a < b), `${i.key}: ${a} before ${b}`);
      }
    }
  });

  it('never lets two islands overlap, on the sample and on a crowded synthetic schema', () => {
    const check = (m: Schema3dModel): void => {
      const L = layout(m);
      for (const a of L.islands) for (const b of L.islands) if (a !== b) assert.ok(!overlap(a, b), `${a.key} overlaps ${b.key}`);
    };
    check(model);
    const sizes = [3, 20, 7, 14, 1, 30, 9, 12, 5, 25, 2, 18];
    const domains = sizes.map((_, i) => ({ key: `d${i}`, title: `D${i}`, blurb: '', color: '#000000' }));
    const tables = sizes.flatMap((n, i) => Array.from({ length: n }, (_, k) => ({
      name: `d${i}_t${k}`, domain: `d${i}`, description: '', source_line: 1, columns: [], findings: [],
    })));
    const fks = tables.filter((t) => t.name !== 'd0_t0').map((t) => ({
      child: t.name, columns: ['d0_t0_id'], parent: 'd0_t0', ref_columns: ['id'], name: null, cardinality: '1:N',
      nullable: false, unique: false, indexed: true, on_delete: 'NO ACTION', why: null, words: 'w', findings: [],
    }));
    check({ title: 'x', source: 'x', domains, tables, fks, hubs: ['d0_t0'] });
  });

  it('places cards on a grid spaced for the column card, and gives the same answer twice', () => {
    const L = layout(model);
    assert.equal(JSON.stringify(L), JSON.stringify(layout(model)));
    const names = Object.keys(L.pos);
    assert.equal(names.length, model.tables.length);
    for (const a of names) for (const b of names) {
      if (a < b) {
        const dx = Math.abs(L.pos[a].x - L.pos[b].x), dz = Math.abs(L.pos[a].z - L.pos[b].z);
        assert.ok(dx >= CARD.stepX - 1e-6 || dz >= CARD.stepZ - 1e-6, `${a} and ${b} too close`);
      }
    }
  });

  it('makes one arc per foreign key whose ends both exist, low inside an island and lifted across', () => {
    const L = layout(model);
    assert.equal(L.arcs.length, model.fks.length);
    for (const a of L.arcs) {
      const fk = model.fks[a.i];
      const inner = model.tables.find((t) => t.name === fk.child)!.domain === model.tables.find((t) => t.name === fk.parent)!.domain;
      if (fk.child === fk.parent) assert.equal(a.kind, 'self');
      else assert.equal(a.kind, inner ? 'inner' : 'cross');
      if (a.kind === 'cross') assert.ok(a.lift > 3);
      if (a.kind === 'inner') assert.equal(a.lift, 1.2);
    }
  });

  it('with no narratives lays out one island per dependency depth', () => {
    const L = layout(bare);
    assert.ok(L.islands.length > 1);
    assert.ok(L.islands.every((i) => i.key.startsWith('depth-')));
    assert.equal(L.islands.find((i) => i.cx === 0 && i.cz === 0)!.key, 'depth-1', 'tenant, the hub, sits at depth 1');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test 2>&1 | grep -E "Cannot find module|schema-3d layout|fail [0-9]"`
Expected: `Cannot find module '.../scripts/schema-3d-layout.js'`.

- [ ] **Step 3: Create the module**

`skills/archlens-postgres/scripts/schema-3d-layout.js`:

```js
// schema-3d-layout.js — where every island, card and arc of schema-3d.html goes.
//
// Pure functions over the model the page embeds (window.SCHEMA3D), so the same file runs under
// node --test and in the browser. No Three.js here. The writer strips the `export` keywords when
// it inlines this file as a classic script.

/** Card size and grid spacing in scene units; the spacing fits the 3.4-unit column card. */
export const CARD = { w: 1.8, d: 1.1, h: 0.16, stepX: 3.6, stepZ: 2.4, pad: 1.6 };
/** Minimum clear space between two islands. */
export const ISLAND_GAP = 4;

/** Longest parent chain above each table; a cycle is cut where it closes. */
export function depths(model) {
  const parentsOf = new Map(model.tables.map((t) => [t.name, []]));
  for (const fk of model.fks) {
    if (parentsOf.has(fk.child) && parentsOf.has(fk.parent) && fk.child !== fk.parent) parentsOf.get(fk.child).push(fk.parent);
  }
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (n) => {
    if (depth.has(n)) return depth.get(n);
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const d = parentsOf.get(n).reduce((m, p) => Math.max(m, depthOf(p) + 1), 0);
    visiting.delete(n);
    depth.set(n, d);
    return d;
  };
  for (const t of model.tables) depthOf(t.name);
  return depth;
}

/**
 * Islands on a ring around the hub's domain, cards on a grid inside each island, one arc per
 * foreign key. Returns { islands, pos, arcs, radius }:
 *   islands[]  { key, title, color, tables[], cols, rows, w, d, cx, cz }
 *   pos        { [table]: { x, z } }
 *   arcs[]     { i (index into model.fks), kind: 'self' | 'inner' | 'cross', lift }
 */
export function layout(model) {
  const depth = depths(model);
  const byDomain = new Map(model.domains.map((d) => [d.key, []]));
  for (const t of model.tables) byDomain.get(t.domain).push(t.name);
  const hubTable = model.hubs.length ? model.tables.find((t) => t.name === model.hubs[0]) : null;
  const hubDomain = hubTable ? hubTable.domain : model.domains[0]?.key;

  const islands = model.domains.filter((d) => byDomain.get(d.key).length).map((d) => {
    const tables = byDomain.get(d.key).sort((a, b) => depth.get(a) - depth.get(b) || (a < b ? -1 : 1));
    const cols = Math.ceil(Math.sqrt(tables.length));
    const rows = Math.ceil(tables.length / cols);
    return { key: d.key, title: d.title, color: d.color, tables, cols, rows,
      w: cols * CARD.stepX + CARD.pad, d: rows * CARD.stepZ + CARD.pad, cx: 0, cz: 0 };
  });

  const centre = islands.find((i) => i.key === hubDomain) ?? islands[0];
  const ring = islands.filter((i) => i !== centre);
  const footprint = (i) => Math.max(i.w, i.d);
  const overlap = (a, b) => Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + ISLAND_GAP && Math.abs(a.cz - b.cz) < (a.d + b.d) / 2 + ISLAND_GAP;
  let radius = 0;
  if (ring.length) {
    const around = ring.reduce((s, i) => s + footprint(i) + ISLAND_GAP, 0) / (2 * Math.PI);
    const clear = (footprint(centre) + Math.max(...ring.map(footprint))) / 2 + ISLAND_GAP;
    radius = Math.max(around, clear);
    const place = () => ring.forEach((i, k) => {
      const a = (k / ring.length) * Math.PI * 2;
      i.cx = Math.cos(a) * radius;
      i.cz = Math.sin(a) * radius;
    });
    place();
    // Axis-aligned boxes on a circle can still touch near the top and bottom; widen until none do.
    for (let tries = 0; tries < 40 && islands.some((a) => islands.some((b) => a !== b && overlap(a, b))); tries += 1) {
      radius *= 1.1;
      place();
    }
  }

  const pos = {};
  for (const i of islands) {
    i.tables.forEach((n, k) => {
      pos[n] = {
        x: i.cx + ((k % i.cols) - (i.cols - 1) / 2) * CARD.stepX,
        z: i.cz + (Math.floor(k / i.cols) - (i.rows - 1) / 2) * CARD.stepZ,
      };
    });
  }

  const domainOf = new Map(model.tables.map((t) => [t.name, t.domain]));
  const arcs = [];
  model.fks.forEach((fk, i) => {
    if (!pos[fk.child] || !pos[fk.parent]) return;
    if (fk.child === fk.parent) { arcs.push({ i, kind: 'self', lift: 2.2 }); return; }
    const inner = domainOf.get(fk.child) === domainOf.get(fk.parent);
    const dist = Math.hypot(pos[fk.child].x - pos[fk.parent].x, pos[fk.child].z - pos[fk.parent].z);
    arcs.push({ i, kind: inner ? 'inner' : 'cross', lift: inner ? 1.2 : 3 + 0.16 * dist });
  });
  return { islands, pos, arcs, radius };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "schema-3d layout|✔|✖|pass [0-9]|fail [0-9]" | tail -12`
Expected: six new passes, `pass 160`, `fail 0`.

The test file imports a `.js` module and `tsconfig.json` has no `allowJs`, so `npm run typecheck` reports `Could not find a declaration file for module '../scripts/schema-3d-layout.js'` until a declaration exists. Create `scripts/schema-3d-layout.d.ts`:

```ts
export interface Island { key: string; title: string; color: string; tables: string[]; cols: number; rows: number; w: number; d: number; cx: number; cz: number }
export interface Arc { i: number; kind: 'self' | 'inner' | 'cross'; lift: number }
export interface Layout { islands: Island[]; pos: Record<string, { x: number; z: number }>; arcs: Arc[]; radius: number }
export const CARD: { w: number; d: number; h: number; stepX: number; stepZ: number; pad: number };
export const ISLAND_GAP: number;
export function depths(model: { tables: { name: string }[]; fks: { child: string; parent: string }[] }): Map<string, number>;
export function layout(model: { domains: { key: string; title: string; color: string }[]; tables: { name: string; domain: string }[]; fks: { child: string; parent: string }[]; hubs: string[] }): Layout;
```

- [ ] **Step 5: Typecheck, then commit (ask first)**

Run: `npm run typecheck` → exit 0.

```bash
git add scripts/schema-3d-layout.js scripts/schema-3d-layout.d.ts test/archlens.test.ts
git commit -m "feat(db-review): lay out domain islands, cards and arcs for the 3D explorer"
```

---

### Task 6: The page: CSS, app, `writeSchema3d()`, wired into `main()`

**Files:**
- Create: `skills/archlens-postgres/scripts/schema-3d.css`
- Create: `skills/archlens-postgres/scripts/schema-3d-app.js`
- Modify: `skills/archlens-postgres/scripts/archlens.ts` (writer in the "3D explorer" section; `main()`; the header comment's output list)
- Test: `skills/archlens-postgres/test/archlens.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `writeSchema3d` to the import from `'../scripts/archlens.ts'`. Append:

```ts
describe('schema-3d.html', () => {
  const ddl = `
    -- The organisation. </script><b>not html</b>
    CREATE TABLE org (id BIGINT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE widget (id UUID PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES org(id) ON DELETE CASCADE);
    CREATE TABLE note (id UUID PRIMARY KEY, widget_id UUID REFERENCES widget(id), parent_id UUID REFERENCES note(id));`;
  const narratives = {
    database: { title: 'Informer', blurb: 'b' },
    domains: [
      { key: 'core', title: 'Core', blurb: 'c', tenant_scoped: false, tables: ['org'] },
      { key: 'work', title: 'Work', blurb: 'w', tenant_scoped: false, tables: ['widget', 'note'] },
    ],
    assertions: { cardinality: [{ parent: 'org', child: 'widget', expect: '1:N', why: 'a widget is built by one organisation' }] },
  };
  let out = '';
  let html = '';
  before(async () => {
    const { tables } = await parseSchema(ddl, 'inline');
    const findings = new Reviewer(tables, narratives).run();
    out = mkdtempSync(path.join(tmpdir(), 'db-review-3d-'));
    writeSchema3d(out, schema3dModel(tables, narratives, findings, 'inline'));
    html = readFileSync(path.join(out, 'schema-3d.html'), 'utf8');
  });
  after(() => rmSync(out, { recursive: true, force: true }));

  it('is one self-contained page: model, Three.js, layout and app inline, nothing from the web', () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Informer — 3D schema explorer<\/title>/);
    assert.match(html, /<script>window\.SCHEMA3D=\{"title":"Informer"/);
    assert.match(html, /\/\* three:start Three\.js 0\.185\.1/);
    assert.match(html, /\/\* three:end \*\//);
    assert.match(html, /\nfunction layout\(model\)/);
    assert.match(html, /\nconst CARD = /);
    assert.doesNotMatch(html, /^export /m);
    assert.doesNotMatch(html, /(src|href)="http/);
    assert.doesNotMatch(html, /importmap/);
    assert.match(html, /Generated from <code>inline<\/code> on \d{4}-\d{2}-\d{2}/);
  });

  it('escapes the model so a table comment cannot close the script', () => {
    assert.ok(!html.includes('</script><b>'), 'raw </script> from a comment leaked into the page');
    assert.match(html, /\\u003c\/script>\\u003cb>/);
  });

  it('carries the why, the words and the self-reference', () => {
    assert.match(html, /"why":"a widget is built by one organisation"/);
    assert.match(html, /"words":"one org, many widget · required · ON DELETE CASCADE · not indexed"/);
    assert.match(html, /"child":"note","columns":\["parent_id"\],"parent":"note"/);
  });

  it('has the controls the app looks up by id, each with a name', () => {
    for (const id of ['scene', 'q', 'hubseg', 'hubinfo', 'reset', 'chips', 'tip', 'panel', 'live', 'nowebgl']) {
      assert.match(html, new RegExp(` id="${id}"`), `#${id} missing`);
    }
    assert.match(html, /<label class="sr" for="q">/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /aria-label="Domains"/);
  });

  it('is deterministic apart from the date line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-review-3d-again-'));
    try {
      writeSchema3d(dir, JSON.parse(html.match(/window\.SCHEMA3D=(\{.*?\});<\/script>/)![1].replace(/\\u003c/g, '<')));
      assert.equal(stable(readFileSync(path.join(dir, 'schema-3d.html'), 'utf8')), stable(html));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test 2>&1 | grep -E "schema-3d\.html|writeSchema3d|fail [0-9]"`
Expected: load failure on the missing export `writeSchema3d`.

- [ ] **Step 3: Create the stylesheet**

`skills/archlens-postgres/scripts/schema-3d.css`:

```css
/* schema-3d.css — the explorer is one dark scene, so no light theme. */
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: #0e1116; color: #dfe5ee; font: 14px system-ui, sans-serif; }
#scene { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; }
#scene canvas { display: block; width: 100%; height: 100%; }
footer { flex: 0 0 auto; padding: 5px 12px; font-size: 11px; color: #7f8a99; border-top: 1px solid #1f2530; }
footer a, .panel a { color: #8fb8ea; text-decoration: none; }
footer a:hover, .panel a:hover { text-decoration: underline; }
code { font: 12px ui-monospace, Menlo, Consolas, monospace; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.ov { position: absolute; font-size: 12px; color: #dfe5ee; }
.ov.tl { left: 12px; top: 12px; display: flex; flex-direction: column; gap: 8px; max-width: min(460px, calc(100% - 24px)); }
.ov.help { left: 12px; bottom: 10px; color: #7f8a99; font-size: 11px; pointer-events: none; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lbl { color: #9aa4b2; }
#q { background: rgba(20,24,31,.92); border: 1px solid #2b323d; color: #e8ecf2; border-radius: 6px; padding: 6px 9px; width: 260px; font: 13px system-ui, sans-serif; }
.plain { background: rgba(20,24,31,.92); border: 1px solid #2b323d; color: #c8d0da; border-radius: 6px; padding: 4px 9px; cursor: pointer; font: 12px system-ui, sans-serif; }
.seg { display: inline-flex; border: 1px solid #2b323d; border-radius: 6px; overflow: hidden; background: rgba(20,24,31,.92); }
.seg button { background: none; border: 0; color: #9aa4b2; padding: 5px 10px; cursor: pointer; font: 12px system-ui, sans-serif; }
.seg button.on { background: #2e3a4d; color: #fff; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips button { border: 1px solid #2b323d; background: rgba(20,24,31,.92); color: #c8d0da; border-radius: 12px; padding: 2px 8px; cursor: pointer; font: 11px system-ui, sans-serif; display: inline-flex; align-items: center; gap: 5px; }
.chips button i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.chips button.off { opacity: .35; }
button:focus-visible, #q:focus-visible { outline: 2px solid #8fb8ea; outline-offset: 1px; }

#tip { position: absolute; pointer-events: none; background: rgba(16,19,25,.95); border: 1px solid #2b323d; border-radius: 6px; padding: 5px 8px; font: 12px ui-monospace, Menlo, Consolas, monospace; color: #e8ecf2; display: none; white-space: nowrap; }
#nowebgl { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
#nowebgl[hidden] { display: none; }

.panel { position: absolute; right: 12px; top: 12px; bottom: 12px; width: min(340px, calc(100% - 24px)); background: rgba(16,19,25,.94); border: 1px solid #2b323d; border-radius: 10px; padding: 14px 16px; overflow: auto; font-size: 13px; display: none; }
.panel.show { display: block; }
.panel h3 { font: 700 15px ui-monospace, Menlo, Consolas, monospace; margin: 0 0 2px; padding-right: 22px; word-break: break-all; }
.panel .dom { color: #9aa4b2; font-size: 12px; margin-bottom: 10px; }
.panel h4 { font: 600 11px system-ui, sans-serif; text-transform: uppercase; letter-spacing: .05em; color: #9aa4b2; margin: 12px 0 4px; }
.panel ul { list-style: none; margin: 0; padding: 0; }
.panel li { padding: 3px 0; border-bottom: 1px solid #1f2530; font: 12px ui-monospace, Menlo, Consolas, monospace; display: flex; gap: 8px; align-items: baseline; }
.panel li .t { color: #8b95a5; margin-left: auto; text-align: right; }
.panel li .k { color: #7cb3e0; font-weight: 700; font-size: 10px; }
.panel dl { margin: 0; display: grid; grid-template-columns: 96px 1fr; gap: 4px 10px; font-size: 12px; }
.panel dt { color: #9aa4b2; }
.panel dd { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace; }
.panel .why { color: #c8d0da; font-style: italic; line-height: 1.4; margin: 2px 0; }
.panel .muted { color: #7f8a99; }
.panel .fnd li { font-family: system-ui, sans-serif; }
.sev { font-weight: 700; font-size: 11px; }
.sev.error { color: #f28b82; }
.sev.warn { color: #f2c14e; }
.sev.info { color: #8fb8ea; }
.panel .close { position: absolute; right: 10px; top: 8px; background: none; border: 0; color: #9aa4b2; font-size: 16px; cursor: pointer; }
@media (max-width: 720px) { .panel { top: auto; height: 45%; left: 12px; width: auto; } .ov.help { display: none; } }
```

- [ ] **Step 4: Create the app**

`skills/archlens-postgres/scripts/schema-3d-app.js`:

```js
// schema-3d-app.js — the explorer. Runs after THREE, OrbitControls, SCHEMA3D, CARD and layout()
// are on the page. Classic script: no imports, everything it needs is a global.
(() => {
  const M = window.SCHEMA3D;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.getElementById('scene');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- no WebGL: say so, point at the flat diagram ----------
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) { $('nowebgl').hidden = false; return; }

  // ---------- indexes over the model ----------
  const tableByName = new Map(M.tables.map((t) => [t.name, t]));
  const domainByKey = new Map(M.domains.map((d) => [d.key, d]));
  const L = layout(M);
  const inbound = new Map();
  for (const fk of M.fks) inbound.set(fk.parent, (inbound.get(fk.parent) ?? 0) + 1);
  const hubs = new Set(M.hubs);
  const colorOf = (name) => domainByKey.get(tableByName.get(name).domain).color;
  const extent = Math.max(12, ...L.islands.map((i) => Math.hypot(i.cx, i.cz) + Math.hypot(i.w, i.d) / 2));

  // ---------- scene ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0e1116');
  scene.fog = new THREE.Fog('#0e1116', extent * 2.4, extent * 5);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, extent * 8);
  const HOME = { cam: new THREE.Vector3(0, extent * 1.1 + 8, extent * 1.4 + 10), tgt: new THREE.Vector3(0, 0, 0) };
  camera.position.copy(HOME.cam);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.prepend(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !REDUCED;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 4;
  controls.maxDistance = extent * 4;
  controls.autoRotate = !REDUCED;
  controls.autoRotateSpeed = 0.4;
  scene.add(new THREE.HemisphereLight('#dfe7f5', '#1a1f2a', 1.1));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(20, 40, 15);
  scene.add(sun);
  const size = () => {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  size();
  addEventListener('resize', size);

  // ---------- text on a canvas, as a sprite that always faces the camera ----------
  function textSprite(lines, color, opts = {}) {
    const c = document.createElement('canvas');
    const lh = opts.lh ?? 40, w = 512, h = 16 + lines.length * lh + (opts.title ? 12 : 0);
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(14,17,22,0.9)'; g.fillRect(0, 0, w, h);
    g.fillStyle = color; g.fillRect(0, 0, 8, h);
    g.textBaseline = 'middle'; g.textAlign = opts.align ?? 'center';
    lines.forEach((ln, i) => {
      const title = opts.title && i === 0;
      g.font = `${title ? 700 : 500} ${title ? 34 : 28}px ui-monospace, Menlo, Consolas, monospace`;
      g.fillStyle = title ? '#ffffff' : '#c8d0da';
      g.fillText(ln, opts.align === 'left' ? 24 : w / 2 + 4, 8 + (i + 0.5) * lh + (title ? 0 : 12), w - 40);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    const sw = opts.w ?? 3.2;
    s.scale.set(sw, (sw * h) / w, 1);
    return s;
  }

  // ---------- islands and cards ----------
  const slabGeo = new THREE.BoxGeometry(CARD.w, CARD.h, CARD.d);
  const markGeo = new THREE.BoxGeometry(0.24, 0.24, 0.24);
  const nodes = new Map();   // name -> { mesh, label, detail, mark, pos, table }
  for (const isl of L.islands) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(isl.w, isl.d),
      new THREE.MeshBasicMaterial({ color: isl.color, transparent: true, opacity: 0.09, side: THREE.DoubleSide }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(isl.cx, -0.12, isl.cz);
    scene.add(plate);
    const title = textSprite([isl.title.toUpperCase()], isl.color, { w: Math.min(10, 1.6 + isl.title.length * 0.3) });
    title.position.set(isl.cx, 0.1, isl.cz - isl.d / 2 - 0.9);
    scene.add(title);
    for (const name of isl.tables) {
      const t = tableByName.get(name);
      const p = L.pos[name];
      const pos = new THREE.Vector3(p.x, 0, p.z);
      const mesh = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: isl.color, roughness: 0.55, metalness: 0.05, transparent: true }));
      mesh.position.copy(pos);
      mesh.userData.name = name;
      scene.add(mesh);
      const worst = t.findings.some((f) => f.severity === 'error') ? '#f28b82'
        : t.findings.some((f) => f.severity === 'warn') ? '#f2c14e' : null;
      let mark = null;
      if (worst) {
        mark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: worst, transparent: true }));
        mark.position.set(p.x + CARD.w / 2 - 0.12, 0.2, p.z - CARD.d / 2 + 0.12);
        scene.add(mark);
      }
      const label = textSprite([name], isl.color);
      label.position.set(p.x, 0.55, p.z);
      scene.add(label);
      const colLines = t.columns.slice(0, 8).map((c) => `${c.name} ${c.type}${c.pk ? ' PK' : c.fk ? ' FK' : ''}`);
      if (t.columns.length > 8) colLines.push(`+${t.columns.length - 8} more`);
      const detail = textSprite([name, ...colLines], isl.color, { title: true, align: 'left', lh: 34, w: 3.4 });
      detail.position.set(p.x, 0.3 + detail.scale.y / 2, p.z);
      detail.visible = false;
      scene.add(detail);
      nodes.set(name, { mesh, label, detail, mark, pos, table: t });
    }
  }

  // ---------- arcs ----------
  const Y = 0.12;
  const dotGeo = new THREE.SphereGeometry(0.13, 12, 8);
  const edges = L.arcs.map((a) => {
    const fk = M.fks[a.i];
    const c = nodes.get(fk.child).pos, p = nodes.get(fk.parent).pos;
    const self = a.kind === 'self';
    const a0 = self ? new THREE.Vector3(c.x + CARD.w / 2, Y, c.z) : new THREE.Vector3(c.x, Y, c.z);
    const a1 = self ? new THREE.Vector3(c.x - CARD.w / 2, Y, c.z) : new THREE.Vector3(p.x, Y, p.z);
    const mid = a0.clone().add(a1).multiplyScalar(0.5);
    mid.y += a.lift;
    const geo = new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(a0, mid, a1).getPoints(28));
    const color = colorOf(fk.child);
    const dashed = fk.findings.some((f) => f.check === 'fk-index');
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.5, dashSize: 0.5, gapSize: 0.3 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    line.userData.k = a.i;
    scene.add(line);
    const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    dot.position.copy(a1);
    scene.add(dot);
    return { fk, k: a.i, line, dot, color, isHub: hubs.has(fk.parent), base: a.kind === 'cross' ? 0.45 : 0.7 };
  });
  const edgeByK = new Map(edges.map((e) => [e.k, e]));
  const lineList = edges.map((e) => e.line);
  const meshList = [...nodes.values()].map((n) => n.mesh);
  $('hubinfo').textContent = M.hubs.map((h) => `${h} ←${inbound.get(h) ?? 0}`).join(' · ');

  // ---------- state ----------
  let hubMode = 'all', selected = null, selectedEdge = null, hovered = null, hoveredEdge = null, query = '';
  const domainOn = new Map(M.domains.map((d) => [d.key, true]));
  const neighbours = (name) => {
    const s = new Set([name]);
    for (const e of edges) { if (e.fk.child === name) s.add(e.fk.parent); if (e.fk.parent === name) s.add(e.fk.child); }
    return s;
  };
  const matches = (t) => !query || t.name.toLowerCase().includes(query) || t.columns.some((c) => c.name.toLowerCase().includes(query));

  function restyle() {
    const focus = selected ? neighbours(selected)
      : selectedEdge !== null ? new Set([edgeByK.get(selectedEdge).fk.child, edgeByK.get(selectedEdge).fk.parent]) : null;
    const anyOff = [...domainOn.values()].some((v) => !v);
    const weight = new Map();
    for (const [name, n] of nodes) {
      let w = 1;
      if (focus) w = focus.has(name) ? 1 : 0.08;
      else {
        if (anyOff && !domainOn.get(n.table.domain)) w = 0.08;
        if (query && !matches(n.table)) w = Math.min(w, 0.1);
      }
      weight.set(name, w);
      n.mesh.material.opacity = w; n.label.material.opacity = w; n.detail.material.opacity = w;
      if (n.mark) n.mark.material.opacity = w;
      n.mesh.material.emissive.set(name === selected ? '#ffffff' : name === hovered ? '#888888' : '#000000');
      n.mesh.material.emissiveIntensity = name === selected ? 0.35 : 0.25;
    }
    for (const e of edges) {
      let o;
      if (selectedEdge !== null) o = e.k === selectedEdge ? 1 : 0.03;
      else if (focus) o = (e.fk.child === selected || e.fk.parent === selected) ? 1 : 0.03;
      else {
        o = e.isHub ? { all: e.base, muted: 0.09, hidden: 0 }[hubMode] : e.base;
        if (Math.min(weight.get(e.fk.child), weight.get(e.fk.parent)) < 0.5) o *= 0.08;
      }
      if (e.k === hoveredEdge && o > 0.001) o = 1;
      e.line.material.opacity = o; e.line.visible = o > 0.001;
      e.dot.material.opacity = o; e.dot.visible = o > 0.001;
      e.line.material.color.set(e.k === selectedEdge || e.k === hoveredEdge ? '#ffffff' : e.color);
    }
    renderPanel();
  }

  // ---------- the panel ----------
  const SEV = { error: 'Error', warn: 'Warning', info: 'Note' };
  const li = (s) => `<li>${s}</li>`;
  const findingsHtml = (list) => (list.length
    ? `<ul class="fnd">${list.map((f) => li(`<span class="sev ${f.severity}">${SEV[f.severity]}</span> <a href="index.html#${esc(f.id)}">${esc(f.title)}</a> <span class="t">${esc(f.check)}</span>`)).join('')}</ul>`
    : '<p class="muted">none</p>');
  function renderPanel() {
    const p = $('panel');
    if (!selected && selectedEdge === null) { p.classList.remove('show'); p.innerHTML = ''; return; }
    if (selectedEdge !== null) {
      const { fk } = edgeByK.get(selectedEdge);
      const c = tableByName.get(fk.child), pt = tableByName.get(fk.parent);
      p.innerHTML = '<button class="close" aria-label="Clear selection">×</button>'
        + `<h3><a data-go="${esc(fk.child)}">${esc(fk.child)}</a>.${esc(fk.columns.join(', '))} → <a data-go="${esc(fk.parent)}">${esc(fk.parent)}</a>.${esc(fk.ref_columns.join(', '))}</h3>`
        + `<div class="dom">foreign key · ${esc(domainByKey.get(c.domain).title)}${c.domain !== pt.domain ? ` → ${esc(domainByKey.get(pt.domain).title)}` : ''}</div>`
        + `<h4>In words</h4><p class="why">${esc(fk.words)}</p>`
        + `<dl><dt>Cardinality</dt><dd>${esc(fk.cardinality)}</dd><dt>Nullable</dt><dd>${fk.nullable ? 'yes' : 'no (NOT NULL)'}</dd>`
        + `<dt>Unique</dt><dd>${fk.unique ? 'yes' : 'no'}</dd><dt>Indexed</dt><dd>${fk.indexed ? 'yes' : '<span class="sev warn">no index</span>'}</dd>`
        + `<dt>ON DELETE</dt><dd>${esc(fk.on_delete)}</dd><dt>Constraint</dt><dd>${esc(fk.name ?? 'unnamed')}</dd></dl>`
        + `<h4>Why</h4><p class="why">${fk.why ? esc(fk.why) : '<span class="muted">not documented</span>'}</p>`
        + `<h4>Findings on this key</h4>${findingsHtml(fk.findings)}`;
    } else {
      const t = tableByName.get(selected);
      const cols = t.columns.map((c) => li(`<span>${esc(c.name)}</span>${c.pk ? '<span class="k">PK</span>' : c.fk ? '<span class="k">FK</span>' : ''}<span class="t">${esc(c.type)}${c.not_null ? '' : ' · null'}</span>`)).join('');
      const outs = edges.filter((e) => e.fk.child === selected);
      const refs = outs.map((e) => li(`<a data-edge="${e.k}">${esc(e.fk.columns.join(', '))} → ${esc(e.fk.parent)}</a><span class="t">${esc(e.fk.cardinality)}</span>`)).join('') || li('<span class="muted">none</span>');
      const by = edges.filter((e) => e.fk.parent === selected).map((e) => li(`<a data-edge="${e.k}">${esc(e.fk.child)}.${esc(e.fk.columns.join(', '))}</a><span class="t">${esc(e.fk.cardinality)}</span>`)).join('') || li('<span class="muted">nothing</span>');
      p.innerHTML = `<button class="close" aria-label="Clear selection">×</button><h3>${esc(t.name)}</h3>`
        + `<div class="dom">${esc(domainByKey.get(t.domain).title)} · ${t.columns.length} columns · ${outs.length} out · ${inbound.get(selected) ?? 0} in · <a href="index.html#t-${esc(t.name)}">docs</a></div>`
        + (t.description ? `<p class="why">${esc(t.description)}</p>` : '')
        + `<h4>Columns</h4><ul>${cols}</ul><h4>References</h4><ul>${refs}</ul><h4>Referenced by</h4><ul>${by}</ul><h4>Findings</h4>${findingsHtml(t.findings)}`;
    }
    p.classList.add('show');
    p.querySelector('.close').onclick = () => { clear(); goHome(); };
    p.querySelectorAll('[data-go]').forEach((a) => { a.onclick = () => { selectTable(a.dataset.go); flyTo(nodes.get(a.dataset.go).pos); }; });
    p.querySelectorAll('[data-edge]').forEach((a) => { a.onclick = () => selectEdge(+a.dataset.edge); });
  }

  // ---------- selection, deep links, announcements ----------
  const announce = (s) => { $('live').textContent = s; };
  const setHash = (h) => history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  function selectTable(name) {
    if (!nodes.has(name)) return;
    selected = name; selectedEdge = null; restyle();
    setHash(`t=${encodeURIComponent(name)}`);
    announce(`${name} selected, ${edges.filter((e) => e.fk.child === name).length} foreign keys out, referenced by ${inbound.get(name) ?? 0}`);
  }
  function selectEdge(k) {
    if (!edgeByK.has(k)) return;
    selectedEdge = k; selected = null; restyle();
    const { fk } = edgeByK.get(k);
    setHash(`fk=${encodeURIComponent(fk.child)}.${encodeURIComponent(fk.columns.join(','))}`);
    announce(`Relationship ${fk.child}.${fk.columns.join(', ')} to ${fk.parent} selected. ${fk.words}`);
  }
  function clear() { selected = null; selectedEdge = null; restyle(); setHash(''); announce('Selection cleared'); }
  function openHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    const t = h.match(/^t=(.+)$/);
    if (t && nodes.has(t[1])) { selectTable(t[1]); flyTo(nodes.get(t[1]).pos); return true; }
    const f = h.match(/^fk=([^.]+)\.(.+)$/);
    const e = f && edges.find((x) => x.fk.child === f[1] && x.fk.columns.join(',') === f[2]);
    if (e) { selectEdge(e.k); flyToEdge(e); return true; }
    return false;
  }

  // ---------- camera flights: time-based, eased, exact end pose ----------
  let flight = null;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  function fly(c1, t1, ms) {
    controls.autoRotate = false;
    if (REDUCED || ms === 0) { camera.position.copy(c1); controls.target.copy(t1); flight = null; return; }
    flight = { t0: performance.now(), ms, c0: camera.position.clone(), tv0: controls.target.clone(), c1: c1.clone(), t1: t1.clone() };
  }
  function flyTo(target, dist = 14) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    fly(target.clone().addScaledVector(dir, dist), target, 800);
  }
  function flyToEdge(e) {
    const a = nodes.get(e.fk.child).pos, b = nodes.get(e.fk.parent).pos;
    flyTo(a.clone().add(b).multiplyScalar(0.5), a.distanceTo(b) + 10);
  }
  const goHome = () => fly(HOME.cam, HOME.tgt, 900);

  // ---------- picking: cards first, then lines with a tolerance so thin lines are hittable ----------
  const ray = new THREE.Raycaster();
  ray.params.Line.threshold = 0.4;
  const ptr = new THREE.Vector2();
  const tip = $('tip');
  let down = null;
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const m = ray.intersectObjects(meshList)[0];
    if (m) return { table: m.object.userData.name };
    const l = ray.intersectObjects(lineList.filter((x) => x.visible && x.material.opacity > 0.02))[0];
    return l ? { edge: l.object.userData.k } : null;
  }
  renderer.domElement.addEventListener('pointermove', (ev) => {
    const h = pick(ev);
    const ht = h?.table ?? null, he = h?.edge ?? null;
    if (ht !== hovered || he !== hoveredEdge) {
      hovered = ht; hoveredEdge = he;
      renderer.domElement.style.cursor = h ? 'pointer' : '';
      restyle();
    }
    if (he !== null) {
      const { fk } = edgeByK.get(he);
      const r = el.getBoundingClientRect();
      tip.textContent = `${fk.child}.${fk.columns.join(', ')} → ${fk.parent}.${fk.ref_columns.join(', ')} · ${fk.cardinality}${fk.nullable ? ' · nullable' : ''}`;
      tip.style.display = 'block';
      tip.style.left = `${ev.clientX - r.left + 14}px`;
      tip.style.top = `${ev.clientY - r.top + 14}px`;
    } else if (ht !== null) {
      const r = el.getBoundingClientRect();
      tip.textContent = ht;
      tip.style.display = 'block';
      tip.style.left = `${ev.clientX - r.left + 14}px`;
      tip.style.top = `${ev.clientY - r.top + 14}px`;
    } else tip.style.display = 'none';
  });
  renderer.domElement.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  renderer.domElement.addEventListener('pointerdown', (ev) => { down = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    const moved = !down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5;
    down = null;
    if (moved || ev.button !== 0) return;
    const h = pick(ev);
    if (h?.table !== undefined) selectTable(h.table);
    else if (h?.edge !== undefined) selectEdge(h.edge);
    else clear();
  });
  renderer.domElement.addEventListener('dblclick', (ev) => {
    const h = pick(ev);
    if (h?.table !== undefined) flyTo(nodes.get(h.table).pos);
    else if (h?.edge !== undefined) flyToEdge(edgeByK.get(h.edge));
  });
  for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, () => { controls.autoRotate = false; }, { once: true, passive: true });

  // ---------- controls ----------
  const q = $('q');
  q.addEventListener('input', () => { query = q.value.trim().toLowerCase(); restyle(); });
  q.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const first = M.tables.find((t) => matches(t));
    if (first) { selectTable(first.name); flyTo(nodes.get(first.name).pos); }
  });
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { clear(); goHome(); q.blur(); }
    if (ev.key === '/' && document.activeElement !== q) { ev.preventDefault(); q.focus(); }
  });
  $('reset').onclick = () => { clear(); goHome(); };
  document.querySelectorAll('#hubseg button').forEach((b) => {
    b.onclick = () => {
      hubMode = b.dataset.m;
      document.querySelectorAll('#hubseg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      restyle();
    };
  });
  const chips = $('chips');
  const chipButtons = [];
  for (const d of M.domains) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'true');
    b.innerHTML = `<i style="background:${d.color}"></i>${esc(d.title)}`;
    b.onclick = () => {
      if ([...domainOn.values()].every(Boolean)) for (const k of domainOn.keys()) domainOn.set(k, k === d.key);
      else {
        domainOn.set(d.key, !domainOn.get(d.key));
        if ([...domainOn.values()].every((v) => !v)) for (const k of domainOn.keys()) domainOn.set(k, true);
      }
      chipButtons.forEach(([key, btn]) => { btn.classList.toggle('off', !domainOn.get(key)); btn.setAttribute('aria-pressed', String(domainOn.get(key))); });
      restyle();
    };
    chips.appendChild(b);
    chipButtons.push([d.key, b]);
  }
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = 'all';
  all.onclick = () => {
    for (const k of domainOn.keys()) domainOn.set(k, true);
    chipButtons.forEach(([, btn]) => { btn.classList.remove('off'); btn.setAttribute('aria-pressed', 'true'); });
    restyle();
  };
  chips.appendChild(all);

  // ---------- frame loop with level of detail ----------
  const DETAIL_DIST = 22;
  function tick(now) {
    if (flight) {
      const k = Math.min(1, (now - flight.t0) / flight.ms);
      const e = ease(k);
      camera.position.lerpVectors(flight.c0, flight.c1, e);
      controls.target.lerpVectors(flight.tv0, flight.t1, e);
      if (k >= 1) { camera.position.copy(flight.c1); controls.target.copy(flight.t1); flight = null; }
    }
    controls.update();
    for (const n of nodes.values()) {
      const near = camera.position.distanceTo(n.pos) < DETAIL_DIST;
      n.detail.visible = near;
      n.label.visible = !near;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  restyle();
  if (!openHash()) announce(`${M.tables.length} tables in ${L.islands.length} domains. Click a table or a line for its detail.`);
  requestAnimationFrame(tick);
})();
```

- [ ] **Step 5: The writer, in `archlens.ts`**

Append to the "3D explorer" section, after `schema3dModel`:

```ts
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A module's `export` keywords removed, so it can be inlined as a classic script. */
function inlineModule(src: string): string {
  return src.replace(/^export (?=(function|const|let|class)\b)/gm, '');
}

/**
 * One self-contained page: the model as JSON, Three.js rewritten as a classic script, the layout
 * module and the app. It loads nothing, so it opens from disk, an email or a USB stick.
 */
export function writeSchema3d(outdir: string, model: Schema3dModel, three: string = bundleThree(threeDir())): void {
  const e = escapeHtml;
  const asset = (f: string): string => readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
  // `<` becomes < so a table comment containing </script> cannot end the script early.
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${e(model.title)} — 3D schema explorer</title><style>${asset('schema-3d.css')}</style></head><body>\n`
    + '<div id="scene" role="application" aria-label="3D schema explorer">'
    + '<div class="ov tl">'
    + '<label class="sr" for="q">Find table or column</label>'
    + '<input id="q" type="search" placeholder="Find table or column… ( / )" autocomplete="off">'
    + '<div class="row"><span class="lbl">Hub edges</span>'
    + '<span class="seg" id="hubseg" role="group" aria-label="Hub edges">'
    + '<button type="button" data-m="all" class="on" aria-pressed="true">All</button>'
    + '<button type="button" data-m="muted" aria-pressed="false">Muted</button>'
    + '<button type="button" data-m="hidden" aria-pressed="false">Hidden</button></span>'
    + '<span id="hubinfo" class="lbl"></span>'
    + '<button type="button" id="reset" class="plain">Reset view (Esc)</button></div>'
    + '<div class="chips" id="chips" role="group" aria-label="Domains"></div></div>'
    + '<div class="ov help">drag rotate · right-drag pan · scroll zoom · click a table or a line · double-click flies there · Esc clears</div>'
    + '<div id="tip" role="tooltip"></div>'
    + '<aside class="panel" id="panel" aria-label="Detail"></aside>'
    + '<p id="live" class="sr" aria-live="polite"></p>'
    + '<div id="nowebgl" hidden><p>This page needs WebGL, which this browser has turned off. The flat diagram is in <a href="index.html#schema">index.html</a>.</p></div>'
    + '</div>\n'
    + `<footer>Generated from <code>${e(model.source)}</code> on ${localToday()} · <a href="index.html">Docs and findings</a></footer>\n`
    + `<script>window.SCHEMA3D=${data};</script>\n`
    + `<script>${three}</script>\n`
    + `<script>${inlineModule(asset('schema-3d-layout.js'))}</script>\n`
    + `<script>${asset('schema-3d-app.js')}</script>\n`
    + '</body></html>\n';
  writeFileSync(path.join(outdir, 'schema-3d.html'), page);
}
```

- [ ] **Step 6: Wire it into `main()` and the header comment**

In `main()`, after the `writeHtml(...)` call:

```ts
  writeHtml(outdir, tables, narratives, findings, doc.stats, schemaPath);
  writeSchema3d(outdir, schema3dModel(tables, narratives, findings, schemaPath));
```

In the header comment at the top of the file, after the `<out>/FINDINGS.md` line:

```
 *     <out>/schema-3d.html  rotatable 3D view: domain islands, every foreign key as an arc
```

- [ ] **Step 7: Run the tests**

Run: `npm test 2>&1 | grep -E "schema-3d\.html|✖|pass [0-9]|fail [0-9]" | tail -12`
Expected: five new passes. The two golden runs now **fail** on nothing yet (they do not list `schema-3d.html`), so `pass 165`, `fail 0`. If `is deterministic` fails, the cause is almost always the date line not being on its own line; check the `\n` before `<footer>`.

- [ ] **Step 8: Syntax-check the browser files and typecheck**

Run: `node --check scripts/schema-3d-app.js && node --check scripts/schema-3d-layout.js && npm run typecheck && echo OK`
Expected: `OK`.

- [ ] **Step 9: Commit (ask first)**

```bash
git add scripts/schema-3d.css scripts/schema-3d-app.js scripts/archlens.ts test/archlens.test.ts
git commit -m "feat(db-review): write schema-3d.html, a self-contained rotatable view of the schema"
```

---

### Task 7: Links from `index.html` and `README.md`, goldens regenerated

**Files:**
- Modify: `skills/archlens-postgres/scripts/archlens.ts` (`writeHtml` Schema section and `tableHtml` header; `writeMarkdown` Diagram section)
- Modify: `skills/archlens-postgres/test/archlens.test.ts` (golden file lists; new assertions)
- Regenerate: `skills/archlens-postgres/examples/out/**`, `skills/archlens-postgres/test/fixtures/edge-cases.out/**`

- [ ] **Step 1: Write the failing tests**

In the two `goldenRun(...)` calls, add `'schema-3d.html'` to the file list right after `'index.html'`. Append inside the existing `describe('informer output', ...)` block, after its last `it`:

```ts
  it('links the 3D explorer from the Schema section and from every table', () => {
    const html = file('index.html');
    assert.match(html, /<section id="schema"><h2>Schema<\/h2><p class="muted"><a href="schema-3d.html">Open the 3D explorer<\/a>/);
    assert.equal(count(html, /<a class="meta" href="schema-3d\.html#t=/g), 3);
    assert.match(html, /<a class="meta" href="schema-3d\.html#t=widget">View in 3D<\/a>/);
    assert.match(file('README.md'), /!\[Entity-relationship diagram\]\(erd\.svg\)\n\n\[Open the 3D explorer\]\(schema-3d\.html\)/);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test 2>&1 | grep -E "✖|fail [0-9]"`
Expected: the new `it` fails, and `writes schema-3d.html identical to ...` fails for both fixtures (no golden file yet). `fail 3`.

- [ ] **Step 3: Add the links**

In `writeHtml`, replace the Schema section line:

```ts
  body.push(`<section id="schema"><h2>Schema</h2><p class="muted"><a href="schema-3d.html">Open the 3D explorer</a> · rotate, zoom, click any table or relationship. Every foreign key is drawn.</p>`
    + `<div class="erd-wrap">${svgErd(tables, [...tables.keys()])}</div></section>`);
```

In `tableHtml`, change the `<header>` so it ends with the link:

```ts
      + `<header><h3>${e(t.name)}</h3><span class="meta">${meta}</span><a class="meta" href="schema-3d.html#t=${e(t.name)}">View in 3D</a></header>${desc}${fnd}`
```

In `writeMarkdown`, replace the Diagram line:

```ts
  lines.push('', '## Diagram', '', '![Entity-relationship diagram](erd.svg)', '',
    '[Open the 3D explorer](schema-3d.html) — a self-contained page: rotate, zoom, click any table or relationship.');
```

- [ ] **Step 4: Regenerate both goldens and read the diff**

```bash
npm run review -- examples/sample-schema.sql --narratives examples/narratives.json --out examples/out
npm run review -- test/fixtures/edge-cases.sql --narratives test/fixtures/edge-cases.narratives.json --out test/fixtures/edge-cases.out
git status --short examples/out test/fixtures/edge-cases.out
git diff --stat examples/out test/fixtures/edge-cases.out
git diff examples/out/README.md examples/out/index.html | head -80
```

Expected: two new untracked `schema-3d.html` files (about 0.8 MB each); `README.md` and `index.html` modified in both golden dirs; `schema.json` differs only in `generated_at`; nothing else changed. If `FINDINGS.md` or any `.svg` changed, stop: something else moved.

The summary lines printed by the two runs must still read `findings: 8 error, 18 warn, 12 info` and `findings: 9 error, 8 warn, 11 info`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 168`, `fail 0`.

- [ ] **Step 6: Commit (ask first)**

```bash
git add scripts/archlens.ts test/archlens.test.ts examples/out test/fixtures/edge-cases.out
git commit -m "feat(db-review): link the 3D explorer from index.html and README.md; goldens"
```

---

### Task 8: Ratchets: nothing from the web, browser files parse

**Files:**
- Test: `skills/archlens-postgres/test/archlens.test.ts`

- [ ] **Step 1: Add the ratchet to `goldenRun`**

Inside `goldenRun`, after the `emits no Mermaid in any output file` test, add:

```ts
    // The second ratchet: no output file may load anything from the web. The docs must open
    // from disk, an email or a USB stick; the 3D explorer carries its own copy of Three.js.
    it('loads nothing from the web in any output file', () => {
      const written = readdirSync(out, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
      for (const f of written) {
        const text = readFileSync(f, 'utf8');
        assert.doesNotMatch(text, /(src|href)="https?:/, `${f} loads from the web`);
        assert.doesNotMatch(text, /importmap/, `${f} uses an import map`);
      }
    });
```

- [ ] **Step 2: Add the parse check**

Append at the end of the file:

```ts
describe('browser files', () => {
  for (const f of ['scripts/schema-3d-layout.js', 'scripts/schema-3d-app.js']) {
    it(`${f} parses`, () => {
      const run = spawnSync(process.execPath, ['--check', f], { cwd: root, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    });
  }
});
```

- [ ] **Step 3: Run**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 172`, `fail 0`. Should the web ratchet fail on an existing file, read the match before touching anything: the SVG `xmlns="http://www.w3.org/2000/svg"` is an attribute, not `src` or `href`, and does not match.

- [ ] **Step 4: Commit (ask first)**

```bash
git add test/archlens.test.ts
git commit -m "test(db-review): ratchet against web loads and unparseable browser files"
```

---

### Task 9: Headed browser verification

No files change in this task. It uses the `agent-browser` skill in headed mode (the `browser-watch-mode` skill has the exact daemon-reset steps) so Steve can watch.

- [ ] **Step 1: Open the sample output**

```bash
export AGENT_BROWSER_HEADED=1
agent-browser close --all; pkill -f ".agent-browser/browsers/chrome"; sleep 2
AGENT_BROWSER_HEADED=1 agent-browser open --headed "file://$(pwd)/examples/out/schema-3d.html"
sleep 3
agent-browser errors
agent-browser eval "document.querySelectorAll('#scene canvas').length + ' canvas · ' + document.getElementById('hubinfo').textContent + ' · ' + document.getElementById('chips').children.length + ' chips'"
```

Expected: `errors` prints nothing; the eval prints `1 canvas · tenant ←10 · 8 chips` (six domains, Unclaimed for `legacy_import_staging`, plus "all").

- [ ] **Step 2: Deep link to a table**

```bash
AGENT_BROWSER_HEADED=1 agent-browser open --headed "file://$(pwd)/examples/out/schema-3d.html#t=tenant"
sleep 2
agent-browser errors
agent-browser eval "document.getElementById('panel').classList.contains('show') + ' · ' + document.querySelector('#panel h3').textContent + ' · ' + document.getElementById('live').textContent"
```

Expected: `true · tenant · tenant selected, 1 foreign keys out, referenced by 10`.

- [ ] **Step 3: Deep link to a relationship**

```bash
AGENT_BROWSER_HEADED=1 agent-browser open --headed "file://$(pwd)/examples/out/schema-3d.html#fk=sessions.user_id"
sleep 2
agent-browser errors
agent-browser eval "document.querySelector('#panel h3').textContent + ' · ' + document.querySelector('#panel .fnd').textContent"
```

Expected: starts with `sessions.user_id → users.id · Warning` and contains `fk-index` (the sample's unindexed key).

- [ ] **Step 4: The edge-case output and a resize**

```bash
AGENT_BROWSER_HEADED=1 agent-browser open --headed "file://$(pwd)/test/fixtures/edge-cases.out/schema-3d.html"
sleep 3
agent-browser errors
agent-browser eval "window.resizeTo(700, 900); document.getElementById('hubinfo').textContent"
agent-browser errors
```

Expected: no errors either time; `org ←6`.

- [ ] **Step 5: Hand the window to Steve**

Raise the window (the `osascript` lines from `browser-watch-mode`), then ask him to click one table and one arc and say whether the focus mode and panel read right. Record his answer in the pull request body. If he asks for a visual change, make it in `schema-3d-app.js` or `schema-3d.css`, rerun `npm test` (the deterministic and golden tests will fail until the goldens are regenerated with the Task 7 Step 4 commands), and commit as `fix(db-review): <what changed>`.

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (repo root)
- Modify: `README.md` (repo root)
- Modify: `skills/archlens-postgres/README.md`
- Modify: `CHANGELOG.md`

Run the `no-ai-slop` skill over each paragraph before writing it, per Steve's standing rule.

- [ ] **Step 1: `CLAUDE.md`**

In "What this repo is", change the first sentence's description of the script to: `` `scripts/archlens.ts` runs deterministic checks and writes the docs, including `schema-3d.html`, a self-contained rotatable 3D view of the whole schema. ``

In "Commands", the sentence `The one runtime dependency is libpg-query, ...` becomes: `` The two runtime dependencies are `libpg-query`, a WebAssembly build of PostgreSQL's parser, and `three` (Three.js), whose minified modules the script rewrites into one classic script and inlines into `schema-3d.html`; every version in `package.json` is pinned exactly. ``

In "Testing", change `127 tests in four groups` to the number `npm test` prints, `in five groups`, and add after item 4:

```
5. The 3D explorer. `bundleThree()` runs in a Node sandbox and reports Three.js revision 185 with `WebGLRenderer` and `OrbitControls` present, so an upgrade that changes the file shape fails here. `schema3dModel()` on the sample: one entry per table and foreign key, `fk-index` findings on their key and `primary-key` findings on their table, `tenant` the only hub. The layout module: the hub's domain at the origin, parents before children inside an island, no two islands overlapping on the sample or on a twelve-domain synthetic schema, the same coordinates twice, depth islands when there are no narratives. `writeSchema3d()`: one page with the model, Three.js, layout and app inline, `</script>` in a comment escaped, deterministic apart from the date line. A second ratchet scans every output file for `src=` or `href=` pointing at `http` and for import maps.
```

Add `'schema-3d.html'` to the golden file lists described in item 1 (the sentence naming which files are compared).

In "How the script is put together", after the **Rendering** paragraph, add:

```
**3D explorer.** `schema3dModel()` turns the same tables, findings and narratives into compact JSON: domains with a colour, tables with columns and their findings, foreign keys with `words` from `describeRelationship()`, the narrative `why`, and any finding whose check is about that key (`fk-index`, `fk-nullable`, `fk-on-delete`, `cardinality`, `undocumented-relationship`); `hubs` lists tables referenced by at least a third of the other tables and by at least four. With no narratives the domains are dependency depths (`depth-0`, `depth-1`, ...). `scripts/schema-3d-layout.js` is a pure module, run by the tests under Node and inlined into the page with its `export` keywords stripped: the hub's domain sits at the origin, other domains on a ring widened until no two islands overlap, cards on a grid inside each island sorted parents-first, and one arc per foreign key (lift 1.2 inside an island, `3 + 0.16 × distance` across). `scripts/schema-3d-app.js` and `schema-3d.css` are the Three.js scene: cards, labels that swap to a column card within 22 units, arcs (dashed when the key has an `fk-index` finding), focus mode, a detail panel for tables and for relationships, search, domain chips, a hub-edge control (All, Muted, Hidden), deep links `#t=<table>` and `#fk=<child>.<column>`, eased time-based camera flights, reduced-motion and no-WebGL fallbacks. `bundleThree()` rewrites the pinned Three.js modules into one classic script (imports become destructuring, the export tail a return); `build/three.cjs` wrapped whole is the fallback if an upgrade breaks the rewrite. `writeSchema3d()` assembles the page; `index.html` and `README.md` link to it.
```

- [ ] **Step 2: Root `README.md`**

In the "What you get" tree, after the `index.html` line, add:

```
├── schema-3d.html  rotatable 3D view of the whole schema: one island per domain, every foreign key as an arc, click any table or relationship for its detail. Self-contained, about 1 MB
```

- [ ] **Step 3: Skill `README.md`**

Same tree line after `index.html`. Change the install comment to:

```
npm install                 # two dependencies, both pinned: libpg-query (the real PostgreSQL parser as WebAssembly) and three (inlined into schema-3d.html)
```

- [ ] **Step 4: `CHANGELOG.md`**

Insert above the 1.6.0 entry:

```
## [1.7.0](https://github.com/greenstevester/archlens-postgres/releases/tag/v1.7.0) — 2026-09-02

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
```

- [ ] **Step 5: Check and commit (ask first)**

Run from the repo root: `grep -n "schema-3d" CLAUDE.md README.md skills/archlens-postgres/README.md CHANGELOG.md | wc -l` → at least 8.

```bash
git add CLAUDE.md README.md skills/archlens-postgres/README.md CHANGELOG.md
git commit -m "docs: describe schema-3d.html, its tests and the vendored Three.js"
```

---

### Task 11: Version 1.7.0 and plugin validation

**Files:**
- Modify: `.claude-plugin/marketplace.json` (both `version` fields), `.claude-plugin/plugin.json`, `skills/archlens-postgres/.claude-plugin/plugin.json`, `skills/archlens-postgres/package.json`, `skills/archlens-postgres/package-lock.json`

- [ ] **Step 1: Bump**

From the repo root of the worktree:

```bash
sed -i '' 's/"version": "1.6.0"/"version": "1.7.0"/g' .claude-plugin/marketplace.json .claude-plugin/plugin.json skills/archlens-postgres/.claude-plugin/plugin.json skills/archlens-postgres/package.json
grep -n '"version"' .claude-plugin/marketplace.json .claude-plugin/plugin.json skills/archlens-postgres/.claude-plugin/plugin.json skills/archlens-postgres/package.json
```

Expected: five lines, all `1.7.0`.

- [ ] **Step 2: Sync the lockfile**

```bash
cd skills/archlens-postgres && npm install --no-audit --no-fund && git diff --stat package-lock.json && cd ../..
```

Expected: the lockfile's own `version` lines move to `1.7.0`, nothing else.

- [ ] **Step 3: Validate and test**

```bash
claude plugin validate . && claude plugin validate skills/archlens-postgres
cd skills/archlens-postgres && npm test 2>&1 | tail -4 && npm run typecheck && cd ../..
```

Expected: both validations pass; `fail 0`; typecheck silent.

- [ ] **Step 4: Commit (ask first)**

```bash
git add .claude-plugin/marketplace.json .claude-plugin/plugin.json skills/archlens-postgres/.claude-plugin/plugin.json skills/archlens-postgres/package.json skills/archlens-postgres/package-lock.json
git commit -m "chore(release): v1.7.0"
```

- [ ] **Step 5: Finish the branch**

Invoke the `sp-finishing-a-development-branch` skill. The pull request body lists the behaviour change (new output file, two new ratchets, no finding changed), the golden regeneration, Steve's headed-browser check from Task 9, and ends with the attribution the session prescribes. Tag `v1.7.0` only after the merge, with release notes from the changelog entry.
