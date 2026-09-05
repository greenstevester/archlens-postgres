# 3D schema explorer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** every run writes a fourth output file, `schema-3d.html`, in which a developer rotates and zooms a
schema of up to about 300 tables, grouped into domain islands, and clicks any table or any relationship line
for its detail.

**Architecture:** three new source files under `skills/archlens-postgres/scripts/` — a vendoring step that
rewrites Three.js from ES modules into one classic script, a pure layout module that Node tests and the browser
both run, and the browser app — assembled by a fourth writer in `archlens.ts` into one self-contained file that
loads nothing from the web.

**Tech stack:** TypeScript run directly by Node 24, `three` 0.185.1 pinned exactly, `node --test`, no build step,
no framework.

**Spec:** `docs/specs/2026-09-02-webgl-schema-explorer.md`. Read it before Task 6 — its "Scene" section is the
behaviour contract and is not repeated here in full.

---

## Four corrections to the spec, each checked against the real files

The spec's vendoring section was checked against `three@0.185.1` on 2026-09-03 by building the bundle and running
it in a Node sandbox. It works, with three changes:

1. **Five rewrites, not four.** `three.module.min.js` carries a *third* statement the spec does not mention: a
   pass-through `export{…}from"./three.core.min.js"` re-exporting 245 names. Left in place it is a syntax error
   inside the wrapping function, so it must be deleted. Deleting it is safe, and the reason is not obvious:
   all 245 names are among core's 444 exports, and the last line spreads `THREE_CORE` into `THREE`, so nothing
   is lost. That reasoning belongs in a comment — see Task 2.
2. **Import maps and export maps are inverses.** `export{A as Name}` publishes local `A` as `Name`, so it becomes
   `Name:A`. `import{Name as a}` binds public `Name` to local `a`, so it becomes `Name:a`. One shared helper
   applied to both produces a bundle that parses, runs, and is silently wrong. Two helpers, in Task 2.
3. **The OrbitControls import is multi-line, with tab indentation.** `/import\s*\{(.*)\}\s*from\s*'three';/`
   never matches. Use `[\s\S]*?`.
4. **Neither fixture contains a self-referencing table**, so the spec's self-reference loop has no fixture to
   test it against. The edge-case fixture's "foreign-key cycle" is `site → region → site` — two ordinary arcs
   between two tables, not a table pointing at itself. Counted directly: the sample has 10 same-domain and 12
   cross-domain foreign keys and zero self-references; the edge-case fixture has none either. The loop branch
   is therefore covered by a hand-built model in Task 4 rather than by a fixture. Adding a self-reference to a
   fixture is the alternative, and it is the wrong trade — it would move the finding counts the spec pins.

**One open question, deliberately left as the spec wrote it.** `schema3dModel(tables, extras, narratives, findings)`
takes `extras`, and nothing in the model needs it — enum-ness is already `Column.is_enum_type`, and extensions and
unparsed statements have no place in the picture. The signature below keeps `extras` for symmetry with
`modelToJson`. Drop the parameter if Steve would rather not carry an unused argument; it is a one-line change in
Task 3 and one call site in Task 5.

---

## File structure

**New, in `skills/archlens-postgres/scripts/`:**

| File | Responsibility |
|---|---|
| `schema-3d-vendor.ts` | `vendorThree(threeDir)` → one classic-script string defining `THREE` and `OrbitControls`. Nothing else knows Three.js is ES modules. |
| `schema-3d-layout.js` | Pure geometry. Same model in, same coordinates out. No Three.js, no DOM. Imported by tests, inlined into the page. |
| `schema-3d-app.js` | The browser app: scene, picking, panel, search, deep links. Classic script, runs only in a browser. |
| `schema-3d.css` | The page's styling. Dark only. |

**Modified:**

| File | Change |
|---|---|
| `scripts/archlens.ts` | `schema3dModel()` and `writeSchema3d()`; two kinds of link in `writeHtml()`; one link in `writeMarkdown()`; one call in `main()`. |
| `test/archlens.test.ts` | Seven new groups (Task 2, 3, 4, 5, 7, 8). |
| `package.json` | `three` at `0.185.1` in `dependencies`; version to 1.7.0. |
| `.gitignore` | `.superpowers/`. |
| `CLAUDE.md`, both `README.md`, `SKILL.md`, `CHANGELOG.md` | Task 11. |
| `.claude-plugin/marketplace.json` (×2 fields), `.claude-plugin/plugin.json`, `skills/archlens-postgres/.claude-plugin/plugin.json` | Version to 1.7.0. |

**Golden output, regenerated in Task 9:** `examples/out/schema-3d.html` and
`test/fixtures/edge-cases.out/schema-3d.html`, about 0.8 MB each.

Throughout, `<skill>` means `skills/archlens-postgres/` and commands run from there.

---

### Task 0: Worktree and branch

**Files:** none.

- [ ] **Step 1: Create the worktree off `main`**

```bash
cd ~/dev/git-repos/github/techno-8/archlens-postgres
git worktree add ~/dev/git-repos/github/techno-8/db-3d-explorer -b feat/schema-3d-explorer main
```

- [ ] **Step 2: Carry the spec across — it is untracked in the main checkout**

```bash
mkdir -p ~/dev/git-repos/github/techno-8/db-3d-explorer/docs/plans
cp docs/specs/2026-09-02-webgl-schema-explorer.md ~/dev/git-repos/github/techno-8/db-3d-explorer/docs/specs/
cp docs/plans/2026-09-03-schema-3d-explorer.md ~/dev/git-repos/github/techno-8/db-3d-explorer/docs/plans/
```

- [ ] **Step 3: Install dependencies in the worktree**

```bash
cd ~/dev/git-repos/github/techno-8/db-3d-explorer/skills/archlens-postgres
npm install
npm test 2>&1 | tail -5
```

Expected: the existing suite passes — 127 tests, 0 failures. If it does not, stop: the branch point is broken,
and nothing below is trustworthy.

Every path from here is relative to the worktree.

---

### Task 1: Pin `three`, ignore `.superpowers/`, commit the spec

**Files:**
- Modify: `<skill>/package.json`
- Modify: `.gitignore`
- Create: `docs/specs/2026-09-02-webgl-schema-explorer.md`, `docs/plans/2026-09-03-schema-3d-explorer.md` (copied in Task 0)

- [ ] **Step 1: Add the dependency, pinned exactly**

In `<skill>/package.json`, `dependencies` becomes:

```json
  "dependencies": {
    "libpg-query": "17.7.4",
    "three": "0.185.1"
  },
```

No caret, no tilde. The vendoring rewrite is four regular expressions against a known file shape; a floating
version is a silent breakage waiting for the next `npm install`.

- [ ] **Step 2: Install and confirm the exact version landed**

```bash
cd skills/archlens-postgres && npm install
node -p "require('./node_modules/three/package.json').version"
```

Expected: `0.185.1`

- [ ] **Step 3: Ignore the brainstorm mockups**

Append to `.gitignore`:

```
.superpowers/
```

- [ ] **Step 4: Commit — ASK STEVE FIRST**

```bash
git add .gitignore skills/archlens-postgres/package.json skills/archlens-postgres/package-lock.json \
        docs/specs/2026-09-02-webgl-schema-explorer.md docs/plans/2026-09-03-schema-3d-explorer.md
git commit -m "chore(archlens): pin three 0.185.1 and record the 3D explorer spec and plan"
```

---

### Task 2: Vendor Three.js into one classic script

