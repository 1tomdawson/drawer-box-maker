import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ManifoldModule from 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js';
import * as opentype from 'https://cdn.jsdelivr.net/npm/opentype.js@2.0.0/dist/opentype.mjs';
import { zipSync, strToU8, deflateSync, inflateSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';
import * as G from './geometry.js';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.3.0/files/roboto-latin-700-normal.woff';
const CELL = 50;                                   // grid pitch, mm
const BED = { w: 340, h: 320, margin: 3 };         // Bambu Lab H2S
const PRESETS = { large: { w: 675, d: 425 }, small: { w: 400, d: 425 } };
const DEFAULT_SETTINGS = {
  height: 60, wall: 1, base: 3, clearance: 0.5, stretch: 'edges',
  labelTabs: true, tabDepth: 12, textRelief: 0.6, textStyle: 'engraved', plateGap: 2,
};

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = null;
let selection = new Set();          // box ids
let undoStack = [];
let fontReady = false;

function freshState(preset = 'large', w = PRESETS.large.w, d = PRESETS.large.d, settings = DEFAULT_SETTINGS) {
  const s = { v: 1, drawer: { preset, w, d }, settings: { ...settings }, boxes: [], nextId: 1 };
  fillSingles(s);
  return s;
}

function fillSingles(s) {
  const g = gridOf(s);
  s.boxes = [];
  for (let j = 0; j < g.y.n; j++)
    for (let i = 0; i < g.x.n; i++)
      s.boxes.push({ id: s.nextId++, cells: [[i, j]], height: null, label: '' });
}

function gridOf(s) { return G.makeGrid(s.drawer.w, s.drawer.d, CELL, s.settings.stretch); }
const grid = () => gridOf(state);

function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 100) undoStack.shift();
}
function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  selection = new Set([...selection].filter(id => state.boxes.some(b => b.id === id)));
  changed();
}

function emptyCells(s = state) {
  const g = gridOf(s);
  const used = new Set(s.boxes.flatMap(b => b.cells.map(c => c.join(','))));
  const out = [];
  for (let j = 0; j < g.y.n; j++) for (let i = 0; i < g.x.n; i++)
    if (!used.has(i + ',' + j)) out.push([i, j]);
  return out;
}

function boxHeight(b) { return b.height ?? state.settings.height; }
function boxDims(b) {
  const r = G.cellsBounds(b.cells, grid());
  const c = state.settings.clearance;
  return { w: r.x1 - r.x0 - c, h: r.y1 - r.y0 - c, r };
}
function fitsBed(w, h) {
  const uw = BED.w - 2 * BED.margin, uh = BED.h - 2 * BED.margin;
  return (w <= uw && h <= uh) || (h <= uw && w <= uh);
}
const isOversize = b => { const d = boxDims(b); return !fitsBed(d.w, d.h); };
const fmt = n => (Math.round(n * 10) / 10).toString();
const boxName = b => (b.label && b.label.trim()) || `Box ${fmt(boxDims(b).w)}x${fmt(boxDims(b).h)} #${b.id}`;

// ---------------------------------------------------------------------------
// Persistence: localStorage, share links, files
// ---------------------------------------------------------------------------
function compact(s) {
  const nx = gridOf(s).x.n;
  return {
    v: 1, p: s.drawer.preset, w: s.drawer.w, d: s.drawer.d, s: s.settings,
    b: s.boxes.map(b => {
      const o = { c: b.cells.map(([i, j]) => i + j * nx) };
      if (b.height != null) o.h = b.height;
      if (b.label) o.l = b.label;
      return o;
    }),
  };
}
function expand(o) {
  const s = { v: 1, drawer: { preset: o.p, w: +o.w, d: +o.d }, settings: { ...DEFAULT_SETTINGS, ...o.s }, boxes: [], nextId: 1 };
  const g = gridOf(s), nx = g.x.n;
  const used = new Set();
  for (const b of o.b || []) {
    const cells = b.c.map(k => [k % nx, Math.floor(k / nx)]).filter(([i, j]) => j < g.y.n && !used.has(i + ',' + j));
    if (!cells.length) continue;
    cells.forEach(([i, j]) => used.add(i + ',' + j));
    s.boxes.push({ id: s.nextId++, cells, height: b.h ?? null, label: b.l || '' });
  }
  // cells with no box are left empty on purpose (deleted boxes); only a file with no box list gets filled
  if (!Array.isArray(o.b)) fillSingles(s);
  return s;
}
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

function encodeLayout() { return b64u(deflateSync(strToU8(JSON.stringify(compact(state))), { level: 9 })); }
function decodeLayout(str) { return expand(JSON.parse(new TextDecoder().decode(inflateSync(unb64u(str))))); }

