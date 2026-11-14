// Geometry core: grid maths, box solids (via Manifold), label text, plate packing, 3MF writing.
// Pure module – libraries are injected with initGeometry() so it can run in the browser or in Node.

let M = null;      // manifold wasm module ({Manifold, CrossSection})
let FONT = null;   // opentype.js Font (optional – labels are skipped without it)

export function initGeometry(manifoldWasm, font) {
  M = manifoldWasm;
  FONT = font || null;
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** Split a drawer length into cell sizes of `step` mm, absorbing the remainder. */
export function axisCells(length, step, mode) {
  const n = Math.max(1, Math.floor(length / step + 1e-9));
  const rem = length - n * step;
  let sizes;
  if (mode === 'even') {
    sizes = Array(n).fill(length / n);
  } else { // 'edges' – first and last cell grow
    sizes = Array(n).fill(step);
    if (n === 1) sizes[0] = length;
    else { sizes[0] += rem / 2; sizes[n - 1] += rem / 2; }
  }
  const bounds = [0];
  for (const s of sizes) bounds.push(bounds[bounds.length - 1] + s);
  return { n, sizes, bounds };
}

export function makeGrid(drawerW, drawerD, step, mode) {
  return { x: axisCells(drawerW, step, mode), y: axisCells(drawerD, step, mode) };
}

/** Bounding rectangle (drawer coords) of a set of cells, before clearance. */
export function cellsBounds(cells, grid) {
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [i, j] of cells) {
    i0 = Math.min(i0, i); i1 = Math.max(i1, i);
    j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  return {
    i0, i1, j0, j1,
    x0: grid.x.bounds[i0], x1: grid.x.bounds[i1 + 1],
    y0: grid.y.bounds[j0], y1: grid.y.bounds[j1 + 1],
  };
}

/** True when all cells form one 4-connected group. */
export function isConnected(cells) {
  if (cells.length === 0) return false;
  const key = (i, j) => i + ',' + j;
  const set = new Set(cells.map(([i, j]) => key(i, j)));
  const seen = new Set([key(...cells[0])]);
  const stack = [cells[0]];
  while (stack.length) {
    const [i, j] = stack.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(i + di, j + dj);
      if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push([i + di, j + dj]); }
    }
  }
  return seen.size === set.size;
}

// ---------------------------------------------------------------------------
// Box solid
// ---------------------------------------------------------------------------

/** The run of cells along the front (lowest j) edge that carries the label tab. */
export function frontRun(cells) {
  const minJ = Math.min(...cells.map(c => c[1]));
  const row = cells.filter(c => c[1] === minJ).map(c => c[0]).sort((a, b) => a - b);
  // longest contiguous run in that row
  let best = [row[0], row[0]], cur = [row[0], row[0]];
  for (let k = 1; k < row.length; k++) {
    if (row[k] === cur[1] + 1) cur[1] = row[k]; else cur = [row[k], row[k]];
    if (cur[1] - cur[0] > best[1] - best[0]) best = [...cur];
  }
  return { j: minJ, i0: best[0], i1: best[1] };
}