**Files:**
- Create: `<skill>/scripts/schema-3d-vendor.ts`
- Test: `<skill>/test/archlens.test.ts` (new group, appended)

This code is not a draft. It was written, run against `three@0.185.1`, and produced a 785 KB bundle that
evaluates in a Node sandbox to `REVISION 185` with a 451-name surface.

- [ ] **Step 1: Write the failing test**

Append to `test/archlens.test.ts`, and add `vm` to the imports at the top of the file
(`import vm from 'node:vm';`):

```ts
describe('vendored Three.js bundle', () => {
  let src = '';

  before(() => {
    src = vendorThree(path.resolve(root, 'node_modules/three'));
  });

  it('is one classic script, not a module', () => {
    assert.ok(src.startsWith('/* three:start */'), 'missing start marker');
    assert.ok(src.trimEnd().endsWith('/* three:end */'), 'missing end marker');
    assert.ok(!/^\s*(import|export)[\s{]/m.test(src), 'a bare import or export survived the rewrite');
  });

  it('runs in a sandbox and defines THREE at revision 185', () => {
    const ctx = vm.createContext({});
    vm.runInContext(`${src}\nglobalThis.__T = THREE; globalThis.__O = OrbitControls;`, ctx, { timeout: 30000 });
    assert.equal((ctx as any).__T.REVISION, '185');
    assert.equal(typeof (ctx as any).__T.WebGLRenderer, 'function');
    assert.equal(typeof (ctx as any).__T.Scene, 'function');
    assert.equal(typeof (ctx as any).__T.QuadraticBezierCurve3, 'function');
    assert.equal(typeof (ctx as any).__O, 'function');
  });

  it('merges core and main into one surface, so a core-only name is reachable', () => {
    const ctx = vm.createContext({});
    vm.runInContext(`${src}\nglobalThis.__T = THREE;`, ctx, { timeout: 30000 });
    // Controls and MathUtils are exported by three.core.min.js and only re-exported by
    // three.module.min.js, whose re-export the rewrite deletes. They must still be here.
    assert.equal(typeof (ctx as any).__T.Controls, 'function');
    assert.equal(typeof (ctx as any).__T.MathUtils.lerp, 'function');
    assert.equal((ctx as any).__T.MathUtils.lerp(0, 10, 0.5), 5);
  });

  it('throws a named error when a statement it rewrites changes shape', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'three-shape-'));
    mkdirSync(path.join(dir, 'build'), { recursive: true });
    mkdirSync(path.join(dir, 'examples/jsm/controls'), { recursive: true });
    writeFileSync(path.join(dir, 'build/three.core.min.js'), 'const a=1;'); // no export tail
    writeFileSync(path.join(dir, 'build/three.module.min.js'), 'export{a};');
    writeFileSync(path.join(dir, 'examples/jsm/controls/OrbitControls.js'), 'export { OrbitControls };');
    assert.throws(() => vendorThree(dir), /three\.core\.min\.js trailing export/);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Add `vendorThree` to the test file's import from the scripts:

```ts
import { vendorThree } from '../scripts/schema-3d-vendor.ts';
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test 2>&1 | grep -A3 "vendored Three.js"
```

Expected: FAIL — `Cannot find module '.../scripts/schema-3d-vendor.ts'`.

- [ ] **Step 3: Write the implementation**

Create `<skill>/scripts/schema-3d-vendor.ts`:

```ts
/**
 * Three.js ships as ES modules. A browser cannot `import` from an inline <script>, and the whole
 * point of schema-3d.html is that it loads nothing from the web — so at generation time the three
 * files we need are rewritten into one classic script that defines `THREE` and `OrbitControls`.
 *
 * Five rewrites against a pinned input, each asserted to match exactly once, so a Three.js upgrade
 * that moves the furniture fails the suite instead of shipping a broken page.
 *
 * ponytail: if a future release stops being rewritable this way, the fallback is build/three.cjs —
 * one 2.1 MB CommonJS file with no require() calls, wrapped whole with a fake `module` object.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The version this rewrite was written against. Kept in step with package.json by hand. */
export const THREE_VERSION = '0.185.1';
export const THREE_REVISION = '185';

/** `A as Name` -> ['A', 'Name']; a bare `Name` -> ['Name', undefined]. */
const pairs = (names: string): string[][] => names.split(',').map((s) => s.trim()).filter(Boolean)
  .map((p) => p.split(/\s+as\s+/).map((s) => s.trim()));

/** Export list: `export{A as Name}` publishes local A under the public name Name -> `Name:A`. */
const exportMap = (names: string): string => pairs(names)
  .map(([local, exported]) => `${exported ?? local}:${local}`).join(',');

/** Import list: `import{Name as a}` binds public Name to the local a the body uses -> `Name:a`.
 *  The inverse of exportMap. Using one helper for both parses fine and is silently wrong. */
const importMap = (names: string): string => pairs(names)
  .map(([imported, local]) => (local ? `${imported}:${local}` : imported)).join(',');

/** Replace exactly one match, or throw naming the statement that moved. */
function replaceOne(src: string, re: RegExp, fn: (...a: any[]) => string, what: string): string {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const hits = src.match(new RegExp(re.source, flags));
  if (!hits || hits.length !== 1) {
    throw new Error(`vendorThree: expected exactly one ${what}, found ${hits ? hits.length : 0}. `
      + `Three.js ${THREE_VERSION} changed shape; see the ponytail note in schema-3d-vendor.ts.`);
  }
  return src.replace(re, fn as any);
}

