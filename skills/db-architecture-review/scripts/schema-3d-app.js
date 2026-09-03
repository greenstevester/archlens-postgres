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
  // A link into an already-open page changes only the fragment, which does not reload; follow it.
  // setHash() uses replaceState, which fires no hashchange, so selecting never loops back here.
  addEventListener('hashchange', () => { if (!openHash()) clear(); });
  restyle();
  if (!openHash()) announce(`${M.tables.length} tables in ${L.islands.length} domains. Click a table or a line for its detail.`);
  requestAnimationFrame(tick);
})();