function persist() { try { localStorage.setItem('drawerBoxMaker', JSON.stringify(compact(state))); } catch (e) { /* storage unavailable */ } }

function loadInitial() {
  const m = location.hash.match(/[#&]l=([A-Za-z0-9_-]+)/);
  if (m) {
    try { const s = decodeLayout(m[1]); history.replaceState(null, '', location.pathname + location.search); return s; }
    catch (e) { console.warn('Bad share link', e); toast('That share link could not be read, so a fresh layout was started.'); }
  }
  try {
    const raw = localStorage.getItem('drawerBoxMaker');
    if (raw) return expand(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return freshState();
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
function busy(msg) { $('busyMsg').textContent = msg; $('busy').classList.add('on'); }
function idle() { $('busy').classList.remove('on'); }
const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

let activeTab = 'editor';
function changed({ geometry = true } = {}) {
  persist();
  if (geometry) previewDirty = true;
  renderSidebar();
  renderEditor();
  if (activeTab === 'plates') renderPlates();
  if (activeTab === 'preview') renderPreview();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
function renderSidebar() {
  const { drawer, settings } = state;
  document.querySelectorAll('#presetSeg button').forEach(b => b.classList.toggle('on', b.dataset.preset === drawer.preset));
  $('customBox').hidden = drawer.preset !== 'custom';
  $('drawerW').value = drawer.w; $('drawerD').value = drawer.d;
  const g = grid();
  const remX = drawer.w - g.x.n * CELL, remY = drawer.d - g.y.n * CELL;
  const nEmpty = emptyCells().length;
  let gi = `<b>${g.x.n} × ${g.y.n}</b> grid · ${g.x.n * g.y.n} cells${nEmpty ? ` · ${nEmpty} left empty` : ''}`;
  if (remX > 0.01 || remY > 0.01) {
    gi += settings.stretch === 'edges'
      ? `<br><span class="hint">Leftover ${fmt(remX)} × ${fmt(remY)} mm is taken up by the outer boxes (edge cells ${fmt(g.x.sizes[0])} × ${fmt(g.y.sizes[0])} mm).</span>`
      : `<br><span class="hint">Leftover space is shared out: every cell is ${fmt(g.x.sizes[0])} × ${fmt(g.y.sizes[0])} mm.</span>`;
  }
  $('gridInfo').innerHTML = gi;

  $('setHeight').value = settings.height;
  $('setTabs').value = settings.labelTabs ? '1' : '0';
  $('setWall').value = settings.wall;
  $('setBase').value = settings.base;
  $('setClear').value = settings.clearance;
  $('setStretch').value = settings.stretch;
  $('setTabDepth').value = settings.tabDepth;
  $('setRelief').value = settings.textRelief;
  $('setTextStyle').value = settings.textStyle === 'raised' ? 'raised' : 'engraved';
  $('setGap').value = settings.plateGap;

  // selection panel
  const sel = state.boxes.filter(b => selection.has(b.id));
  const p = $('selPanel');
  if (!sel.length) {
    p.innerHTML = `<p class="hint">Click a box to select it, or drag across several. Then use <b>Merge</b> to join them into one bigger box, or <b>Delete</b> to leave that part of the drawer empty. Shift-click adds to the selection.${nEmpty ? ' Click an empty space to put a box back.' : ''}</p>`;
  } else {
    const one = sel.length === 1 ? sel[0] : null;
    const heights = [...new Set(sel.map(b => b.height))];
    const hv = heights.length === 1 && heights[0] != null ? heights[0] : '';
    let html = '';
    if (one) {
      const d = boxDims(one);
      html += `<p class="info"><b>${fmt(d.w)} × ${fmt(d.h)} mm</b> footprint · ${one.cells.length} cell${one.cells.length > 1 ? 's' : ''}${G.isConnected(one.cells) && isRect(one.cells) ? '' : ' · custom shape'}</p>`;
    } else {
      html += `<p class="info"><b>${sel.length} boxes</b> selected</p>`;
    }
    html += `<label class="row"><span>Height <small>mm</small></span><input type="number" id="selHeight" min="10" step="1" placeholder="${state.settings.height} (default)" value="${hv}"></label>`;
    if (one) html += `<label class="row"><span>Label text</span><input type="text" id="selLabel" maxlength="24" placeholder="e.g. M3 bolts" value="${escapeAttr(one.label)}"></label>`;
    if (one && !state.settings.labelTabs) html += `<p class="hint">Label tabs are switched off under “All boxes”.</p>`;
    if (one && one.label && !fontReady) html += `<p class="hint">Font still loading: text will be added when it's ready.</p>`;
    const over = sel.filter(isOversize);
    if (over.length) html += `<div class="warn">Too big for the H2S bed (340 × 320 mm). Split it, or make it 6 cells or fewer on its longest side.</div>`;
    p.innerHTML = html;
    $('selHeight').addEventListener('change', e => {
      const v = e.target.value.trim() === '' ? null : Math.max(10, +e.target.value);
      snapshot(); sel.forEach(b => { b.height = v; }); changed();
    });
    if (one) $('selLabel').addEventListener('change', e => { snapshot(); one.label = e.target.value.slice(0, 24); changed(); });
  }

  $('btnMerge').disabled = sel.length < 2;
  $('btnSplit').disabled = !sel.some(b => b.cells.length > 1);
  $('btnDelete').disabled = !sel.length;
  $('btnUndo').disabled = !undoStack.length;

  // print summary
  const pk = packing();
  const over = state.boxes.filter(isOversize);
  $('printInfo').innerHTML = `<b>${state.boxes.length}</b> boxes → <b>${pk.plates.length}</b> print plate${pk.plates.length === 1 ? '' : 's'} on the H2S`;
  $('printWarn').innerHTML = over.length
    ? `<div class="warn">${over.length} box${over.length > 1 ? 'es are' : ' is'} too big for the print bed and won't be exported: ${over.map(b => escapeHtml(boxName(b))).join(', ')}.</div>`
    : (pk.plates.length > 1 ? `<div class="note">This drawer needs ${pk.plates.length} print sessions, so you'll get ${pk.plates.length} files.</div>` : '');
  $('status').textContent = `${state.drawer.w} × ${state.drawer.d} mm drawer · ${state.boxes.length} box${state.boxes.length === 1 ? '' : 'es'}${nEmpty ? ` · ${nEmpty} empty space${nEmpty === 1 ? '' : 's'}` : ''}`;
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escapeAttr = escapeHtml;
function isRect(cells) {
  const r = G.cellsBounds(cells, grid());
  return (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1) === cells.length;
}

// ---------------------------------------------------------------------------
// Layout editor (top view, front of drawer at the bottom)
// ---------------------------------------------------------------------------
let svg = null, dragging = null;

function renderEditor() {
  const host = $('editor');
  const { w, d } = state.drawer;
  const g = grid();
  const pad = 14;
  host.innerHTML = '';
  svg = el('svg', { viewBox: `${-pad} ${-pad} ${w + 2 * pad} ${d + 2 * pad + 12}`, preserveAspectRatio: 'xMidYMid meet' }, host);
  const Y = y => d - y;        // flip so the drawer front is at the bottom

  el('rect', { x: -4, y: -4, width: w + 8, height: d + 8, rx: 6, fill: '#d9d3c7' }, svg);
  el('rect', { x: 0, y: 0, width: w, height: d, fill: '#fbfaf8' }, svg);

  const owner = new Map();
  state.boxes.forEach(b => b.cells.forEach(([i, j]) => owner.set(i + ',' + j, b)));

  // empty spaces (deleted boxes): click one to put a 50 mm box back
  for (const [i, j] of emptyCells()) {
    const eg = el('g', { class: 'empty' }, svg);
    el('rect', {
      x: g.x.bounds[i] + 3, y: Y(g.y.bounds[j + 1]) + 3, width: g.x.sizes[i] - 6, height: g.y.sizes[j] - 6, rx: 3,
      fill: 'transparent', stroke: '#b9b3a7', 'stroke-width': 1, 'stroke-dasharray': '4 4',
    }, eg);
    const t = el('text', { x: (g.x.bounds[i] + g.x.bounds[i + 1]) / 2, y: Y((g.y.bounds[j] + g.y.bounds[j + 1]) / 2) + 5,
      'text-anchor': 'middle', 'font-size': 15, fill: '#a39d91', 'pointer-events': 'none' }, eg);
    t.textContent = '+';
    el('title', {}, eg).textContent = 'Empty space: click to add a box';
  }

  for (const b of state.boxes) {
    const selected = selection.has(b.id), over = isOversize(b);
    const fill = over ? (selected ? '#f7b4b4' : 'var(--bad-soft)') : selected ? 'var(--sel-soft)' : 'var(--box)';
    const gEl = el('g', { 'data-box': b.id }, svg);
    for (const [i, j] of b.cells) {
      el('rect', {
        x: g.x.bounds[i], y: Y(g.y.bounds[j + 1]), width: g.x.sizes[i], height: g.y.sizes[j],
        fill, 'data-cell': `${i},${j}`,
      }, gEl);
      // faint internal grid line inside merged boxes
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const nb = owner.get((i + di) + ',' + (j + dj));
        if (nb === b) {
          const x0 = di ? g.x.bounds[i + 1] : g.x.bounds[i], x1 = g.x.bounds[i + 1];
          const y0 = dj ? g.y.bounds[j + 1] : g.y.bounds[j], y1 = g.y.bounds[j + 1];
          el('line', { x1: x0, y1: Y(y0), x2: di ? x0 : x1, y2: Y(dj ? y0 : y1), stroke: '#0000000f', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, gEl);
        }
      }
    }
    // outline: every cell edge not shared with the same box
    const inset = 1.6;
    const stroke = over ? 'var(--bad)' : selected ? 'var(--sel)' : 'var(--box-edge)';
    let dpath = '';
    for (const [i, j] of b.cells) {
      const x0 = g.x.bounds[i] + inset, x1 = g.x.bounds[i + 1] - inset;
      const y0 = g.y.bounds[j] + inset, y1 = g.y.bounds[j + 1] - inset;
      const has = (di, dj) => owner.get((i + di) + ',' + (j + dj)) === b;
      const L = has(-1, 0), R = has(1, 0), D = has(0, -1), U = has(0, 1);
      const X0 = L ? g.x.bounds[i] : x0, X1 = R ? g.x.bounds[i + 1] : x1;
      const Y0 = D ? g.y.bounds[j] : y0, Y1 = U ? g.y.bounds[j + 1] : y1;
      if (!D) dpath += `M${X0} ${Y(y0)}H${X1}`;
      if (!U) dpath += `M${X0} ${Y(y1)}H${X1}`;
      if (!L) dpath += `M${x0} ${Y(Y0)}V${Y(Y1)}`;
      if (!R) dpath += `M${x1} ${Y(Y0)}V${Y(Y1)}`;
      // inner corners (concave) need short joins
      if (L && D && !has(-1, -1)) dpath += `M${g.x.bounds[i]} ${Y(y0)}H${x0}V${Y(g.y.bounds[j])}`;
      if (R && D && !has(1, -1)) dpath += `M${g.x.bounds[i + 1]} ${Y(y0)}H${x1}V${Y(g.y.bounds[j])}`;
      if (L && U && !has(-1, 1)) dpath += `M${g.x.bounds[i]} ${Y(y1)}H${x0}V${Y(g.y.bounds[j + 1])}`;
      if (R && U && !has(1, 1)) dpath += `M${g.x.bounds[i + 1]} ${Y(y1)}H${x1}V${Y(g.y.bounds[j + 1])}`;
    }
    el('path', { d: dpath, fill: 'none', stroke, 'stroke-width': selected ? 2.4 : 1.4, 'stroke-linecap': 'square', 'pointer-events': 'none' }, gEl);

    // text: label (or size) in the first front cell, height if not default
    const run = G.frontRun(b.cells);
    const cx = (g.x.bounds[run.i0] + g.x.bounds[run.i1 + 1]) / 2;
    const cy = (g.y.bounds[run.j] + g.y.bounds[run.j + 1]) / 2;
    const dm = boxDims(b);
    const main = b.label || (b.cells.length > 1 ? `${fmt(dm.w)}×${fmt(dm.h)}` : '');
    if (main) {
      const t = el('text', { x: cx, y: Y(cy) + 3, 'text-anchor': 'middle', 'font-size': 9.5, fill: over ? 'var(--bad)' : '#3b3f45', 'font-weight': b.label ? 600 : 400, 'pointer-events': 'none' }, gEl);
      t.textContent = main.length > 18 ? main.slice(0, 17) + '…' : main;
    }
    if (b.height != null && b.height !== state.settings.height) {
      const t = el('text', { x: cx, y: Y(cy) + 14, 'text-anchor': 'middle', 'font-size': 7.5, fill: '#6b6f76', 'pointer-events': 'none' }, gEl);
      t.textContent = `h ${b.height}`;
    }
  }
  const f = el('text', { x: w / 2, y: d + 18, 'text-anchor': 'middle', 'font-size': 10, fill: '#6b6f76' }, svg);
  f.textContent = `▼ front of drawer · ${w} × ${d} mm`;

  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
}

function cellAt(evt) {
  const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const g = grid(); const x = p.x, y = state.drawer.d - p.y;
  if (x < 0 || y < 0 || x > state.drawer.w || y > state.drawer.d) return null;
  let i = g.x.bounds.findIndex(v => v > x) - 1, j = g.y.bounds.findIndex(v => v > y) - 1;
  if (i < 0) i = g.x.n - 1; if (j < 0) j = g.y.n - 1;
  return [i, j];
}
const boxAtCell = c => c && state.boxes.find(b => b.cells.some(([i, j]) => i === c[0] && j === c[1]));

let pendingAdd = null;               // empty cell pressed; a box is added if the pointer is released on it
function onDown(e) {
  pendingAdd = null;
  const c = cellAt(e), b = boxAtCell(c);
  if (!b) {
    if (c) pendingAdd = c;
    else if (!e.shiftKey) { selection.clear(); changed({ geometry: false }); }
    return;
  }
  svg.setPointerCapture(e.pointerId);
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  dragging = { start: b.id, moved: false, mode: selection.has(b.id) ? 'remove' : 'add', additive, base: new Set(selection) };
}
function onMove(e) {
  if (!dragging) return;
  const b = boxAtCell(cellAt(e));
  if (!b) return;
  if (b.id !== dragging.start || dragging.moved) {
    if (!dragging.moved) {
      dragging.moved = true;
      if (!dragging.additive) { dragging.base = new Set(); dragging.mode = 'add'; }
      dragging.touched = new Set([dragging.start]);
    }
    dragging.touched.add(b.id);
    selection = new Set(dragging.base);
    dragging.touched.forEach(id => dragging.mode === 'add' ? selection.add(id) : selection.delete(id));
    renderEditor(); renderSidebar();
  }
}
function onUp(e) {
  if (pendingAdd) {
    const c = e.type === 'pointerup' ? cellAt(e) : null, p = pendingAdd;
    pendingAdd = null;
    if (c && c[0] === p[0] && c[1] === p[1] && !boxAtCell(c)) addBox(c);
    return;
  }
  if (!dragging) return;
  if (!dragging.moved) {
    const id = dragging.start;
    if (dragging.additive) { selection.has(id) ? selection.delete(id) : selection.add(id); }
    else if (selection.size === 1 && selection.has(id)) selection.clear();
    else selection = new Set([id]);
  }
  dragging = null;
  changed({ geometry: false });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function merge() {
  const sel = state.boxes.filter(b => selection.has(b.id));
  if (sel.length < 2) return;
  const cells = sel.flatMap(b => b.cells);
  if (!G.isConnected(cells)) { toast('Those boxes don’t touch, so they can’t be merged into one box.'); return; }
  snapshot();
  const hs = sel.map(b => b.height).filter(h => h != null);
  const nb = { id: state.nextId++, cells, height: hs.length ? Math.max(...hs) : null, label: sel.map(b => b.label).find(l => l) || '' };
  state.boxes = state.boxes.filter(b => !selection.has(b.id)).concat(nb);
  selection = new Set([nb.id]);
  const d = boxDims(nb);
  if (!fitsBed(d.w, d.h)) toast(`Heads up: ${fmt(d.w)} × ${fmt(d.h)} mm is too big for the H2S bed.`);
  changed();
}
function split() {
  const sel = state.boxes.filter(b => selection.has(b.id) && b.cells.length > 1);
  if (!sel.length) return;
  snapshot();
  const ids = new Set(sel.map(b => b.id)); const added = [];
  for (const b of sel) for (const c of b.cells) added.push({ id: state.nextId++, cells: [c], height: b.height, label: '' });
  state.boxes = state.boxes.filter(b => !ids.has(b.id)).concat(added);
  selection = new Set(added.map(b => b.id));
  changed();
}
function deleteSelected() {
  if (!selection.size) return;
  snapshot();
  const n = selection.size;
  state.boxes = state.boxes.filter(b => !selection.has(b.id));
  selection.clear();
  toast(`Deleted ${n} box${n === 1 ? '' : 'es'}. Click an empty space to put a box back.`);
  changed();
}
function addBox(cell) {
  snapshot();
  const nb = { id: state.nextId++, cells: [cell], height: null, label: '' };
  state.boxes.push(nb);
  selection = new Set([nb.id]);
  changed();
}
function resetLayout(confirmIt = true) {
  if (confirmIt && (emptyCells().length || state.boxes.some(b => b.cells.length > 1 || b.label || b.height != null)) &&
      !confirm('Reset to a full drawer of 50 mm boxes? Merges, labels, heights and empty spaces will be cleared (you can Undo).')) return;
  snapshot(); fillSingles(state); selection.clear(); changed();
}
function setDrawer(preset, w, d) {
  w = Math.max(CELL, Math.round(+w || CELL)); d = Math.max(CELL, Math.round(+d || CELL));
  const oldG = grid();
  const ns = { ...state, drawer: { preset, w, d } };
  const newG = gridOf(ns);
  const wasEmpty = new Set(emptyCells().map(c => c.join(',')));
  snapshot();
  state.drawer = { preset, w, d };
  if (oldG.x.n !== newG.x.n || oldG.y.n !== newG.y.n) {
    // keep boxes that still fit inside the new grid, refill the rest with singles (spaces left empty stay empty)
    const keep = state.boxes.filter(b => b.cells.every(([i, j]) => i < newG.x.n && j < newG.y.n));
    const used = new Set(keep.flatMap(b => b.cells.map(c => c.join(','))));
    state.boxes = keep;
    for (let j = 0; j < newG.y.n; j++) for (let i = 0; i < newG.x.n; i++)
      if (!used.has(i + ',' + j) && !wasEmpty.has(i + ',' + j)) state.boxes.push({ id: state.nextId++, cells: [[i, j]], height: null, label: '' });
    selection.clear();
  }
  changed();
}

// ---------------------------------------------------------------------------
// Geometry (cached per box)
// ---------------------------------------------------------------------------
let manifoldReady = null;
const meshCache = new Map();

function boxKey(b) {
  const g = grid(), s = state.settings;
  const r = G.cellsBounds(b.cells, g);
  return JSON.stringify([b.cells.map(([i, j]) => [g.x.bounds[i], g.y.bounds[j], g.x.sizes[i], g.y.sizes[j]]),
    boxHeight(b), s.wall, s.base, s.clearance, s.labelTabs, s.tabDepth, s.textRelief, s.textStyle, fontReady ? b.label : '', r.x0]);
}
function boxOpts(b) {
  const s = state.settings;
  return { height: boxHeight(b), wall: s.wall, base: s.base, clearance: s.clearance, labelTabs: s.labelTabs,
    tabDepth: s.tabDepth, textRelief: s.textRelief, textStyle: s.textStyle, label: fontReady ? b.label : '' };
}
async function meshFor(b) {
  await manifoldReady;
  const key = boxKey(b);
  if (meshCache.has(key)) return meshCache.get(key);
  const m = G.buildBox(b.cells, grid(), boxOpts(b));
  const mesh = G.toMesh(m);
  m.delete();
  if (meshCache.size > 600) meshCache.clear();
  meshCache.set(key, mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Plates
// ---------------------------------------------------------------------------
function packing() {
  const items = state.boxes.map(b => { const d = boxDims(b); return { id: b.id, w: d.w, h: d.h }; });
  return G.packPlates(items, { w: BED.w, h: BED.h, margin: BED.margin, gap: state.settings.plateGap });
}

function renderPlates() {
  const host = $('plates');
  const pk = packing();
  const byId = new Map(state.boxes.map(b => [b.id, b]));
  const g = grid(), c = state.settings.clearance;
  host.innerHTML = '';
  if (pk.oversize.length) {
    const w = document.createElement('div'); w.className = 'warn'; w.style.marginBottom = '14px';
    w.textContent = `Not on any plate because they're bigger than the bed: ${pk.oversize.map(id => boxName(byId.get(id))).join(', ')}.`;
    host.appendChild(w);
  }
  const wrap = document.createElement('div'); wrap.className = 'grid'; host.appendChild(wrap);
  pk.plates.forEach((items, k) => {
    const card = document.createElement('div'); card.className = 'plate';
    const head = document.createElement('header');
    head.innerHTML = `<span>Plate ${k + 1} of ${pk.plates.length} · ${items.length} box${items.length > 1 ? 'es' : ''}</span>`;
    const btn = document.createElement('button'); btn.textContent = 'Download';
    btn.onclick = () => exportPlates([k]);
    head.appendChild(btn); card.appendChild(head);
    const s = el('svg', { viewBox: `-4 -4 ${BED.w + 8} ${BED.h + 8}` }, card);
    el('rect', { x: 0, y: 0, width: BED.w, height: BED.h, rx: 6, fill: '#2b2f33' }, s);
    for (const it of items) {
      const b = byId.get(it.id), r = G.cellsBounds(b.cells, g);
      const fp = { x0: r.x0 + c / 2, y0: r.y0 + c / 2, x1: r.x1 - c / 2, y1: r.y1 - c / 2 };
      const gg = el('g', {}, s);
      for (const [i, j] of b.cells) {
        let x0 = g.x.bounds[i] + c / 2 - fp.x0, x1 = g.x.bounds[i + 1] - c / 2 - fp.x0;
        let y0 = g.y.bounds[j] + c / 2 - fp.y0, y1 = g.y.bounds[j + 1] - c / 2 - fp.y0;
        if (it.rot) { const H = fp.y1 - fp.y0; [x0, x1, y0, y1] = [H - y1, H - y0, x0, x1]; }
        el('rect', { x: it.x + x0, y: BED.h - (it.y + y1), width: x1 - x0, height: y1 - y0, fill: '#f08c4a', stroke: '#f08c4a', 'stroke-width': 1.2 }, gg);
      }
      const dw = it.rot ? fp.y1 - fp.y0 : fp.x1 - fp.x0, dh = it.rot ? fp.x1 - fp.x0 : fp.y1 - fp.y0;
      if (b.label) {
        const t = el('text', { x: it.x + dw / 2, y: BED.h - (it.y + dh / 2) + 3, 'text-anchor': 'middle', 'font-size': 9, fill: '#1d1f22' }, gg);
        t.textContent = b.label.length > 12 ? b.label.slice(0, 11) + '…' : b.label;
      }
    }
    wrap.appendChild(card);
  });
  if (!pk.plates.length) host.insertAdjacentHTML('beforeend', '<p class="hint">Nothing to print.</p>');
}

async function exportPlates(only = null) {
  const pk = packing();
  if (!pk.plates.length) { toast('Nothing to export.'); return; }
  if (pk.oversize.length && only == null &&
      !confirm(`${pk.oversize.length} box(es) are too big for the bed and will be left out. Continue?`)) return;
  const byId = new Map(state.boxes.map(b => [b.id, b]));
  const g = grid(), c = state.settings.clearance;
  const which = only ?? pk.plates.map((_, k) => k);
  const base = `drawer-${state.drawer.w}x${state.drawer.d}`;
  const files = {};
  try {
    busy('Loading geometry engine…');
    await manifoldReady;
    if (state.boxes.some(b => b.label) && !fontReady) await fontLoad.catch(() => {});
    let done = 0; const total = which.reduce((n, k) => n + pk.plates[k].length, 0);
    for (const k of which) {
      const objs = [];
      for (const it of pk.plates[k]) {
        busy(`Building boxes… ${++done} / ${total}`);
        if (done % 4 === 0) await frame();
        const b = byId.get(it.id), r = G.cellsBounds(b.cells, g);
        const fp = { x0: r.x0 + c / 2, y0: r.y0 + c / 2, x1: r.x1 - c / 2, y1: r.y1 - c / 2 };
        const placed = G.placeMesh(await meshFor(b), fp, it);
        objs.push({ name: boxName(b), ...placed });
      }
      const title = `${base} plate ${k + 1} of ${pk.plates.length}`;
      const parts = G.make3MF(objs, title);
      const z = {}; for (const [n, v] of Object.entries(parts)) z[n] = strToU8(v);
      files[`${base}-plate-${k + 1}-of-${pk.plates.length}.3mf`] = zipSync(z, { level: 6 });
    }
    busy('Packing files…'); await frame();
    const names = Object.keys(files);
    if (names.length === 1) download(names[0], new Blob([files[names[0]]], { type: 'model/3mf' }));
    else download(`${base}-plates.zip`, new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }));
    toast(names.length === 1 ? 'Downloaded 1 plate.' : `Downloaded ${names.length} plates in a zip.`);
  } catch (e) {
    console.error(e); toast('Export failed: ' + e.message);
  } finally { idle(); }
}

// ---------------------------------------------------------------------------
// 3D preview
// ---------------------------------------------------------------------------
let three = null, previewDirty = true, previewBuilding = false;

function initThree() {
  const host = $('preview');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xf4f2ee);
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9284, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-400, -300, 900); scene.add(sun);
  const group = new THREE.Group(); scene.add(group);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xc9bfae }));
  floor.position.z = -0.5; scene.add(floor);
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  const loop = () => { requestAnimationFrame(loop); if (activeTab === 'preview') { controls.update(); renderer.render(scene, camera); } };
  loop();
  three = { renderer, scene, camera, controls, group, floor, resize, framedFor: '' };
}

const MAT = {
  box: new THREE.MeshStandardMaterial({ color: 0xf2ece2, roughness: .7, flatShading: true }),
  sel: new THREE.MeshStandardMaterial({ color: 0x74b0e6, roughness: .6, flatShading: true }),
  bad: new THREE.MeshStandardMaterial({ color: 0xf08080, roughness: .6, flatShading: true }),
};

async function renderPreview() {
  if (!three) initThree();
  three.resize();
  if (previewBuilding) { previewDirty = true; return; }
  const { w, d } = state.drawer;
  three.floor.scale.set(w + 20, d + 20, 1); three.floor.position.set(w / 2, d / 2, -0.5);
  const fk = w + 'x' + d;
  if (three.framedFor !== fk) {
    three.camera.position.set(w * 0.5, -d * 0.55, Math.max(w, d) * 1.05);
    three.controls.target.set(w / 2, d / 2, 0); three.framedFor = fk;
  }
  if (!previewDirty) { recolour(); return; }
  previewBuilding = true; previewDirty = false;
  try {
    await manifoldReady;
    const meshes = [];
    let n = 0;
    for (const b of state.boxes) {
      if (++n % 8 === 0) { $('preview').querySelector('.overlay').textContent = `Building ${n} / ${state.boxes.length}…`; await frame(); }
      const m = await meshFor(b);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, MAT.box); mesh.userData.id = b.id;
      meshes.push(mesh);
    }
    three.group.children.forEach(c => c.geometry.dispose());
    three.group.clear(); meshes.forEach(m => three.group.add(m));
    $('preview').querySelector('.overlay').textContent = 'Drag to rotate · scroll to zoom · selected boxes in blue';
    recolour();
  } catch (e) { console.error(e); toast('3D preview failed: ' + e.message); }
  finally { previewBuilding = false; if (previewDirty && activeTab === 'preview') renderPreview(); }
}
function recolour() {
  const byId = new Map(state.boxes.map(b => [b.id, b]));
  three.group.children.forEach(m => {
    const b = byId.get(m.userData.id);
    m.material = !b ? MAT.box : isOversize(b) ? MAT.bad : selection.has(b.id) ? MAT.sel : MAT.box;
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function numSetting(id, key, min, opts = {}) {
  $(id).addEventListener('change', e => {
    const v = +e.target.value;
    if (!isFinite(v) || v < min) { e.target.value = state.settings[key]; toast(`Must be at least ${min}.`); return; }
    snapshot(); state.settings[key] = v; changed(opts);
  });
}

function wire() {
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    ['editor', 'preview', 'plates'].forEach(t => $(t).classList.toggle('hidden', t !== activeTab));
    if (activeTab === 'preview') renderPreview();
    if (activeTab === 'plates') renderPlates();
  }));
  document.querySelectorAll('#presetSeg button').forEach(b => b.addEventListener('click', () => {
    const p = b.dataset.preset;
    if (p === 'custom') { state.drawer.preset = 'custom'; persist(); renderSidebar(); $('drawerW').focus(); return; }
    setDrawer(p, PRESETS[p].w, PRESETS[p].d);
  }));
  $('drawerW').addEventListener('change', e => setDrawer('custom', e.target.value, state.drawer.d));
  $('drawerD').addEventListener('change', e => setDrawer('custom', state.drawer.w, e.target.value));

  numSetting('setHeight', 'height', 10);
  numSetting('setWall', 'wall', 0.4);
  numSetting('setBase', 'base', 0.6);
  numSetting('setClear', 'clearance', 0);
  numSetting('setTabDepth', 'tabDepth', 5);
  numSetting('setRelief', 'textRelief', 0.2);
  numSetting('setGap', 'plateGap', 1, { geometry: false });
  $('setTabs').addEventListener('change', e => { snapshot(); state.settings.labelTabs = e.target.value === '1'; changed(); });
  $('setTextStyle').addEventListener('change', e => { snapshot(); state.settings.textStyle = e.target.value; changed(); });
  $('setStretch').addEventListener('change', e => { snapshot(); state.settings.stretch = e.target.value; changed(); });

  $('btnMerge').onclick = merge;
  $('btnSplit').onclick = split;
  $('btnDelete').onclick = deleteSelected;
  $('btnAll').onclick = () => { selection = new Set(state.boxes.map(b => b.id)); changed({ geometry: false }); };
  $('btnNone').onclick = () => { selection.clear(); changed({ geometry: false }); };
  $('btnUndo').onclick = undo;
  $('btnReset').onclick = () => resetLayout(true);
  $('btnExport').onclick = () => exportPlates();

  $('btnShare').onclick = async () => {
    const url = location.origin + location.pathname + '#l=' + encodeLayout();
    try { await navigator.clipboard.writeText(url); toast('Share link copied to the clipboard.'); }
    catch (e) { prompt('Copy this link:', url); }
  };
  $('btnSave').onclick = () => download(`drawer-layout-${state.drawer.w}x${state.drawer.d}.json`, JSON.stringify(compact(state), null, 1), 'application/json');
  $('btnOpen').onclick = () => $('fileOpen').click();
  $('fileOpen').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { snapshot(); state = expand(JSON.parse(await f.text())); selection.clear(); changed(); toast('Layout opened.'); }
    catch (err) { toast('That file could not be read.'); }
    e.target.value = '';
  });

  window.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'm' || e.key === 'M') merge();
    else if (e.key === 's' || e.key === 'S') split();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'a' || e.key === 'A') { selection = new Set(state.boxes.map(b => b.id)); changed({ geometry: false }); }
    else if (e.key === 'Escape') { selection.clear(); changed({ geometry: false }); }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let fontLoad;
state = loadInitial();
wire();
changed();

let fontObj = null;
fontLoad = fetch(FONT_URL).then(r => { if (!r.ok) throw new Error('font ' + r.status); return r.arrayBuffer(); })
  .then(buf => { fontObj = opentype.parse(buf); });
manifoldReady = ManifoldModule().then(async wasm => {
  wasm.setup();
  try { await fontLoad; fontReady = true; } catch (e) { console.warn('Label font unavailable', e); }
  G.initGeometry(wasm, fontObj);
  if (fontReady && state.boxes.some(b => b.label)) { previewDirty = true; renderSidebar(); }
});
window.__app = { get state() { return state; }, exportPlates, packing, meshFor, encodeLayout, decodeLayout };