/** `threeDir` is the installed `node_modules/three`. Returns about 785 KB of classic script. */
export function vendorThree(threeDir: string): string {
  const build = (f: string): string => readFileSync(path.join(threeDir, 'build', f), 'utf8');
  const core = build('three.core.min.js');
  const main = build('three.module.min.js');
  const oc = readFileSync(path.join(threeDir, 'examples/jsm/controls/OrbitControls.js'), 'utf8');

  // core has no imports and one trailing export; it becomes a self-contained factory.
  const coreBody = replaceOne(core, /export\{([^}]*)\};?\s*$/,
    (_m, n) => `return{${exportMap(n)}};`, 'three.core.min.js trailing export');

  // main pulls what it needs out of core...
  let mainBody = replaceOne(main, /import\{([^}]*)\}from"\.\/three\.core\.min\.js";?/,
    (_m, n) => `const{${importMap(n)}}=THREE_CORE;`, 'three.module.min.js core import');
  // ...then re-exports 245 of core's names unchanged. That statement is dropped rather than
  // rewritten: every name in it is already a core export, and THREE spreads THREE_CORE below,
  // so the public surface is identical. Left in place it is a syntax error inside the wrapper.
  mainBody = replaceOne(mainBody, /export\{[^}]*\}from"\.\/three\.core\.min\.js";?/,
    () => '', 'three.module.min.js core re-export');
  // ...and finally exports its own 196.
  mainBody = replaceOne(mainBody, /export\{([^}]*)\};?\s*$/,
    (_m, n) => `return{${exportMap(n)}};`, 'three.module.min.js trailing export');

  // OrbitControls imports ten names from 'three' across multiple tab-indented lines, so the
  // pattern has to cross newlines.
  let ocBody = replaceOne(oc, /import\s*\{([\s\S]*?)\}\s*from\s*'three';/,
    (_m, n) => `const{${importMap(n)}}=THREE;`, "OrbitControls.js 'three' import");
  ocBody = replaceOne(ocBody, /export\s*\{\s*OrbitControls\s*\};?/,
    () => 'return OrbitControls;', 'OrbitControls.js export');

  return [
    '/* three:start */',
    `const THREE_CORE=(()=>{${coreBody}})();`,
    `const THREE_MAIN=(()=>{${mainBody}})();`,
    'const THREE={...THREE_CORE,...THREE_MAIN};',
    `const OrbitControls=(()=>{${ocBody}})();`,
    '/* three:end */',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test 2>&1 | grep -A3 "vendored Three.js"
npm run typecheck
```

Expected: four passing tests, `tsc --noEmit` clean.

- [ ] **Step 5: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/scripts/schema-3d-vendor.ts skills/archlens-postgres/test/archlens.test.ts
git commit -m "feat(archlens): rewrite three's ES modules into one classic script"
```

---

### Task 3: The model

**Files:**
- Modify: `<skill>/scripts/archlens.ts` (append after `describeRelationship`, around line 1383)
- Test: `<skill>/test/archlens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('schema3dModel', () => {
  let model: any;
  let tables: Map<string, Table>;

  before(async () => {
    const parsed = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    tables = parsed.tables;
    const narratives = json('examples/narratives.json');
    const reviewer = new Reviewer(tables, narratives);
    const findings = reviewer.run();
    model = schema3dModel(tables, parsed.extras, narratives, findings);
  });

  it('has one entry per table and per foreign key', () => {
    assert.equal(model.tables.length, tables.size);
    const fkCount = [...tables.values()].reduce((n, t) => n + t.fks.length, 0);
    assert.equal(model.fks.length, fkCount);
  });

  it('gives every domain a title and a colour, and claims every table', () => {
    const keys = new Set(model.domains.map((d: any) => d.key));
    for (const d of model.domains) {
      assert.ok(d.title, `${d.key} has no title`);
      assert.match(d.color, /^#[0-9a-f]{6}$/, `${d.key} colour is not a hex triplet`);
    }
    for (const t of model.tables) assert.ok(keys.has(t.domain), `${t.name} is in no domain`);
  });

  it('carries every field the relationship panel reads', () => {
    for (const fk of model.fks) {
      for (const field of ['child', 'columns', 'parent', 'ref_columns', 'cardinality',
        'nullable', 'unique', 'indexed', 'on_delete', 'words']) {
        assert.ok(field in fk, `${fk.child}.${fk.columns} is missing ${field}`);
      }
      assert.ok(typeof fk.words === 'string' && fk.words.length > 0);
      assert.ok('why' in fk && 'name' in fk && Array.isArray(fk.findings));
    }
  });

  it('names tenant as the one hub of the sample', () => {
    assert.deepEqual(model.hubs, ['tenant']);
  });

  it('attaches a key-level finding to its key and everything else to its table', () => {
    const keyChecks = new Set(['fk-index', 'fk-nullable', 'fk-on-delete', 'cardinality',
      'undocumented-relationship']);
    for (const fk of model.fks) {
      for (const f of fk.findings) assert.ok(keyChecks.has(f.check), `${f.check} landed on a key`);
    }
    for (const t of model.tables) {
      for (const f of t.findings) {
        assert.ok(f.id && f.severity && f.title && f.check, `${t.name} finding is incomplete`);
      }
    }
    // Nothing is lost: every finding is on exactly one of the two.
    const seen = new Set<string>();
    for (const t of model.tables) for (const f of t.findings) seen.add(f.id);
    for (const fk of model.fks) for (const f of fk.findings) seen.add(f.id);
    const all = new Reviewer(tables, json('examples/narratives.json')).run();
    assert.equal(seen.size, new Set(all.map((f) => f.id)).size);
  });

  it('falls back to one domain per dependency depth with no narratives', async () => {
    const parsed = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    const bare = schema3dModel(parsed.tables, parsed.extras, {}, new Reviewer(parsed.tables, {}).run());
    assert.ok(bare.domains.length > 0);
    for (const d of bare.domains) assert.match(d.key, /^depth-\d+$/);
    for (const t of bare.tables) assert.match(t.domain, /^depth-\d+$/);
  });
});

describe('schema3dModel on the edge-case fixture', () => {
  it('names org as its one hub', async () => {
    const parsed = await parseSchema(read('test/fixtures/edge-cases.sql'), 'test/fixtures/edge-cases.sql');
    const narratives = json('test/fixtures/edge-cases.narratives.json');
    const findings = new Reviewer(parsed.tables, narratives).run();
    const model = schema3dModel(parsed.tables, parsed.extras, narratives, findings);
    assert.deepEqual(model.hubs, ['org']);
  });
});
```

Add `schema3dModel` to the existing import from `'../scripts/archlens.ts'`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test 2>&1 | grep -A3 "schema3dModel"
```

Expected: FAIL — `schema3dModel is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/archlens.ts`, after `describeRelationship`:

```ts
// ---------------------------------------------------------------------------
// The 3D explorer's model. Built from the same objects the other writers use,
// so the schema is never parsed twice and a finding can never say two things.
// ---------------------------------------------------------------------------

/** Twelve colours for domain islands, cycling past twelve. Picked for a #0e1116 background;
 *  past twelve the island titles carry the distinction, which is the agreed trade. */
const DOMAIN_COLORS = ['#5b9dd9', '#e0a458', '#7bc47f', '#d97b7b', '#a78bda', '#4fc4c4',
  '#d98cc0', '#b3c34d', '#e0714f', '#6fa8dc', '#c9a227', '#8fbf9f'];
const UNCLAIMED_COLOR = '#6b7280';

/** The five checks that judge one foreign key rather than one table. A finding of any other
 *  check belongs to its table, however many columns it names. */
const KEY_LEVEL_CHECKS = new Set(['fk-index', 'fk-nullable', 'fk-on-delete', 'cardinality',
  'undocumented-relationship']);

export interface Schema3dDomain { key: string; title: string; blurb: string; color: string }
export interface Schema3dColumn { name: string; type: string; pk: boolean; fk: boolean; not_null: boolean }
export interface Schema3dFinding { id: string; severity: Severity; title: string; check: string }
export interface Schema3dTable {
  name: string; domain: string; description: string; source_line: number;
  columns: Schema3dColumn[]; findings: Schema3dFinding[];
}
export interface Schema3dFk {
  child: string; columns: string[]; parent: string; ref_columns: string[]; name: string | null;
  cardinality: string; nullable: boolean; unique: boolean; indexed: boolean; on_delete: string;
  why: string | null; words: string; findings: Schema3dFinding[];
}
export interface Schema3dModel {
  domains: Schema3dDomain[]; tables: Schema3dTable[]; fks: Schema3dFk[]; hubs: string[];
}

/** How many distinct tables hold a foreign key to `name`. Two keys from one child count once,
 *  because the hub rule counts tables, not constraints. */
function inboundTables(t: Table): number {
  return new Set(t.referenced_by.map((r) => r.table)).size;
}

/** 0 when nothing references a table; otherwise one more than the deepest table that does.
 *  A cycle contributes 0 at the point it closes, so a self-referencing schema still terminates. */
export function dependencyDepth(tables: Map<string, Table>): Record<string, number> {
  const memo: Record<string, number> = {};
  const onStack = new Set<string>();
  const walk = (name: string): number => {
    if (name in memo) return memo[name];
    if (onStack.has(name)) return 0;
    const t = tables.get(name);
    if (!t || !t.referenced_by.length) return (memo[name] = 0);
    onStack.add(name);
    const children = [...new Set(t.referenced_by.map((r) => r.table))].filter((c) => c !== name);
    const d = children.length ? 1 + Math.max(...children.map(walk)) : 0;
    onStack.delete(name);
    return (memo[name] = d);
  };
  for (const name of tables.keys()) walk(name);
  return memo;
}

const slim = (f: Finding): Schema3dFinding =>
  ({ id: f.id, severity: f.severity, title: f.title, check: f.check });

export function schema3dModel(tables: Map<string, Table>, _extras: Extras, narratives: Narratives,
  findings: Finding[]): Schema3dModel {
  const declared = (narratives.domains ?? []) as Narratives[];
  const depths = dependencyDepth(tables);

  // Domains: the narrative's own, plus Unclaimed when anything is left over. With no narratives
  // at all, one synthetic domain per dependency depth, so a bare run is still a picture.
  const domains: Schema3dDomain[] = [];
  const domainOf = new Map<string, string>();
  if (declared.length) {
    for (const d of declared) {
      domains.push({
        key: d.key as string, title: d.title as string, blurb: (d.blurb as string) ?? '',
        color: DOMAIN_COLORS[domains.length % DOMAIN_COLORS.length],
      });
      for (const name of (d.tables ?? []) as string[]) {
        if (tables.has(name)) domainOf.set(name, d.key as string);
      }
    }
    if ([...tables.keys()].some((n) => !domainOf.has(n))) {
      domains.push({ key: 'unclaimed', title: 'Unclaimed', color: UNCLAIMED_COLOR,
        blurb: 'Present in the schema, absent from every domain.' });
      for (const n of tables.keys()) if (!domainOf.has(n)) domainOf.set(n, 'unclaimed');
    }
  } else {
    for (const d of [...new Set(Object.values(depths))].sort((a, b) => a - b)) {
      domains.push({
        key: `depth-${d}`,
        title: d === 0 ? 'Depth 0: nothing depends on these'
          : `Depth ${d}: ${d} layer${d === 1 ? '' : 's'} of tables depend on these`,
        blurb: '', color: DOMAIN_COLORS[domains.length % DOMAIN_COLORS.length],
      });
    }
    for (const n of tables.keys()) domainOf.set(n, `depth-${depths[n]}`);
  }

  // Findings, split once: a key-level check on a key whose columns it names, everything else
  // on its table. Splitting here rather than in both readers is what keeps them agreeing.
  const keyFindings = new Map<string, Schema3dFinding[]>();
  const tableFindings = new Map<string, Schema3dFinding[]>();
  const push = (m: Map<string, Schema3dFinding[]>, k: string, f: Finding): void => {
    const list = m.get(k) ?? [];
    list.push(slim(f));
    m.set(k, list);
  };
  const fkKey = (child: string, columns: string[]): string => `${child}.${columns.join('+')}`;
  for (const f of findings) {
    const t = tables.get(f.table);
    const hit = t && KEY_LEVEL_CHECKS.has(f.check) && f.columns.length
      ? t.fks.find((fk) => sameSet(fk.columns, f.columns))
      : undefined;
    if (hit) push(keyFindings, fkKey(f.table, hit.columns), f);
    else push(tableFindings, f.table, f);
  }

  const modelTables: Schema3dTable[] = [...tables.values()].map((t) => ({
    name: t.name,
    domain: domainOf.get(t.name) ?? 'unclaimed',
    description: t.description.join(' '),
    source_line: t.source_line,
    columns: t.columns.map((c) => ({
      name: c.name, type: c.type, pk: c.is_pk, fk: c.is_fk, not_null: c.not_null,
    })),
    findings: (tableFindings.get(t.name) ?? []),
  }));

  const modelFks: Schema3dFk[] = [];
  for (const t of tables.values()) {
    const rels = relationships(t, narratives);
    t.fks.forEach((fk, i) => {
      const r = rels[i];
      modelFks.push({
        child: t.name, columns: fk.columns, parent: fk.ref_table, ref_columns: fk.ref_columns,
        name: fk.name, cardinality: fk.cardinality, nullable: fk.nullable, unique: fk.unique,
        indexed: fk.indexed, on_delete: fk.on_delete, why: r.why,
        words: describeRelationship(r),
        findings: (keyFindings.get(fkKey(t.name, fk.columns)) ?? []),
      });
    });
  }

  // A hub is referenced by at least a third of the other tables, and by at least four. Relative
  // rather than a fixed count so it holds from a 19-table sample to a 300-table schema.
  const floor = Math.max(4, Math.ceil((tables.size - 1) / 3));
  const hubs = [...tables.values()].filter((t) => inboundTables(t) >= floor)
    .map((t) => t.name).sort();

  return { domains, tables: modelTables, fks: modelFks, hubs };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test 2>&1 | grep -A3 "schema3dModel"
npm run typecheck
```

Expected: seven passing tests, `tsc --noEmit` clean.

- [ ] **Step 5: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/scripts/archlens.ts skills/archlens-postgres/test/archlens.test.ts
git commit -m "feat(archlens): build the 3D explorer's model from the reviewed schema"
```

---

### Task 4: The layout

**Files:**
- Create: `<skill>/scripts/schema-3d-layout.js`
- Test: `<skill>/test/archlens.test.ts`

Pure functions, no Three.js, no DOM. Node imports it in the tests; the writer inlines it into the page
with the `export ` keywords stripped (Task 5), which is why it must have no imports of its own.

- [ ] **Step 1: Write the failing test**

```ts
describe('schema-3d layout', () => {
  let model: any;
  let out: any;

  before(async () => {
    const parsed = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    const narratives = json('examples/narratives.json');
    model = schema3dModel(parsed.tables, parsed.extras, narratives,
      new Reviewer(parsed.tables, narratives).run());
    out = layout(model);
  });

  it('places every table exactly once', () => {
    assert.equal(Object.keys(out.positions).length, model.tables.length);
    for (const t of model.tables) {
      const p = out.positions[t.name];
      assert.ok(p, `${t.name} was not placed`);
      for (const axis of ['x', 'y', 'z']) assert.equal(typeof p[axis], 'number');
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
    }
  });

  it('puts the hub domain at the origin', () => {
    const hubDomain = model.tables.find((t: any) => t.name === model.hubs[0]).domain;
    const centre = out.islands.find((i: any) => i.key === hubDomain);
    assert.equal(centre.cx, 0);
    assert.equal(centre.cz, 0);
  });

  it('gives the same coordinates twice', () => {
    assert.deepEqual(layout(model), layout(model));
  });

  it('sorts parents before children inside an island', () => {
    const depths = out.depths;
    for (const island of out.islands) {
      const ds = island.tables.map((n: string) => depths[n]);
      for (let i = 1; i < ds.length; i += 1) assert.ok(ds[i] <= ds[i - 1], `${island.key} is out of order`);
    }
  });

  it('never overlaps two islands', () => {
    for (let i = 0; i < out.islands.length; i += 1) {
      for (let j = i + 1; j < out.islands.length; j += 1) {
        const a = out.islands[i];
        const b = out.islands[j];
        const gapX = Math.abs(a.cx - b.cx) - (a.w + b.w) / 2;
        const gapZ = Math.abs(a.cz - b.cz) - (a.d + b.d) / 2;
        assert.ok(gapX > 0 || gapZ > 0, `${a.key} overlaps ${b.key}`);
      }
    }
  });

  it('draws one arc per foreign key, lifting further across islands', () => {
    assert.equal(out.arcs.length, model.fks.length);
    const inside = out.arcs.filter((a: any) => a.sameIsland && a.kind === 'arc');
    const across = out.arcs.filter((a: any) => !a.sameIsland && a.kind === 'arc');
    for (const a of inside) assert.equal(a.ctrl[1], 1.2);
    for (const a of across) assert.ok(a.ctrl[1] >= 3, 'a cross-island arc is not lifted');
    assert.ok(inside.length > 0 && across.length > 0, 'the sample should have both kinds');
  });

  it('gives an arc an id that matches the deep-link form', () => {
    for (const a of out.arcs) assert.equal(a.id, `${a.child}.${a.columns.join('+')}`);
  });

  // Neither fixture has a self-referencing table — the edge-case "cycle" is site -> region -> site,
  // which is two ordinary arcs. So the loop branch gets a hand-built model or no coverage at all.
  it('loops a self-reference above its own card', () => {
    const one = {
      domains: [{ key: 'core', title: 'Core', blurb: '', color: '#5b9dd9' }],
      tables: [{ name: 'node', domain: 'core', description: '', source_line: 1, columns: [], findings: [] }],
      fks: [{ child: 'node', columns: ['parent_id'], parent: 'node', ref_columns: ['id'], name: null,
        cardinality: '1:N', nullable: true, unique: false, indexed: false, on_delete: 'NO ACTION',
        why: null, words: 'one node, many node', findings: [] }],
      hubs: [],
    };
    const [loop] = layout(one).arcs;
    assert.equal(loop.kind, 'loop');
    assert.equal(loop.id, 'node.parent_id');
    assert.equal(loop.child, loop.parent);
    assert.ok(loop.ctrl[1] > loop.from[1], 'the loop does not rise above its card');
  });
});
```

Add to the test file's imports:

```ts
import { layout } from '../scripts/schema-3d-layout.js';
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test 2>&1 | grep -A3 "schema-3d layout"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `<skill>/scripts/schema-3d-layout.js`:

```js
/**
 * Where every table and every relationship sits in the 3D explorer. Pure: the same model gives
 * the same coordinates, in Node during the tests and in the browser on the page. No Three.js
 * import and no DOM, because the writer inlines this file as a classic script.
 *
 * Units are scene units. A table card is 1.8 wide and 1.1 deep; the close-up column card is
 * 3.4 wide, which is where the 3.6 across / 2.4 deep grid spacing comes from.
 */

export const CARD = { w: 1.8, h: 0.16, d: 1.1 };
export const SPACING = { x: 3.6, z: 2.4 };
export const LIFT_INSIDE = 1.2;
export const LOOP_RADIUS = 0.8;

/** 0 when nothing references a table; otherwise one more than the deepest table that does. */
export function depthsOf(model) {
  const children = new Map();
  for (const t of model.tables) children.set(t.name, new Set());
  for (const fk of model.fks) {
    if (fk.child !== fk.parent && children.has(fk.parent)) children.get(fk.parent).add(fk.child);
  }
  const memo = {};
  const onStack = new Set();
  const walk = (name) => {
    if (name in memo) return memo[name];
    if (onStack.has(name)) return 0;
    const kids = [...(children.get(name) ?? [])].sort();
    if (!kids.length) return (memo[name] = 0);
    onStack.add(name);
    const d = 1 + Math.max(...kids.map(walk));
    onStack.delete(name);
    return (memo[name] = d);
  };
  for (const t of model.tables) walk(t.name);
  return memo;
}

/** How many distinct children point at each table. */
function inboundCounts(model) {
  const seen = new Map();
  for (const t of model.tables) seen.set(t.name, new Set());
  for (const fk of model.fks) if (seen.has(fk.parent)) seen.get(fk.parent).add(fk.child);
  const counts = {};
  for (const [name, set] of seen) counts[name] = set.size;
  return counts;
}

/** Tables of one domain on a square-ish grid, parents before children, then by name. */
function grid(names, depths) {
  const sorted = [...names].sort((a, b) => (depths[b] - depths[a]) || a.localeCompare(b));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const rows = Math.max(1, Math.ceil(sorted.length / cols));
  const placed = sorted.map((name, i) => ({
    name,
    dx: ((i % cols) - (cols - 1) / 2) * SPACING.x,
    dz: (Math.floor(i / cols) - (rows - 1) / 2) * SPACING.z,
  }));
  return { placed, order: sorted, w: cols * SPACING.x, d: rows * SPACING.z };
}

export function layout(model) {
  const depths = depthsOf(model);
  const inbound = inboundCounts(model);

  // The domain holding the most-referenced table sits at the origin; ties break by name so the
  // picture does not move between runs.
  const busiest = [...model.tables].sort((a, b) =>
    (inbound[b.name] - inbound[a.name]) || a.name.localeCompare(b.name))[0];
  const centreKey = busiest ? busiest.domain : (model.domains[0] || {}).key;

  const members = new Map(model.domains.map((d) => [d.key, []]));
  for (const t of model.tables) if (members.has(t.domain)) members.get(t.domain).push(t.name);

  const built = model.domains.map((d) => ({ domain: d, ...grid(members.get(d.key) ?? [], depths) }));
  const centre = built.find((b) => b.domain.key === centreKey) ?? built[0];
  const ring = built.filter((b) => b !== centre);

  // Radius: enough for every island to sit side by side round the circle with a 15% margin, and
  // never less than the largest island's diagonal, so nothing touches.
  const perimeter = ring.reduce((n, b) => n + b.w, 0) * 1.15;
  const diagonal = Math.max(...built.map((b) => Math.hypot(b.w, b.d)), 1);
  const radius = ring.length ? Math.max(perimeter / (2 * Math.PI), diagonal) : 0;

  const islands = [];
  const positions = {};
  const place = (b, cx, cz) => {
    islands.push({
      key: b.domain.key, title: b.domain.title, blurb: b.domain.blurb, color: b.domain.color,
      cx, cz, w: b.w, d: b.d, tables: b.order,
    });
    for (const p of b.placed) {
      positions[p.name] = { x: cx + p.dx, y: 0, z: cz + p.dz, island: b.domain.key };
    }
  };
  place(centre, 0, 0);
  ring.forEach((b, i) => {
    const a = (2 * Math.PI * i) / ring.length;
    place(b, radius * Math.cos(a), radius * Math.sin(a));
  });

  const top = CARD.h / 2;
  const arcs = model.fks.map((fk) => {
    const from = positions[fk.child];
    const to = positions[fk.parent];
    if (!from || !to) return null;
    const id = `${fk.child}.${fk.columns.join('+')}`;
    if (fk.child === fk.parent) {
      return { id, kind: 'loop', child: fk.child, parent: fk.parent, columns: fk.columns,
        sameIsland: true, from: [from.x, top, from.z], to: [to.x, top, to.z],
        ctrl: [from.x, top + LOOP_RADIUS * 2, from.z], radius: LOOP_RADIUS };
    }
    const sameIsland = from.island === to.island;
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    const lift = sameIsland ? LIFT_INSIDE : 3 + 0.16 * dist;
    return { id, kind: 'arc', child: fk.child, parent: fk.parent, columns: fk.columns, sameIsland,
      from: [from.x, top, from.z], to: [to.x, top, to.z],
      ctrl: [(from.x + to.x) / 2, lift, (from.z + to.z) / 2] };
  }).filter(Boolean);

  const xs = Object.values(positions).map((p) => p.x);
  const zs = Object.values(positions).map((p) => p.z);
  const bounds = xs.length
    ? { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
    : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  return { islands, positions, arcs, depths, bounds, radius };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test 2>&1 | grep -A3 "schema-3d layout"
node --check scripts/schema-3d-layout.js && echo "SYNTAX OK"
```

Expected: eight passing tests, syntax clean.

- [ ] **Step 5: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/scripts/schema-3d-layout.js skills/archlens-postgres/test/archlens.test.ts
git commit -m "feat(archlens): lay out domain islands and relationship arcs"
```

---

### Task 5: The writer

**Files:**
- Modify: `<skill>/scripts/archlens.ts` (`writeSchema3d`, and one call in `main()`)
- Test: `<skill>/test/archlens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('writeSchema3d', () => {
  let out = '';
  let html = '';

  before(async () => {
    out = mkdtempSync(path.join(tmpdir(), 'db-3d-'));
    const parsed = await parseSchema(read('examples/sample-schema.sql'), 'examples/sample-schema.sql');
    const narratives = json('examples/narratives.json');
    writeSchema3d(out, parsed.tables, parsed.extras, narratives,
      new Reviewer(parsed.tables, narratives).run(), 'examples/sample-schema.sql');
    html = readFileSync(path.join(out, 'schema-3d.html'), 'utf8');
  });
  after(() => rmSync(out, { recursive: true, force: true }));

  it('writes one self-contained file', () => {
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.length > 700_000, `expected the vendored bundle inside; got ${html.length} bytes`);
  });

  it('loads nothing from the web', () => {
    assert.ok(!/src="http/i.test(html));
    assert.ok(!/href="http/i.test(html));
    assert.ok(!/importmap/i.test(html));
    assert.ok(!/mermaid/i.test(html));
  });

  it('carries the model, the layout and the app', () => {
    assert.ok(html.includes('window.SCHEMA3D='));
    assert.ok(html.includes('/* three:start */') && html.includes('/* three:end */'));
    assert.ok(html.includes('function layout(') || html.includes('layout=function'));
    assert.ok(!/^\s*export\s/m.test(html), 'an export keyword survived inlining');
  });

  it('cannot break out of its own script tag', () => {
    const open = html.indexOf('window.SCHEMA3D=');
    const close = html.indexOf('<\/script>', open);
    assert.ok(close > open);
    assert.ok(!html.slice(open, close).includes('</'), 'a raw </ reached the JSON');
  });

  it('names its source and date on one filterable line', () => {
    assert.match(html, /Generated from .* on \d{4}-\d{2}-\d{2}/);
  });

  it('degrades without WebGL and points back at the flat docs', () => {
    assert.ok(html.includes('index.html#schema'));
  });
});
```

Add `writeSchema3d` to the test's import from `'../scripts/archlens.ts'`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test 2>&1 | grep -A3 "writeSchema3d"
```

Expected: FAIL — `writeSchema3d is not a function`.

- [ ] **Step 3: Write the implementation**

At the top of `scripts/archlens.ts`, beside the existing imports, add:

```ts
import { vendorThree } from './schema-3d-vendor.ts';
```

Append after `writeHtml`:

```ts
/** Where this script lives, so the page's own assets are read beside it rather than from cwd. */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The layout module is an ES module so Node can import it in the tests; the page needs a classic
 *  script. Stripping the export keyword is the whole difference, and the writer test asserts none
 *  survives. */
function inlineModule(file: string): string {
  return readFileSync(path.join(SCRIPT_DIR, file), 'utf8').replace(/^export\s+(?=(function|const|class)\s)/gm, '');
}

/** JSON safe to sit inside a <script> element: only `<` can end it early. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function writeSchema3d(outdir: string, tables: Map<string, Table>, extras: Extras,
  narratives: Narratives, findings: Finding[], source: string): void {
  const model = schema3dModel(tables, extras, narratives, findings);
  const db = (narratives.database ?? {}) as Narratives;
  const title = `${(db.title as string) ?? 'Database'} — 3D explorer`;
  const e = escapeHtml;

  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${e(title)}</title>`
    + `<style>${readFileSync(path.join(SCRIPT_DIR, 'schema-3d.css'), 'utf8')}</style></head>`;

  const body = [
    '<body>',
    '<canvas id="stage" aria-label="Schema explorer"></canvas>',
    `<p id="nowebgl" hidden>This browser has no WebGL, so the 3D explorer cannot draw. `
      + `The same schema is in <a href="index.html#schema">the flat diagram</a>.</p>`,
    '<header id="bar">',
    `<h1>${e((db.title as string) ?? 'Database')}</h1>`,
    '<input id="find" type="search" placeholder="Filter tables and columns" aria-label="Filter tables and columns">',
    '<label for="hubs">Hub edges</label>',
    '<select id="hubs"><option value="all">All</option><option value="muted">Muted</option>'
      + '<option value="hidden">Hidden</option></select>',
    '<button id="reset" type="button">Reset view</button>',
    '<div id="chips" role="group" aria-label="Domains"></div>',
    '</header>',
    '<aside id="panel" hidden aria-label="Selection detail"></aside>',
    '<div id="tip" hidden role="tooltip"></div>',
    '<div id="live" class="sr" aria-live="polite"></div>',
    `<footer id="foot">Generated from <code>${e(source)}</code> on ${localToday()}</footer>`,
    `<script>window.SCHEMA3D=${jsonForScript(model)};<\/script>`,
    `<script>${vendorThree(path.join(SCRIPT_DIR, '..', 'node_modules', 'three'))}<\/script>`,
    `<script>${inlineModule('schema-3d-layout.js')}<\/script>`,
    `<script>${inlineModule('schema-3d-app.js')}<\/script>`,
    '</body></html>',
  ].join('\n');

  writeFileSync(path.join(outdir, 'schema-3d.html'), `${head}\n${body}\n`);
}
```

In `main()`, after the `writeHtml(...)` call:

```ts
  writeSchema3d(outdir, tables, extras, narratives, findings, schemaPath);
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test 2>&1 | grep -A3 "writeSchema3d"
npm run typecheck
```

Expected: six passing tests. The "carries the model, the layout and the app" test will still fail
until Task 6 creates `schema-3d-app.js` and `schema-3d.css` — create both as one-line placeholders
now (`/* app */` and `/* css */`) so this task's tests pass, and fill them in Task 6.

- [ ] **Step 5: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/scripts/ skills/archlens-postgres/test/archlens.test.ts
git commit -m "feat(archlens): write schema-3d.html as a fourth output"
```

---

### Task 6: The scene

**Files:**
- Create: `<skill>/scripts/schema-3d.css`
- Create: `<skill>/scripts/schema-3d-app.js`

**Read `docs/specs/2026-09-02-webgl-schema-explorer.md`, section "Scene", before starting.** It is the
behaviour contract — cards, arcs, hover, click, movement, search, chips, deep links, accessibility,
no-WebGL, look — and it is not repeated here. This task builds exactly what it lists and nothing more.

The app is a classic script, so `node --check` is the only mechanical gate; the real gate is Step 7's
headed browser pass. Build it in the six sub-steps below rather than in one go, checking the page in a
browser after each — a 3D scene that renders nothing gives you no stack trace to work from.

**Contract the app must honour** (the writer and the tests depend on these, nothing else):

- Reads `window.SCHEMA3D` and calls `layout(window.SCHEMA3D)` from the inlined layout module.
- Owns only the elements the writer emits: `#stage`, `#nowebgl`, `#bar`, `#find`, `#hubs`, `#reset`,
  `#chips`, `#panel`, `#tip`, `#live`, `#foot`.
- On no WebGL: `#stage` hidden, `#nowebgl` shown, and it returns without throwing.
- Deep links: reads `#t=<table>` and `#fk=<child>.<column>` on load — the `#fk` form is exactly the
  arc `id` the layout builds — and rewrites `location.hash` on every selection.
- `prefers-reduced-motion`: no idle rotation, no damping, instant flights.

- [ ] **Step 1: The stylesheet**

Create `<skill>/scripts/schema-3d.css`. Dark only: background `#0e1116`, translucent dark plates,
domain colours come from the model, not the CSS. A `.sr` class that hides the live region visually
but not from a screen reader. Fixed bar across the top, panel down the right, tooltip absolutely
positioned, footer bottom-left. No web fonts — a system stack.

- [ ] **Step 2: Scene, camera, controls, and the no-WebGL exit**

Renderer, `PerspectiveCamera`, `OrbitControls` with damping, fog from 90 to 220, zoom clamped 4 to 180,
polar angle capped just under the horizon. Resize handler. Guard the whole thing: if
`new THREE.WebGLRenderer()` throws or the context is null, show `#nowebgl` and return.

Check: open the generated file, see an empty dark scene you can orbit, no console errors.

- [ ] **Step 3: Islands and cards**

For each island, a translucent plate and a title. For each table, a slab `1.8 × 0.16 × 1.1` in the
domain colour at its laid-out position, plus a camera-facing name label. A table carrying an error
finding gets a red mark, a warning an amber one.

Check: the sample's 19 tables in six islands, readable from the home view.

- [ ] **Step 4: Arcs**

One `QuadraticBezierCurve3` per arc from `from` through `ctrl` to `to`, in the child's domain colour,
with a dot at the parent end. Dashed when the key carries an `fk-index` finding. Opacity 0.7 inside an
island, 0.45 across. A `loop` arc is a circle of radius 0.8 above its card.

Check: every foreign key drawn, no line passing through a card it does not belong to.

- [ ] **Step 5: Picking, panel, and focus mode**

Raycast against cards and arcs on pointer move for hover; on click, select. Selecting a table fades
everything but it, its arcs and its neighbours to 0.08 and fills `#panel` per the spec. Selecting an
arc fills the panel with the relationship detail. Esc and `#reset` clear.

Check: click a table, click one of its arcs, press Esc.

- [ ] **Step 6: Search, chips, deep links, flights, accessibility**

The `#find` box fades non-matching tables and Enter flies to the first match; `/` focuses it. Domain
chips isolate and toggle, with an "all" chip. Double-click flies (800 ms, eased, time-based, exact end
pose). Hash read on load and written on selection. `#live` announces selections. Idle rotation until
the first pointer, wheel or key event, and none at all under `prefers-reduced-motion`.

- [ ] **Step 7: Syntax check and the headed browser pass**

```bash
node --check scripts/schema-3d-app.js && echo "APP SYNTAX OK"
npm run review -- examples/sample-schema.sql --narratives examples/narratives.json --out /tmp/3d-check
open /tmp/3d-check/schema-3d.html
```

Every one of these must hold, in a real window, with the console open:

- Zero console errors or warnings.
- Orbit, pan and zoom all work; the camera never goes below the ground.
- Click one table: focus mode, panel correct against `schema.json`.
- Click one arc: the relationship panel matches what `README.md` says in words for that key.
- Open `schema-3d.html#t=tenant` in a fresh tab: it opens focused and flown to `tenant`.
- Resize the window: nothing clips, the bar and panel stay usable.
- Repeat all of it on `test/fixtures/edge-cases.out`.

- [ ] **Step 8: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/scripts/schema-3d-app.js skills/archlens-postgres/scripts/schema-3d.css
git commit -m "feat(archlens): the 3D scene, its picking, panel and deep links"
```

---

### Task 7: Link the explorer from the flat docs

**Files:**
- Modify: `<skill>/scripts/archlens.ts` (`writeHtml` around line 1853, `writeMarkdown` diagram section)
- Test: `<skill>/test/archlens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('links to the 3D explorer', () => {
  let out = '';
  before(() => {
    out = mkdtempSync(path.join(tmpdir(), 'db-links-'));
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/archlens.ts',
      'examples/sample-schema.sql', '--narratives', 'examples/narratives.json', '--out', out],
      { cwd: root, encoding: 'utf8' });
  });
  after(() => rmSync(out, { recursive: true, force: true }));

  it('opens the explorer from the Schema section', () => {
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(html.includes('href="schema-3d.html"'), 'no explorer link in the Schema section');
    assert.ok(html.includes('Open the 3D explorer'));
  });

  it('gives every table section its own View in 3D link', () => {
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    const model = JSON.parse(readFileSync(path.join(out, 'schema.json'), 'utf8'));
    for (const name of Object.keys(model.tables)) {
      assert.ok(html.includes(`href="schema-3d.html#t=${name}"`), `${name} has no View in 3D link`);
    }
  });

  it('links the explorer from the generated README', () => {
    const md = readFileSync(path.join(out, 'README.md'), 'utf8');
    assert.ok(md.includes('schema-3d.html'), 'no explorer link in README.md');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test 2>&1 | grep -A3 "links to the 3D explorer"
```

Expected: three failures.

- [ ] **Step 3: Write the implementation**

In `writeHtml`, the Schema section (currently line 1853) becomes:

```ts
  body.push(`<section id="schema"><h2>Schema</h2>`
    + `<p class="lead"><a href="schema-3d.html">Open the 3D explorer</a> to rotate this diagram `
    + `and click any table or relationship.</p>`
    + `<div class="erd-wrap">${svgErd(tables, [...tables.keys()])}</div></section>`);
```

In the per-table section (line 1815), the header gains the link. Find the `<header>` the section
emits and append, after the table's `<h3>`:

```ts
      + `<a class="in3d" href="schema-3d.html#t=${e(t.name)}">View in 3D</a>`
```

In `writeMarkdown`, in the Diagram section that embeds `erd.svg`, add one line beneath the image:

```ts
  lines.push('', '[Open the 3D explorer](schema-3d.html) to rotate this diagram and click any table.');
```

Add to the page CSS in `writeHtml`'s `<style>` block:

```css
.in3d{float:right;font-size:12px;font-weight:400}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test 2>&1 | grep -A3 "links to the 3D explorer"
```

Expected: three passing. **The two golden tests now fail** — that is correct, and Task 9 accepts them.

- [ ] **Step 5: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/scripts/archlens.ts skills/archlens-postgres/test/archlens.test.ts
git commit -m "feat(archlens): link the 3D explorer from index.html and README.md"
```

---

### Task 8: Ratchets across every output

**Files:**
- Modify: `<skill>/test/archlens.test.ts` (the `goldenRun` helper, around line 50)

- [ ] **Step 1: Extend the existing Mermaid ratchet**

The helper already walks every written file. Widen the assertion so `schema-3d.html` cannot regress
the "loads nothing from the web" rule for any fixture:

```ts
    // The ratchets: no output file may mention Mermaid, and none may reach the network.
    it('emits no Mermaid and loads nothing from the web', () => {
      const written = readdirSync(out, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
      assert.ok(written.length >= files.length);
      for (const f of written) {
        const text = readFileSync(f, 'utf8');
        assert.ok(!text.toLowerCase().includes('mermaid'), `${f} mentions Mermaid`);
        assert.ok(!/src="http/i.test(text), `${f} loads a script from the web`);
        assert.ok(!/href="http/i.test(text), `${f} links a stylesheet from the web`);
        assert.ok(!/importmap/i.test(text), `${f} uses an import map`);
      }
    });
```

Add `'schema-3d.html'` to the `files` array of **both** `goldenRun` calls.

- [ ] **Step 2: Run and watch the golden comparison fail for the right reason**

```bash
npm test 2>&1 | grep -E "schema-3d.html|loads nothing"
```

Expected: the ratchet passes; `writes schema-3d.html identical to …` fails because no golden exists yet.

- [ ] **Step 3: Commit — ASK STEVE FIRST**

```bash
git add skills/archlens-postgres/test/archlens.test.ts
git commit -m "test(archlens): ratchet every output against loading from the web"
```

---

### Task 9: Regenerate the goldens

**Files:**
- Modify: `examples/out/*`, `test/fixtures/edge-cases.out/*`

- [ ] **Step 1: Regenerate both fixtures**

```bash
cd skills/archlens-postgres
npm run review -- examples/sample-schema.sql --narratives examples/narratives.json --out examples/out
npm run review -- test/fixtures/edge-cases.sql --narratives test/fixtures/edge-cases.narratives.json \
  --out test/fixtures/edge-cases.out
```

Both exit 1. That is expected — both fixtures carry deliberate flaws.

- [ ] **Step 2: Read the diff before accepting a byte of it**

```bash
git diff --stat examples/out test/fixtures/edge-cases.out
git diff -- examples/out/README.md examples/out/index.html | head -80
```

Expected, and nothing else:
- `schema-3d.html` new in both directories, about 0.8 MB each.
- `index.html` gains one Schema-section link and one `View in 3D` per table section.
- `README.md` gains one line under the diagram.
- `FINDINGS.md`, `schema.json`, `erd.svg` and every `domains/*` file **unchanged**.

**If `schema.json` or `FINDINGS.md` moved, stop.** A changed finding count means this branch altered a
check, which it must not. The spec is explicit: both fixtures stay at `8 error, 18 warn, 12 info` and
`9 error, 8 warn, 11 info`.

- [ ] **Step 3: Confirm the counts by running the suite**

```bash
npm test 2>&1 | tail -8
```

Expected: every test passes, including both `writes schema-3d.html identical to …` comparisons.

- [ ] **Step 4: Commit — ASK STEVE FIRST**

```bash
git add examples/out test/fixtures/edge-cases.out
git commit -m "test(archlens): regenerate both goldens with the 3D explorer"
```

---

### Task 10: Full gate

**Files:** none.

- [ ] **Step 1: The whole suite, the typechecker, and both plugin manifests**

```bash
cd skills/archlens-postgres && npm test 2>&1 | tail -5 && npm run typecheck
cd ../.. && claude plugin validate . && claude plugin validate skills/archlens-postgres
```

Expected: all tests pass, `tsc` silent, both validations pass.

- [ ] **Step 2: Prove the bare run — no narratives at all**

```bash
cd skills/archlens-postgres
npm run review -- examples/sample-schema.sql --out /tmp/3d-bare --fail-on never
grep -c 'depth-' /tmp/3d-bare/schema-3d.html
open /tmp/3d-bare/schema-3d.html
```

Expected: a non-zero count, and a scene of depth-keyed islands that orbits and clicks like the
narrated one. This is the case the spec calls out and the easiest one to break.

---

### Task 11: Docs and the version bump

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `<skill>/README.md`, `<skill>/SKILL.md`, `CHANGELOG.md`
- Modify: `.claude-plugin/marketplace.json` (two fields), `.claude-plugin/plugin.json`,
  `<skill>/.claude-plugin/plugin.json`, `<skill>/package.json`

- [ ] **Step 1: Write the docs**

- `CLAUDE.md`: a paragraph in "How the script is put together" on the fourth writer and the vendoring
  rewrite — five statements, why the re-export is deleted rather than rewritten, and the `three.cjs`
  fallback. Add `schema-3d.html` to the rendering paragraph and the new test groups to "Testing".
- Root `README.md`: `schema-3d.html` in the output list.
- `<skill>/README.md`: the output tree, and a note that `npm install` now pulls a second runtime
  dependency.
- `<skill>/SKILL.md`: step 5 mentions the explorer as an output.
- `CHANGELOG.md`: a 1.7.0 entry.

**Run the `no-ai-slop` skill over every paragraph before saving.** These are docs that ship.

- [ ] **Step 2: Bump the version in all five fields**

```bash
cd ~/dev/git-repos/github/techno-8/db-3d-explorer
sed -i '' 's/"version": "1.6.0"/"version": "1.7.0"/' \
  .claude-plugin/plugin.json skills/archlens-postgres/.claude-plugin/plugin.json \
  skills/archlens-postgres/package.json
sed -i '' 's/"version": "1.6.0"/"version": "1.7.0"/g' .claude-plugin/marketplace.json
grep -rn '"version"' .claude-plugin/*.json skills/archlens-postgres/.claude-plugin/plugin.json \
  skills/archlens-postgres/package.json
```

Expected: five lines, all `1.7.0`. Users only receive an update when the plugin entry's version moves,
so a missed field ships nothing.

- [ ] **Step 3: Validate again after the bump**

```bash
claude plugin validate . && claude plugin validate skills/archlens-postgres
```

- [ ] **Step 4: Commit — ASK STEVE FIRST**

```bash
git add -A
git commit -m "docs(archlens): document the 3D explorer and release 1.7.0"
```

- [ ] **Step 5: Push and open the pull request — ASK STEVE FIRST**

```bash
git push -u origin feat/schema-3d-explorer
gh pr create --title "A rotatable 3D explorer for large schemas (v1.7.0)" --body "…"
```

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| Behaviour change 1 — new `schema-3d.html`, every run, with or without narratives | 5, 10 (bare run) |
| Behaviour change 2 — `index.html` explorer link and per-table `View in 3D` | 7 |
| Behaviour change 3 — generated `README.md` links it | 7 |
| Behaviour change 4 — `three` pinned at 0.185.1 | 1 |
| The file — order of contents, no `http`, footer line | 5, 8 |
| Vendoring Three.js — the rewrite, the sandbox test, the `three.cjs` fallback note | 2 |
| The model JSON — shape, colours, `words`, `why`, finding attachment, hubs, `unclaimed`, `depth-N` | 3 |
| Layout — islands, ring radius, grid, arcs, hubs | 4 |
| Scene — cards, arcs, hover, click, movement, search, chips, deep links, accessibility, no-WebGL, look | 6 |
| What does not change — findings, `schema.json`, `erd.svg`, printability | 9 (diff gate) |
| Tests 1–7 | 2, 3, 4, 5, 7, 8, 9 |
| Docs | 11 |
| Sequencing and release — worktree, `.gitignore`, version in four files, `claude plugin validate` | 0, 1, 10, 11 |

**Type consistency:** `schema3dModel()` returns `{domains, tables, fks, hubs}`; `layout()` consumes exactly
that and returns `{islands, positions, arcs, depths, bounds, radius}`; the arc `id` is
`` `${child}.${columns.join('+')}` `` in Task 4, asserted in Task 4's test, and read by the `#fk=` deep link
in Task 6. `writeSchema3d(outdir, tables, extras, narratives, findings, source)` matches its call in `main()`.

**Known gap, deliberate:** Task 6 gives the app a contract and the spec's behaviour list rather than line-by-line
code. A 1,500-line WebGL app written blind into a plan document would be fiction; its gate is the headed browser
pass in Task 6 Step 7, which is a stricter check than any assertion this suite can make.
