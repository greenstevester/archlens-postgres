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