function textCrossSection(text, size) {
  // Lay glyphs out by hand (avoids opentype.js feature-table quirks with some fonts).
  const scale = size / FONT.unitsPerEm;
  const commands = [];
  let x = 0, prev = null;
  for (const ch of Array.from(text)) {
    const g = FONT.charToGlyph(ch);
    if (prev) x += FONT.getKerningValue(prev, g) * scale;
    commands.push(...g.getPath(x, 0, size).commands);
    x += (g.advanceWidth || 0) * scale;
    prev = g;
  }
  const path = { commands };
  const polys = [];
  let cur = null, px = 0, py = 0;
  const N = 6;
  const push = (x, y) => { cur.push([x, -y]); px = x; py = y; };
  for (const c of path.commands) {
    if (c.type === 'M') { if (cur && cur.length > 2) polys.push(cur); cur = []; push(c.x, c.y); }
    else if (c.type === 'L') push(c.x, c.y);
    else if (c.type === 'Q') {
      const x0 = px, y0 = py;
      for (let s = 1; s <= N; s++) {
        const t = s / N, u = 1 - t;
        push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === 'C') {
      const x0 = px, y0 = py;
      for (let s = 1; s <= N; s++) {
        const t = s / N, u = 1 - t;
        push(u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
             u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
      }
    } else if (c.type === 'Z') { if (cur && cur.length > 2) polys.push(cur); cur = null; }
  }
  if (cur && cur.length > 2) polys.push(cur);
  if (!polys.length) return null;
  return new M.CrossSection(polys, 'NonZero');
}

/** Triangular prism along X: cross-section points [[y,z],...] (CCW seen from +X). */
function prismX(pts, x0, x1, k) {
  // extrude in Z then rotate so that (u,v,w) -> (w,u,v)
  const cs = k(new M.CrossSection([pts], 'Positive'));
  return k(k(cs.extrude(x1 - x0)).rotate([90, 0, 90])).translate([x0, 0, 0]);
}

/**
 * Build one box. Returns a Manifold in drawer coordinates (x right, y back, z up).
 * opts: {height, wall, base, clearance, label, labelTabs, tabDepth, textRelief, textStyle}
 * textStyle 'engraved' cuts the label into the tab; 'raised' stands it proud of the tab, flush with the rim.
 */
export function buildBox(cells, grid, opts) {
  const tmp = [];                                   // wasm objects to free afterwards
  const k = o => { tmp.push(o); return o; };
  try { return buildBoxInner(cells, grid, opts, k); }
  finally { for (const o of tmp) { try { o.delete(); } catch (e) { /* already freed */ } } }
}

function buildBoxInner(cells, grid, opts, k) {
  const { wall, base, clearance } = opts;
  const H = opts.height;
  const rects = cells.map(([i, j]) => {
    const x0 = grid.x.bounds[i], x1 = grid.x.bounds[i + 1];
    const y0 = grid.y.bounds[j], y1 = grid.y.bounds[j + 1];
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  });
  const footprint = k(new M.CrossSection(rects, 'NonZero'));      // union of cells
  const outer = k(footprint.offset(-clearance / 2, 'Miter'));
  const inner = k(outer.offset(-wall, 'Miter'));
  let solid = k(outer.extrude(H)).subtract(k(k(inner.extrude(H)).translate([0, 0, base])));

  if (opts.labelTabs) {
    const run = frontRun(cells);
    const x0 = grid.x.bounds[run.i0] + clearance / 2 + wall;
    const x1 = grid.x.bounds[run.i1 + 1] - clearance / 2 - wall;
    const yIn = grid.y.bounds[run.j] + clearance / 2 + wall;
    const innerDepth = (grid.y.bounds[run.j + 1] - grid.y.bounds[run.j]) - clearance - 2 * wall;
    const d = Math.min(opts.tabDepth, innerDepth * 0.45);
    const text = (opts.label || '').trim();
    const relief = text && FONT ? opts.textRelief : 0;
    const engrave = opts.textStyle !== 'raised';
    const zt = engrave ? H : H - relief;         // tab top: flush with the rim (engraved) or below it (raised text sits on it)
    // Triangle: flat top, 45° underside running back into the wall -> prints without support.
    const ov = Math.min(0.5, wall * 0.5);        // overlap into the wall so it fuses
    const tri = [[yIn - ov, zt], [yIn - ov, zt - d - ov], [yIn + d, zt]];
    const tab = k(prismX(tri, x0, x1, k));
    solid = k(solid).add(tab);

    if (relief > 0) {
      const margin = 2;
      let size = Math.min(d * 0.72, 10.5);    // em size; 0.72 keeps the cut clear of the thin back edge of the tab
      let cs = textCrossSection(text, size);
      if (cs) k(cs);
      if (cs) {
        let b = cs.bounds();
        const availW = (x1 - x0) - 2 * margin;
        const w = b.max[0] - b.min[0];
        if (w > availW) {
          const s = availW / w;
          cs = k(cs.scale([s, s]));
          b = cs.bounds();
        }
        const cx = (x0 + x1) / 2 - (b.min[0] + b.max[0]) / 2;
        const cy = yIn + d / 2 - (b.min[1] + b.max[1]) / 2;
        if (engrave) {
          // cut the letters down into the tab; limit the depth so the thin back edge of the tab is never cut through
          const depth = Math.min(relief, d * 0.12);
          const cut = k(k(k(cs.translate([cx, cy])).extrude(depth + 0.5)).translate([0, 0, zt - depth]));
          solid = k(solid).subtract(cut);
        } else {
          const txt = k(k(k(cs.translate([cx, cy])).extrude(relief)).translate([0, 0, zt]));
          solid = k(solid).add(txt);
        }
      }
    }
  }
  return solid;
}

/** Manifold -> {positions Float32Array, indices Uint32Array}. */
export function toMesh(manifold) {
  const mesh = manifold.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    positions[v * 3] = mesh.vertProperties[v * np];
    positions[v * 3 + 1] = mesh.vertProperties[v * np + 1];
    positions[v * 3 + 2] = mesh.vertProperties[v * np + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

// ---------------------------------------------------------------------------
// Plate packing (MaxRects, best short side fit, 90° rotation allowed)
// ---------------------------------------------------------------------------

class MaxRectsBin {
  constructor(w, h) { this.w = w; this.h = h; this.free = [{ x: 0, y: 0, w, h }]; }
  find(w, h, rule = 'bssf') {
    let best = null;
    for (const f of this.free) {
      for (const [rw, rh, rot] of [[w, h, false], [h, w, true]]) {
        if (rw <= f.w + 1e-6 && rh <= f.h + 1e-6) {
          const ss = rule === 'bl' ? f.y + rh : Math.min(f.w - rw, f.h - rh);
          const ls = rule === 'bl' ? f.x : Math.max(f.w - rw, f.h - rh);
          if (!best || ss < best.ss || (ss === best.ss && ls < best.ls))
            best = { x: f.x, y: f.y, w: rw, h: rh, rot, ss, ls };
        }
      }
    }
    return best;
  }
  place(r) {
    const out = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) { out.push(f); continue; }
      if (r.x > f.x) out.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) out.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
      if (r.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) out.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
    }
    // prune contained rectangles
    this.free = out.filter((a, ia) => !out.some((b, ib) => ib !== ia &&
      a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h &&
      (ib < ia || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)));
  }
}

/**
 * items: [{id, w, h}] (footprint mm). bed: {w, h, margin, gap}.
 * Returns {plates: [[{id, x, y, rot}]], oversize: [id]} – x/y = lower-left corner of the footprint on the bed.
 */
export function packPlates(items, bed) {
  const usableW = bed.w - 2 * bed.margin + bed.gap, usableH = bed.h - 2 * bed.margin + bed.gap;
  const fits = it => (it.w + bed.gap <= usableW && it.h + bed.gap <= usableH) ||
                     (it.h + bed.gap <= usableW && it.w + bed.gap <= usableH);
  const oversize = items.filter(it => !fits(it)).map(it => it.id);
  const ok = items.filter(fits);
  const sorts = [
    (a, b) => (b.w * b.h) - (a.w * a.h) || Math.max(b.w, b.h) - Math.max(a.w, a.h),
    (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h),
    (a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h) || Math.max(b.w, b.h) - Math.max(a.w, a.h),
    (a, b) => (b.w + b.h) - (a.w + a.h),
  ];
  let best = null;
  for (const srt of sorts) {
    for (const rule of ['bssf', 'bl']) {
      const res = packWith([...ok].sort(srt), usableW, usableH, bed, rule);
      const score = res.length * 1e6 - (res.length ? res[res.length - 1].length : 0);
      if (!best || score < best.score) best = { plates: res, score };
    }
  }
  return { plates: best ? best.plates : [], oversize };
}

function packWith(todo, usableW, usableH, bed, rule) {
  const bins = [];
  for (const it of todo) {
    let placed = false;
    for (const bin of bins) {
      const r = bin.find(it.w + bed.gap, it.h + bed.gap, rule);
      if (r) { bin.place(r); bin.items.push({ id: it.id, x: bed.margin + r.x, y: bed.margin + r.y, rot: r.rot }); placed = true; break; }
    }
    if (!placed) {
      const bin = new MaxRectsBin(usableW, usableH); bin.items = [];
      const r = bin.find(it.w + bed.gap, it.h + bed.gap, rule);
      bin.place(r); bin.items.push({ id: it.id, x: bed.margin + r.x, y: bed.margin + r.y, rot: r.rot });
      bins.push(bin);
    }
  }
  return bins.map(b => b.items);
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** objects: [{name, positions, indices}] already placed in bed coordinates. Returns files map for zipping. */
export function make3MF(objects, title) {
  let body = '';
  objects.forEach((o, k) => {
    const id = k + 1;
    const p = o.positions, t = o.indices;
    const verts = [];
    for (let v = 0; v < p.length; v += 3)
      verts.push(`<vertex x="${+p[v].toFixed(4)}" y="${+p[v + 1].toFixed(4)}" z="${+p[v + 2].toFixed(4)}"/>`);
    const tris = [];
    for (let f = 0; f < t.length; f += 3) tris.push(`<triangle v1="${t[f]}" v2="${t[f + 1]}" v3="${t[f + 2]}"/>`);
    body += `<object id="${id}" name="${xmlEsc(o.name)}" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>\n`;
  });
  const items = objects.map((_, k) => `<item objectid="${k + 1}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${xmlEsc(title)}</metadata>
<metadata name="Application">Drawer Box Maker</metadata>
<resources>
${body}</resources>
<build>${items}</build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return { '[Content_Types].xml': contentTypes, '_rels/.rels': rels, '3D/3dmodel.model': model };
}

/** Move a mesh (drawer coords) so its footprint's lower-left sits at (x,y) on the bed, optionally rotated 90°. */
export function placeMesh(mesh, fp, place) {
  const src = mesh.positions, out = new Float32Array(src.length);
  for (let v = 0; v < src.length; v += 3) {
    let x = src[v] - fp.x0, y = src[v + 1] - fp.y0;
    if (place.rot) { const w = fp.y1 - fp.y0; [x, y] = [w - y, x]; }
    out[v] = x + place.x; out[v + 1] = y + place.y; out[v + 2] = src[v + 2];
  }
  return { positions: out, indices: mesh.indices };
}
