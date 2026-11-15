import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ParseWorker from './parse-worker.js?worker&inline';
import { store, idFor } from './db.js';

// ---------------------------------------------------------------- helpers
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('skpv.prefs') || '{}'); } catch (_) {}
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('skpv.prefs', JSON.stringify(p)); } catch (_) {} },
  };
})();

// In-page dialog (native alert/confirm are blocked in some hosts and look out of place in the app).
function dialog(msg, { ok = 'OK', cancel = null } = {}) {
  return new Promise((resolve) => {
    const wrap = el('div', 'dlg-wrap');
    const box = el('div', 'dlg');
    box.appendChild(el('div', 'dlg-msg', esc(msg).replace(/\n/g, '<br>')));
    const row = el('div', 'dlg-btns');
    const done = (v) => { wrap.remove(); resolve(v); };
    if (cancel) { const c = el('button', '', esc(cancel)); c.onclick = () => done(false); row.appendChild(c); }
    const o = el('button', 'primary', esc(ok)); o.onclick = () => done(true); row.appendChild(o);
    box.appendChild(row); wrap.appendChild(box);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.body.appendChild(wrap);
  });
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// Lengths come in metres.
function fmtLen(m) {
  const sys = prefs.get('units', 'imperial');
  if (sys === 'metric') {
    if (Math.abs(m) >= 1) return `${m.toFixed(3)} m`;
    return `${(m * 1000).toFixed(0)} mm`;
  }
  const neg = m < 0; let inches = Math.abs(m) / 0.0254;
  let sixteenths = Math.round(inches * 16);
  let ft = Math.floor(sixteenths / 192); sixteenths -= ft * 192;
  let whole = Math.floor(sixteenths / 16); let frac = sixteenths - whole * 16;
  let fracStr = '';
  if (frac) { let n = frac, d = 16; while (n % 2 === 0) { n /= 2; d /= 2; } fracStr = ` ${n}/${d}`; }
  const s = ft ? `${ft}' ${whole}${fracStr}"` : `${whole}${fracStr}"`;
  return (neg ? '-' : '') + s;
}

function skuVersion(v) {
  const m = /\{?(\d+)\./.exec(v || '');
  if (!m) return v || 'unknown';
  const n = +m[1];
  const raw = String(v).replace(/[{}]/g, "");
  return n >= 13 ? `SketchUp 20${String(n).padStart(2, "0")} (${raw})` : `SketchUp ${n} (${raw})`;
}

// ---------------------------------------------------------------- parsing
let worker = null;
let jobId = 0;
function parseInWorker(buffer, onProgress) {
  return new Promise((resolve, reject) => {
    try { worker = worker || new ParseWorker(); } catch (e) { reject(e); return; }
    const id = ++jobId;
    const onMsg = (ev) => {
      const d = ev.data;
      if (d.id !== id) return;
      if (d.type === 'progress') onProgress && onProgress(d.stage, d.cur, d.tot);
      else {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        if (d.type === 'done') resolve(d.result); else reject(new Error(d.message));
      }
    };
    const onErr = (e) => { worker.removeEventListener('message', onMsg); worker = null; reject(e.error || new Error(e.message || 'Worker failed')); };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({ id, buffer }, [buffer]);
  });
}
async function parseFile(buffer, onProgress) {
  const copy = buffer.slice(0); // keep the original for the main-thread fallback
  try {
    return await parseInWorker(copy, onProgress);
  } catch (e) {
    if (e && /skp|parse|tlv|unsupported|invalid|version/i.test(e.message || '')) throw e;
    const { parse } = await import('./parse-worker.js');
    return parse(buffer, onProgress).result;
  }
}

// ---------------------------------------------------------------- renderer
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
let camera = persp;
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a92, 1.25));
for (const cam of [persp, ortho]) {
  // Headlight that follows the camera, slightly above and to the left, like SketchUp.
  const L = new THREE.DirectionalLight(0xffffff, 1.35);
  L.position.set(-0.4, 0.8, 0.6);
  const tgt = new THREE.Object3D(); tgt.position.set(0, 0, -1);
  cam.add(L, tgt); L.target = tgt;
}
scene.add(persp, ortho);
THREE.ColorManagement.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;

let controls = makeControls(camera, new THREE.Vector3());
function makeControls(cam, target) {
  const c = new OrbitControls(cam, canvas);
  c.target.copy(target);
  c.enableDamping = true;
  c.dampingFactor = 0.3; // stops quickly after you lift your finger
  c.screenSpacePanning = true;
  c.zoomToCursor = true;
  c.rotateSpeed = prefs.get('orbitSpeed', 0.7);
  c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  c.addEventListener('change', requestRender);
  c.update();
  return c;
}

let needsRender = true;
function requestRender() { needsRender = true; }

function resize() {
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  persp.aspect = w / h; persp.updateProjectionMatrix();
  setOrthoFrustum(orthoHeight);
  requestRender();
}
let orthoHeight = 10;
function setOrthoFrustum(h) {
  orthoHeight = h;
  const w = canvas.clientWidth || window.innerWidth, hh = canvas.clientHeight || window.innerHeight;
  const a = w / hh;
  ortho.left = (-h * a) / 2; ortho.right = (h * a) / 2; ortho.top = h / 2; ortho.bottom = -h / 2;
  ortho.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

let anim = null;
function tick(t) {
  requestAnimationFrame(tick);
  if (anim) { anim(t); needsRender = true; }
  if (walk.active) { if (walk.step()) needsRender = true; }
  else if (controls.update()) needsRender = true;
  if (!needsRender || !model) return;
  needsRender = false;
  // Keep depth precision sane at any zoom level.
  if (camera === persp) {
    const d = camera.position.distanceTo(controls.target);
    const r = model.radius;
    persp.near = Math.max(Math.min(d, r) / 400, r * 1e-5, 0.002);
    persp.far = Math.max(d + r * 4, persp.near * 1000);
    persp.updateProjectionMatrix();
  } else {
    ortho.near = -model.radius * 20; ortho.far = model.radius * 20; ortho.updateProjectionMatrix();
  }
  updateMarkerScale();
  renderer.render(scene, camera);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- model build
let model = null; // { root, data, radius, center, layerHidden:Set, nodes:[], meshes:[], lines:[] }
const DEFAULT_FRONT = new THREE.Color().setRGB(1, 1, 1, THREE.SRGBColorSpace);
const DEFAULT_BACK = new THREE.Color().setRGB(0.64, 0.70, 0.78, THREE.SRGBColorSpace);
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x111111 });

const style = {
  face: prefs.get('face', 'textured'), // textured | shaded | mono | hidden | xray | wire | tag
  edges: prefs.get('edges', true),
  notes: prefs.get('notes', true), // text labels and dimensions
};

function disposeModel() {
  if (!model) return;
  model.group.traverse((o) => {
    if (o.geometry && !o.userData.sharedGeom) o.geometry.dispose();
  });
  for (const g of model.geometries) g.dispose();
  for (const t of model.textures) t && t.dispose();
  for (const m of model.matCache.values()) m.dispose();
  for (const s of model.labels) s.material.dispose();
  for (const { tex } of model.noteTextures.values()) tex.dispose();
  scene.remove(model.group);
  clearMeasure();
  model = null;
}

function buildModel(data) {
  disposeModel();
  const group = new THREE.Group();
  const geometries = [];

  // Textures
  const textures = data.textures.map((t) => {
    try {
      const blob = new Blob([t.data], { type: t.mimeType });
      const url = URL.createObjectURL(blob);
      const tex = new THREE.TextureLoader().load(url, () => { URL.revokeObjectURL(url); requestRender(); });
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      return tex;
    } catch (_) { return null; }
  });

  // Geometry per mesh resource
  const meshGeoms = {};
  for (const [id, m] of Object.entries(data.meshes)) {
    meshGeoms[id] = m.prims.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      if (p.uvs && p.uvs.length) g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      geometries.push(g);
      return { g, material: p.material };
    });
  }
  const edgeGeoms = {};
  for (const [k, arr] of Object.entries(data.edges)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.computeBoundingSphere();
    geometries.push(g);
    edgeGeoms[k] = g;
  }

  const layerColor = {};
  for (const l of data.layers) layerColor[l.name] = new THREE.Color().setRGB(l.color[0] / 255, l.color[1] / 255, l.color[2] / 255, THREE.SRGBColorSpace);

  const nodes = [];
  const faceMeshes = [];
  const lines = [];
  const mk = (n, parent, depth) => {
    const o = new THREE.Group();
    o.matrixAutoUpdate = false;
    if (n.matrix && n.matrix.length === 16) o.matrix.fromArray(n.matrix);
    o.name = n.name || n.def || '';
    o.userData.node = n;
    n.obj = o;
    n.depth = depth;
    nodes.push(n);
    if (n.mesh && meshGeoms[n.mesh]) {
      for (const { g, material } of meshGeoms[n.mesh]) {
        const md = data.materials[material] || { color: [0.8, 0.8, 0.8], opacity: 1, texture: -1, isDefault: true };
        const front = new THREE.Mesh(g);
        front.userData = { sharedGeom: true, md, side: md.isDefault ? 'front' : 'both', layer: n.layer };
        faceMeshes.push(front);
        o.add(front);
        if (md.isDefault) {
          const back = new THREE.Mesh(g);
          back.userData = { sharedGeom: true, md, side: 'back', layer: n.layer };
          faceMeshes.push(back);
          o.add(back);
        }
      }
    }
    if (n.edges && edgeGeoms[n.edges]) {
      const ls = new THREE.LineSegments(edgeGeoms[n.edges], EDGE_MAT);
      ls.userData = { sharedGeom: true, isEdge: true };
      lines.push(ls);
      o.add(ls);
    }
    parent.add(o);
    for (const c of n.children) mk(c, o, depth + 1);
  };
  mk(data.root, group, 0);
  scene.add(group);
  group.updateMatrixWorld(true);

  const box = new THREE.Box3();
  if (data.bounds) box.set(new THREE.Vector3(...data.bounds.min), new THREE.Vector3(...data.bounds.max));
  else box.setFromObject(group);
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const sphere = box.getBoundingSphere(new THREE.Sphere());

  model = {
    data, group, nodes, faceMeshes, lines, geometries, textures, layerColor,
    box, center: sphere.center, radius: Math.max(sphere.radius, 0.05),
    layerHidden: new Set(data.layers.filter((l) => l.hidden).map((l) => l.name)),
    matCache: new Map(),
    hiddenNodes: new Set(),
    // Callouts: the label sprites, the groups holding them per node, and the
    // canvas textures they share.
    labels: [],
    dimLabels: [],
    noteGroups: [],
    noteTextures: new Map(),
    noteCount: 0,
    noteOverflow: false,
  };
  buildNotes();
  applyStyle();
  applyVisibility();
  return model;
}

function materialFor(md, side, layer) {
  const f = style.face;
  const key = `${f}|${side}|${md.color}|${md.opacity}|${md.texture}|${md.isDefault}|${f === 'tag' ? layer : ''}`;
  let m = model.matCache.get(key);
  if (m) return m;
  const threeSide = side === 'front' ? THREE.FrontSide : side === 'back' ? THREE.BackSide : THREE.DoubleSide;
  let color;
  if (f === 'hidden') color = DEFAULT_FRONT;
  else if (f === 'mono' || md.isDefault) color = side === 'back' ? DEFAULT_BACK : DEFAULT_FRONT;
  else color = new THREE.Color().setRGB(md.color[0], md.color[1], md.color[2], THREE.SRGBColorSpace);
  if (f === 'tag') color = side === 'back' ? DEFAULT_BACK : (model.layerColor[layer] || DEFAULT_FRONT).clone();
  const params = {
    color, side: threeSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  };
  if (f === 'textured' && md.texture >= 0 && model.textures[md.texture]) {
    params.map = model.textures[md.texture];
    params.color = new THREE.Color(1, 1, 1);
    if (md.mask) params.alphaTest = 0.5;
  }
  if (f === 'xray') { params.transparent = true; params.opacity = 0.45; params.depthWrite = false; }
  else if (md.opacity < 0.999 && f !== 'mono' && f !== 'hidden') { params.transparent = true; params.opacity = md.opacity; params.depthWrite = false; }
  m = f === 'hidden' ? new THREE.MeshBasicMaterial(params) : new THREE.MeshLambertMaterial(params);
  model.matCache.set(key, m);
  return m;
}

function applyStyle() {
  if (!model) return;
  for (const m of model.faceMeshes) {
    m.material = materialFor(m.userData.md, m.userData.side, m.userData.layer);
    m.visible = style.face !== 'wire';
    m.renderOrder = m.material.transparent ? 1 : 0;
  }
  const showEdges = style.edges || style.face === 'wire' || style.face === 'hidden';
  for (const l of model.lines) l.visible = showEdges;
  requestRender();
}

function applyVisibility() {
  if (!model) return;
  for (const n of model.nodes) {
    const isRoot = n === model.data.root;
    const tagHidden = !isRoot && n.layer !== 'Layer0' && model.layerHidden.has(n.layer);
    n.obj.visible = !tagHidden && !model.hiddenNodes.has(n);
  }
  applyNoteVisibility();
  requestRender();
}

// ---------------------------------------------------------------- callouts
// SketchUp's text labels and dimensions are screen-space things: the text keeps
// its size on screen however far away the model is, so it is drawn as a
// billboard sprite with a canvas-rendered label rather than as 3D geometry.
// Nothing here needs a font file - the canvas uses the phone's own UI font -
// which is also why it behaves the same in Chrome and in the Android WebView.
const NOTE_FONT_PX = 13;
const NOTE_PAD_X = 5;
const NOTE_PAD_Y = 3;
const NOTE_LINE = 1.25;
const NOTE_WRAP = 30;       // characters, before a long line is broken
const NOTE_MAX_LINES = 6;
const MAX_NOTES = 1500;     // a sanity cap; no real plan set comes close
const NOTE_LINE_MAT = new THREE.LineBasicMaterial({ color: 0x1a1a1a, depthTest: false, transparent: true, opacity: 0.85 });

function wrapNote(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw;
    if (!line.length) { out.push(''); continue; }
    while (line.length > NOTE_WRAP) {
      let cut = line.lastIndexOf(' ', NOTE_WRAP);
      if (cut <= 0) cut = NOTE_WRAP;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, '');
    }
    out.push(line);
  }
  if (out.length > NOTE_MAX_LINES) { out.length = NOTE_MAX_LINES; out[NOTE_MAX_LINES - 1] += '…'; }
  return out;
}

// A label drawn once into a canvas and kept as a texture. Dark text on a pale
// plate, so it stays readable over dark materials, bright textures and sky
// alike - a bare glyph is unreadable on a phone over a busy model.
function noteTexture(text) {
  const cached = model.noteTextures.get(text);
  if (cached) return cached;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const lines = wrapNote(text);
  const probe = document.createElement('canvas').getContext('2d');
  const font = `600 ${NOTE_FONT_PX}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  probe.font = font;
  let textW = 0;
  for (const l of lines) textW = Math.max(textW, probe.measureText(l).width);
  const cssW = Math.ceil(textW + NOTE_PAD_X * 2);
  const cssH = Math.ceil(lines.length * NOTE_FONT_PX * NOTE_LINE + NOTE_PAD_Y * 2);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(cssW * dpr));
  cv.height = Math.max(1, Math.round(cssH * dpr));
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.font = font;
  g.textBaseline = 'middle';
  const r = 3;
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(cssW, 0, cssW, cssH, r);
  g.arcTo(cssW, cssH, 0, cssH, r);
  g.arcTo(0, cssH, 0, 0, r);
  g.arcTo(0, 0, cssW, 0, r);
  g.closePath();
  g.fillStyle = 'rgba(255,255,252,0.9)';
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = '#14181c';
  lines.forEach((l, i) => g.fillText(l, NOTE_PAD_X, NOTE_PAD_Y + NOTE_FONT_PX * NOTE_LINE * (i + 0.5)));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const made = { tex, w: cssW, h: cssH };
  model.noteTextures.set(text, made);
  return made;
}

// `anchor` picks which part of the label sits on the point: [0,0.5] hangs it to
// the right, [1,0.5] to the left, [0.5,0] above, [0.5,0.5] centred.
function noteSprite(text, position, anchor, parentScale) {
  const { tex, w, h } = noteTexture(text);
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.position.copy(position);
  s.center.set(anchor[0], anchor[1]);
  s.renderOrder = 20;
  // Sprites with sizeAttenuation off take their size from the world matrix, so
  // a scaled component would blow its labels up with it. Divide that back out.
  // `sharedGeom` keeps disposeModel off three.js's own shared sprite geometry.
  s.userData = { sharedGeom: true, note: { px: w, py: h, sx: parentScale.x, sy: parentScale.y } };
  model.labels.push(s);
  return s;
}

function noteLine(points) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  model.geometries.push(g);
  const l = new THREE.Line(g, NOTE_LINE_MAT);
  l.userData = { sharedGeom: true }; // disposed via model.geometries
  l.renderOrder = 19;
  return l;
}

// Build one node's callouts. Called after the world matrices are known, so a
// dimension inside a scaled component can report the length it really measures.
function addNotes(n) {
  const group = model.data.annotations && model.data.annotations.byDef[n.notes];
  if (!group) return;
  const world = n.obj.matrixWorld;
  const colScale = (i) => new THREE.Vector3().setFromMatrixColumn(world, i).length() || 1;
  const parentScale = new THREE.Vector2(colScale(0), colScale(1));
  // How much a local length is stretched by the chain of transforms above.
  const lengthScale = (colScale(0) + colScale(1) + colScale(2)) / 3;
  // One group per callout, so each can follow its own tag.
  const item = (layer) => {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    n.obj.add(g);
    model.noteGroups.push({ obj: g, layer: layer || 'Layer0' });
    model.noteCount++;
    return g;
  };

  for (const t of group.texts) {
    if (t.hidden) continue;
    if (model.labels.length >= MAX_NOTES) { model.noteOverflow = true; break; }
    const at = new THREE.Vector3(...t.point);
    const lead = new THREE.Vector3(...t.leader);
    const end = at.clone().add(lead);
    // The leader vector is in the model's own axes; in screen terms "right"
    // just means a positive run, which is what decides the label's side.
    const anchor = lead.lengthSq() < 1e-12 ? [0.5, 0] : lead.x >= 0 ? [0, 0.5] : [1, 0.5];
    const g = item(t.layer);
    if (t.showLeader && lead.lengthSq() > 1e-12) g.add(noteLine([at, end]));
    g.add(noteSprite(t.text, end, anchor, parentScale));
  }

  for (const d of group.dims) {
    if (d.hidden) continue;
    if (model.labels.length >= MAX_NOTES) { model.noteOverflow = true; break; }
    const a = new THREE.Vector3(...d.a);
    const b = new THREE.Vector3(...d.b);
    const off = new THREE.Vector3(...d.offset);
    const a2 = a.clone().add(off);
    const b2 = b.clone().add(off);
    const g = item(d.layer);
    g.add(noteLine([a2, b2]));
    // Witness lines back to what is being measured, as SketchUp draws them.
    if (off.lengthSq() > 1e-12) { g.add(noteLine([a, a2])); g.add(noteLine([b, b2])); }
    const length = a.distanceTo(b) * lengthScale;
    const s = noteSprite(fmtLen(length), a2.clone().add(b2).multiplyScalar(0.5), [0.5, 0.5], parentScale);
    s.userData.dimLength = length;
    model.dimLabels.push(s);
    g.add(s);
  }
}

function buildNotes() {
  for (const n of model.nodes) if (n.notes) addNotes(n);
  applyNoteVisibility();
}

function applyNoteVisibility() {
  if (!model) return;
  for (const { obj, layer } of model.noteGroups) {
    obj.visible = style.notes && !(layer !== 'Layer0' && model.layerHidden.has(layer));
  }
}

// Dimension text is generated from the measured length, so it has to be redrawn
// when the user switches between feet-and-inches and metric.
function relabelDimensions() {
  if (!model) return;
  for (const s of model.dimLabels) {
    const { tex, w, h } = noteTexture(fmtLen(s.userData.dimLength));
    s.material.map = tex;
    s.material.needsUpdate = true;
    s.userData.note.px = w;
    s.userData.note.py = h;
  }
  requestRender();
}

// ---------------------------------------------------------------- camera
function setCamera(kind) {
  const target = controls.target.clone();
  const from = camera;
  if (kind === 'ortho' && from === persp) {
    const d = persp.position.distanceTo(target);
    setOrthoFrustum(2 * d * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)));
    ortho.position.copy(persp.position); ortho.quaternion.copy(persp.quaternion); ortho.up.copy(persp.up);
    ortho.zoom = 1; ortho.updateProjectionMatrix();
    camera = ortho;
  } else if (kind === 'persp' && from === ortho) {
    const h = orthoHeight / ortho.zoom;
    const d = h / 2 / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    const dir = new THREE.Vector3().subVectors(ortho.position, target).normalize();
    persp.position.copy(target).addScaledVector(dir, d); persp.up.copy(ortho.up);
    camera = persp;
  } else return;
  controls.dispose();
  controls = makeControls(camera, target);
  prefs.set('camera', kind);
  requestRender();
}

function animateCamera(toPos, toTarget, toUp, ms = 450, onDone) {
  const p0 = camera.position.clone(), t0 = controls.target.clone(), u0 = camera.up.clone();
  const up1 = (toUp || camera.up).clone();
  let start = null;
  anim = (t) => {
    if (start === null) start = t;
    let k = Math.min(1, (t - start) / ms);
    k = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(p0, toPos, k);
    controls.target.lerpVectors(t0, toTarget, k);
    camera.up.lerpVectors(u0, up1, k).normalize();
    camera.lookAt(controls.target);
    if (k >= 1) { anim = null; controls.update(); onDone && onDone(); }
  };
}

function fitBox(box, dir, up, instant) {
  const center = box.getCenter(new THREE.Vector3());
  const d0 = dir ? dir.clone().normalize() : new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  const u = (up || (Math.abs(d0.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0))).clone();
  // Camera basis for this view direction.
  const right = new THREE.Vector3().crossVectors(u, d0).normalize();
  const upv = new THREE.Vector3().crossVectors(d0, right).normalize();
  const aspect = persp.aspect || 1;
  const tv = Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2), th = tv * aspect;
  let dist = 0, maxX = 0, maxY = 0;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    const x = Math.abs(c.dot(right)), y = Math.abs(c.dot(upv)), z = c.dot(d0);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    dist = Math.max(dist, x / th + z, y / tv + z);
  }
  const r = Math.max(model ? model.radius * 0.02 : 0.05, 0.05);
  dist = Math.max(dist * 1.08, r * 3);
  const pos = center.clone().addScaledVector(d0, dist);
  if (camera === ortho) {
    setOrthoFrustum(Math.max(2 * maxY, (2 * maxX) / aspect, r) * 1.1);
    ortho.zoom = 1; ortho.updateProjectionMatrix();
  }
  if (instant) {
    camera.position.copy(pos); controls.target.copy(center); camera.up.copy(u); camera.lookAt(center); controls.update();
    requestRender();
  } else animateCamera(pos, center, u);
}

const VIEWS = {
  Iso: [1, 0.8, 1], Top: [0, 1, 0], Bottom: [0, -1, 0], Front: [0, 0, 1], Back: [0, 0, -1], Left: [-1, 0, 0], Right: [1, 0, 0],
};
function stdView(name) {
  if (!model) return;
  if (walk.active) setWalk(false);
  const d = new THREE.Vector3(...VIEWS[name]);
  const up = name === 'Top' ? new THREE.Vector3(0, 0, -1) : name === 'Bottom' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  fitBox(model.box, d, up);
}

function goToScene(i) {
  const p = model.data.pages[i];
  if (!p) return;
  if (walk.active) setWalk(false);
  model.layerHidden = new Set(p.hiddenLayers || []);
  applyVisibility();
  document.querySelectorAll('#scenes button').forEach((b, j) => b.classList.toggle('on', j === i));
  if (!p.eye || !p.target) return;
  const eye = new THREE.Vector3(...p.eye), target = new THREE.Vector3(...p.target);
  const up = p.up ? new THREE.Vector3(...p.up).normalize() : new THREE.Vector3(0, 1, 0);
  if (p.parallel) {
    setCamera('ortho');
    if (p.orthoHeight) { setOrthoFrustum(p.orthoHeight); ortho.zoom = 1; ortho.updateProjectionMatrix(); }
  } else {
    setCamera('persp');
    if (p.fov) { persp.fov = Math.max(10, Math.min(100, p.fov)); persp.updateProjectionMatrix(); }
  }
  animateCamera(eye, target, up, 600);
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
function ndc(x, y) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
}
function toScreen(v) {
  const r = canvas.getBoundingClientRect();
  const p = v.clone().project(camera);
  return new THREE.Vector2((p.x + 1) / 2 * r.width + r.left, (1 - p.y) / 2 * r.height + r.top);
}
function visibleInTree(o) {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}
function pick(x, y, snap) {
  if (!model) return null;
  raycaster.setFromCamera(ndc(x, y), camera);
  raycaster.params.Line.threshold = model.radius * 0.004;
  const targets = style.face === 'wire' ? model.lines : model.faceMeshes;
  const hits = raycaster.intersectObjects(targets.filter(visibleInTree), false);
  if (!hits.length) return null;
  const h = hits[0];
  const point = h.point.clone();
  if (!snap) return { point, snapped: false };
  // Snap to the nearest corner of the face (or line) that was hit.
  const cands = [];
  const pos = h.object.geometry.attributes.position;
  if (h.face) for (const i of [h.face.a, h.face.b, h.face.c]) cands.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld));
  if (h.index != null && h.object.isLineSegments) {
    const i = h.index - (h.index % 2);
    cands.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld));
    cands.push(new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(h.object.matrixWorld));
  }
  const tap = new THREE.Vector2(x, y);
  let best = null, bestD = 28;
  for (const c of cands) { const d = toScreen(c).distanceTo(tap); if (d < bestD) { bestD = d; best = c; } }
  return best ? { point: best, snapped: true } : { point, snapped: false };
}

// ---------------------------------------------------------------- measure
const measure = { on: false, pts: [], group: new THREE.Group() };
scene.add(measure.group);
const markerMat = new THREE.PointsMaterial({ color: 0xc8102e, size: 12, sizeAttenuation: false, depthTest: false });
const mLineMat = new THREE.LineBasicMaterial({ color: 0xc8102e, depthTest: false });

// Keep every callout label the same size on screen, whatever the zoom. A sprite
// with sizeAttenuation off is sized in camera units, so convert the label's
// pixel size into those units for the camera in use. The factor works out the
// same for width and height, which is why the aspect ratio doesn't appear.
function updateMarkerScale() {
  if (!model || !model.labels.length || !style.notes) return;
  const h = canvas.clientHeight || window.innerHeight;
  if (!h) return;
  const k = camera === persp
    ? (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / h
    : orthoHeight / (h * (ortho.zoom || 1));
  for (const s of model.labels) {
    const d = s.userData.note;
    s.scale.set((d.px * k) / d.sx, (d.py * k) / d.sy, 1);
  }
}
function clearMeasure() {
  measure.pts = [];
  while (measure.group.children.length) { const c = measure.group.children.pop(); c.geometry && c.geometry.dispose(); }
  renderHud();
  requestRender();
}
function drawMeasure() {
  while (measure.group.children.length) { const c = measure.group.children.pop(); c.geometry && c.geometry.dispose(); }
  if (!measure.pts.length) return;
  const g = new THREE.BufferGeometry().setFromPoints(measure.pts);
  const pts = new THREE.Points(g, markerMat); pts.renderOrder = 10; measure.group.add(pts);
  if (measure.pts.length === 2) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(measure.pts), mLineMat); l.renderOrder = 10; measure.group.add(l);
  }
  requestRender();
}
function renderHud() {
  const hud = $('#measureHud');
  if (!measure.on) { hud.classList.add('hidden'); return; }
  hud.classList.remove('hidden');
  if (measure.pts.length < 2) {
    hud.innerHTML = `<div>${measure.pts.length ? 'Tap the second point' : 'Tap the first point'}</div><div class="small">Snaps to corners. Pinch / drag still moves the view.</div>`;
    return;
  }
  const [a, b] = measure.pts;
  const d = a.distanceTo(b);
  const dv = b.y - a.y;
  const dh = Math.hypot(b.x - a.x, b.z - a.z);
  const slope = dh > 1e-6 ? `${((dv / dh) * 100).toFixed(2)}%` : '—';
  hud.innerHTML = `<div class="big">${fmtLen(d)}</div>
    <div class="small">Horizontal ${fmtLen(dh)} · Vertical ${fmtLen(dv)} · Slope ${slope}</div>
    <button id="mClear">Clear</button>`;
  $('#mClear').onclick = (e) => { e.stopPropagation(); clearMeasure(); };
}
function setMeasure(on) {
  measure.on = on;
  $('#btnMeasure').classList.toggle('on', on);
  if (!on) clearMeasure(); else renderHud();
}
function measureTap(x, y) {
  const hit = pick(x, y, true);
  if (!hit) { toast('No surface there'); return; }
  if (measure.pts.length >= 2) measure.pts = [];
  measure.pts.push(hit.point);
  drawMeasure();
  renderHud();
}

// ---------------------------------------------------------------- orbit around what's under your finger
// When a one-finger orbit starts, move the orbit centre to the depth of the
// surface under the finger. The centre stays on the line of sight, so the view
// doesn't jump; it just pivots around nearby geometry instead of the model's middle.
canvas.addEventListener('pointerdown', (e) => {
  if (!model || walk.active || anim || !controls.enabled) return;
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (!prefs.get('pivotUnderFinger', true)) return;
  const hit = pick(e.clientX, e.clientY, false) || pick(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2, false);
  if (!hit) return;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const depth = new THREE.Vector3().subVectors(hit.point, camera.position).dot(dir);
  if (!(depth > 0)) return;
  if (camera === ortho) {
    // Parallel view: keep the camera the same distance back from the new centre.
    const back = camera.position.distanceTo(controls.target);
    const centre = camera.position.clone().addScaledVector(dir, depth);
    camera.position.copy(centre).addScaledVector(dir, -back);
    controls.target.copy(centre);
  } else {
    controls.target.copy(camera.position).addScaledVector(dir, depth);
  }
}, true);

// ---------------------------------------------------------------- gestures: tap / double tap
let down = null, lastTap = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) { down = null; return; }
  down = { x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
});
canvas.addEventListener('pointerdown', (e) => { if (!e.isPrimary && down) down.multi = true; });
canvas.addEventListener('pointerup', (e) => {
  if (!e.isPrimary || !down || down.multi) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const dt = performance.now() - down.t;
  down = null;
  if (moved > 10 || dt > 450 || walk.active) return;
  if (measure.on) { measureTap(e.clientX, e.clientY); return; }
  const now = performance.now();
  if (lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    const hit = pick(e.clientX, e.clientY, false);
    if (hit) {
      // Re-centre the orbit on the tapped point and move in a bit.
      const off = new THREE.Vector3().subVectors(camera.position, controls.target);
      const newPos = hit.point.clone().add(off.multiplyScalar(0.6));
      animateCamera(newPos, hit.point, camera.up, 350);
    }
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

// ---------------------------------------------------------------- walk / look-around mode
const walk = {
  active: false, yaw: 0, pitch: 0, move: new THREE.Vector2(), look: null, lift: null, speed: 1,
  step() {
    let changed = false;
    if (this.move.lengthSq() > 0.001) {
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      camera.position.addScaledVector(f, -this.move.y * this.speed * 0.016).addScaledVector(r, this.move.x * this.speed * 0.016);
      changed = true;
    }
    if (changed || this.dirty) {
      this.dirty = false;
      camera.up.set(0, 1, 0);
      const dir = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      camera.lookAt(camera.position.clone().add(dir));
      changed = true;
    }
    return changed;
  },
};
function setWalk(on) {
  if (on === walk.active) return;
  if (on) {
    if (camera === ortho) setCamera('persp');
    walk.active = true;
    controls.enabled = false;
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    walk.yaw = Math.atan2(-dir.x, -dir.z);
    walk.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    walk.speed = Math.max(model ? model.radius * 0.35 : 1, 0.5); // metres per second
    walk.dirty = true;
    $('#joystick').classList.remove('hidden');
    toast('Walk: drag to look, joystick to move, two fingers up/down to rise/drop', 3500);
  } else {
    walk.active = false;
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    const dist = model ? Math.max(model.radius * 0.3, 1) : 5;
    controls.target.copy(camera.position).addScaledVector(dir, dist);
    controls.enabled = true;
    controls.update();
    $('#joystick').classList.add('hidden');
  }
  requestRender();
}
// Look + rise/drop on the canvas while walking
const walkPtrs = new Map();
canvas.addEventListener('pointerdown', (e) => { if (walk.active) { walkPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointermove', (e) => {
  if (!walk.active || !walkPtrs.has(e.pointerId)) return;
  const p = walkPtrs.get(e.pointerId);
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (walkPtrs.size === 1) {
    walk.yaw += dx * 0.005; walk.pitch = THREE.MathUtils.clamp(walk.pitch + dy * 0.005, -1.45, 1.45);
  } else {
    camera.position.y -= (dy / walkPtrs.size) * walk.speed * 0.004;
  }
  walk.dirty = true;
});
const endWalkPtr = (e) => walkPtrs.delete(e.pointerId);
canvas.addEventListener('pointerup', endWalkPtr);
canvas.addEventListener('pointercancel', endWalkPtr);
(() => {
  const j = $('#joystick'), knob = j.querySelector('.knob');
  let id = null;
  const set = (e) => {
    const r = j.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    walk.move.set(x, y);
    knob.style.transform = `translate(${x * 35}px, ${y * 35}px)`;
  };
  j.addEventListener('pointerdown', (e) => { id = e.pointerId; j.setPointerCapture(id); set(e); e.stopPropagation(); });
  j.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
  const end = (e) => { if (e.pointerId !== id) return; id = null; walk.move.set(0, 0); knob.style.transform = ''; };
  j.addEventListener('pointerup', end); j.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- sheets / panels
let openPanel = null;
function showSheet(name, title, render) {
  const wasOpen = !!openPanel;
  openPanel = name;
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.innerHTML = '';
  render(body);
  $('#sheet').classList.remove('hidden');
  document.querySelectorAll('#toolbar [data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  if (!wasOpen) pushState('sheet');
}
function hideSheet() {
  openPanel = null;
  $('#sheet').classList.add('hidden');
  document.querySelectorAll('#toolbar [data-panel]').forEach((b) => b.classList.remove('on'));
}
$('#sheetClose').onclick = () => goBack();

function checkRow(label, on, onChange, extra = '') {
  const r = el('div', 'row', `<div class="check ${on ? 'on' : ''}"></div>${extra}<div class="grow">${esc(label)}</div>`);
  r.onclick = () => { on = !on; r.querySelector('.check').classList.toggle('on', on); onChange(on); };
  return r;
}
function seg(options, cur, onPick) {
  const s = el('div', 'seg');
  for (const [v, label] of options) {
    const b = el('button', v === cur ? 'on' : '', esc(label));
    b.onclick = () => { s.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onPick(v); };
    s.appendChild(b);
  }
  return s;
}

const panels = {
  views(body) {
    body.appendChild(el('div', 'label', 'Standard views'));
    const v = el('div', 'views');
    for (const name of Object.keys(VIEWS)) {
      const b = el('button', '', name);
      b.onclick = () => { stdView(name); goBack(); };
      v.appendChild(b);
    }
    body.appendChild(v);
    body.appendChild(el('div', 'label', 'Camera'));
    body.appendChild(seg([['persp', 'Perspective'], ['ortho', 'Parallel']], camera === persp ? 'persp' : 'ortho', (k) => { if (walk.active && k === 'ortho') setWalk(false); setCamera(k); }));
    body.appendChild(el('div', 'label', 'Navigation'));
    body.appendChild(seg([['orbit', 'Orbit'], ['walk', 'Walk / look']], walk.active ? 'walk' : 'orbit', (k) => { setWalk(k === 'walk'); goBack(); }));
    body.appendChild(checkRow('Orbit around what\'s under your finger', prefs.get('pivotUnderFinger', true), (on) => prefs.set('pivotUnderFinger', on)));
    body.appendChild(el('div', 'label', 'Orbit speed'));
    const sp = el('div', 'row', `<span>Slow</span><input type="range" min="0.2" max="1.6" step="0.05" value="${controls.rotateSpeed}" class="grow"><span>Fast</span>`);
    sp.querySelector('input').oninput = (ev) => { controls.rotateSpeed = +ev.target.value; prefs.set('orbitSpeed', +ev.target.value); };
    body.appendChild(sp);
    if (camera === persp) {
      body.appendChild(el('div', 'label', 'Field of view'));
      const row = el('div', 'row', `<input type="range" min="20" max="90" value="${persp.fov}" class="grow"><span>${persp.fov.toFixed(0)}°</span>`);
      const inp = row.querySelector('input'), sp = row.querySelector('span');
      inp.oninput = () => { persp.fov = +inp.value; sp.textContent = `${inp.value}°`; persp.updateProjectionMatrix(); requestRender(); };
      body.appendChild(row);
    }
  },
  style(body) {
    body.appendChild(el('div', 'label', 'Faces'));
    const faces = [
      ['textured', 'Shaded with textures'], ['shaded', 'Shaded (colours only)'], ['mono', 'Monochrome'],
      ['tag', 'Colour by tag'], ['hidden', 'Hidden line'], ['xray', 'X-ray'], ['wire', 'Wireframe'],
    ];
    for (const [v, label] of faces) {
      const r = el('div', 'row' + (style.face === v ? ' sel' : ''), `<div class="grow">${label}</div>`);
      r.onclick = () => {
        style.face = v; prefs.set('face', v); applyStyle();
        body.querySelectorAll('.row.face').forEach((x) => x.classList.remove('sel')); r.classList.add('sel');
      };
      r.classList.add('face');
      body.appendChild(r);
    }
    body.appendChild(el('div', 'label', 'Edges'));
    body.appendChild(checkRow('Show edges', style.edges, (on) => { style.edges = on; prefs.set('edges', on); applyStyle(); }));
    body.appendChild(el('div', 'label', 'Callouts'));
    body.appendChild(checkRow('Show text labels and dimensions', style.notes, (on) => {
      style.notes = on; prefs.set('notes', on); applyNoteVisibility(); requestRender();
    }));
    if (!model.noteCount) body.appendChild(el('div', 'row muted', '<small>This model has none the viewer can read.</small>'));
    body.appendChild(el('div', 'label', 'Measurement units'));
    body.appendChild(seg([['imperial', "Feet & inches"], ['metric', 'Metric']], prefs.get('units', 'imperial'), (u) => { prefs.set('units', u); renderHud(); relabelDimensions(); }));
  },
  tags(body) {
    const layers = model.data.layers.filter((l) => l.used || l.name !== 'Layer0');
    const btns = el('div', 'btnrow');
    const all = el('button', '', 'Show all'), none = el('button', '', 'Hide all');
    all.onclick = () => { model.layerHidden.clear(); applyVisibility(); showSheet('tags', 'Tags', panels.tags); };
    none.onclick = () => { for (const l of layers) if (l.name !== 'Layer0') model.layerHidden.add(l.name); applyVisibility(); showSheet('tags', 'Tags', panels.tags); };
    btns.append(all, none);
    body.appendChild(btns);
    for (const l of layers) {
      const label = l.name === 'Layer0' ? 'Untagged' : l.name;
      const sw = `<div class="swatch" style="background:rgb(${l.color.join(',')})"></div>`;
      if (l.name === 'Layer0') { body.appendChild(el('div', 'row', `<div class="check on" style="opacity:.4"></div>${sw}<div class="grow">${label}</div>`)); continue; }
      body.appendChild(checkRow(label, !model.layerHidden.has(l.name), (on) => {
        if (on) model.layerHidden.delete(l.name); else model.layerHidden.add(l.name);
        applyVisibility();
      }, sw));
    }
    if (!layers.length) body.appendChild(el('div', 'row muted', 'This model has no tags.'));
    body.appendChild(el('div', 'row muted', '<small>Tags hide whole groups and components. Loose faces drawn directly on a tag are not split out.</small>'));
  },
  outliner(body) {
    const tree = el('div', 'tree');
    body.appendChild(tree);
    const named = (n) => (n.name && !n.generated ? n.name : '') || (n.def ? `<${n.def}>` : 'Group');
    const renderChildren = (parent, container, depth) => {
      const kids = parent.children;
      const MAX = 300;
      kids.slice(0, MAX).forEach((n) => {
        const has = n.children.length > 0;
        const r = el('div', 'row');
        r.style.paddingLeft = `${10 + depth * 16}px`;
        const vis = !model.hiddenNodes.has(n);
        r.innerHTML = `<span class="twist">${has ? '▸' : ''}</span><div class="check ${vis ? 'on' : ''}"></div><div class="grow">${esc(named(n))}</div>`;
        const sub = el('div');
        sub.hidden = true;
        r.querySelector('.check').onclick = (e) => {
          e.stopPropagation();
          const on = model.hiddenNodes.has(n);
          if (on) model.hiddenNodes.delete(n); else model.hiddenNodes.add(n);
          e.currentTarget.classList.toggle('on', on);
          applyVisibility();
        };
        r.querySelector('.twist').onclick = (e) => {
          e.stopPropagation();
          if (!has) return;
          sub.hidden = !sub.hidden;
          e.currentTarget.textContent = sub.hidden ? '▸' : '▾';
          if (!sub.hidden && !sub.childElementCount) renderChildren(n, sub, depth + 1);
        };
        r.querySelector('.grow').onclick = () => {
          const b = new THREE.Box3().setFromObject(n.obj);
          if (!b.isEmpty()) { if (walk.active) setWalk(false); fitBox(b); goBack(); }
        };
        container.append(r, sub);
      });
      if (kids.length > MAX) container.appendChild(el('div', 'row muted', `…and ${kids.length - MAX} more`));
    };
    renderChildren(model.data.root, tree, 0);
    if (!model.data.root.children.length) tree.appendChild(el('div', 'row muted', 'No groups or components in this model.'));
    else body.appendChild(el('div', 'row muted', '<small>Tap a name to zoom to it. Tick box shows/hides it.</small>'));
  },
  info(body) {
    const d = model.data, b = model.box;
    const size = new THREE.Vector3(); b.getSize(size);
    const kv = el('div', 'kv');
    const add = (k, v) => kv.insertAdjacentHTML('beforeend', `<div>${esc(k)}</div><div>${esc(v)}</div>`);
    add('File', model.fileName);
    add('Size', model.fileSize ? `${(model.fileSize / 1048576).toFixed(2)} MB` : '—');
    add('Saved with', skuVersion(d.version));
    add('Model units', d.units || 'Inches');
    add('Extents (W × D × H)', `${fmtLen(size.x)} × ${fmtLen(size.z)} × ${fmtLen(size.y)}`);
    add('Components/groups', String(d.stats.nodes - 1));
    add('Definitions', String(d.stats.definitions));
    add('Tags', String(d.layers.length));
    const ann = d.annotations;
    if (ann) add('Callouts', `${ann.texts} text, ${ann.dims} dimension${ann.dims === 1 ? '' : 's'}`);
    add('Scenes', String(d.pages.length));
    add('Materials', String(d.materials.length));
    add('Load time', `${model.loadMs} ms`);
    body.appendChild(kv);
  },
};
document.querySelectorAll('#toolbar [data-panel]').forEach((b) => {
  b.onclick = () => {
    if (!model) return;
    const name = b.dataset.panel;
    if (openPanel === name) { goBack(); return; }
    showSheet(name, b.querySelector('span').textContent, panels[name]);
  };
});
$('#btnInfo').onclick = () => {
  if (!model) return;
  showSheet('info', 'Model info', panels.info);
};
$('#btnFit').onclick = () => { if (!model) return; if (walk.active) setWalk(false); fitBox(model.box); };
$('#btnMeasure').onclick = () => setMeasure(!measure.on);

// ---------------------------------------------------------------- navigation / history (Android back button)
let histOk = true;
function pushState(v) { try { history.pushState({ v }, ''); } catch (_) { histOk = false; } }
function replaceState(v) { try { history.replaceState({ v }, ''); } catch (_) { histOk = false; } }
// Android back button / browser back go through history; fall back to direct handling if history is unavailable.
function goBack() { if (histOk) history.back(); else onPop(); }
function onPop() {
  if (openPanel) { hideSheet(); return; }
  if (!$('#viewer').classList.contains('hidden')) closeViewer();
}
window.addEventListener('popstate', onPop);
$('#btnBack').onclick = () => goBack();

function closeViewer() {
  setMeasure(false);
  if (walk.active) setWalk(false);
  hideSheet();
  disposeModel();
  $('#viewer').classList.add('hidden');
  $('#library').classList.remove('hidden');
  renderLibrary();
}

// ---------------------------------------------------------------- open a model
async function openBuffer(buffer, name, recId) {
  $('#library').classList.add('hidden');
  $('#viewer').classList.remove('hidden');
  $('#title').textContent = name;
  $('#scenes').classList.add('hidden');
  const loading = $('#loading'), lt = $('#loadingText');
  loading.classList.remove('hidden');
  lt.textContent = 'Reading model…';
  pushState('viewer');
  resize();
  const t0 = performance.now();
  const size = buffer.byteLength;
  let data;
  try {
    data = await parseFile(buffer, (stage) => { lt.textContent = `${stage}…`; });
  } catch (e) {
    loading.classList.add('hidden');
    console.error(e);
    await dialog(`Couldn't read "${name}".\n\n${e.message || e}\n\nThe file may be damaged, or saved in a format this viewer can't read yet.`);
    if (recId) { try { await store.remove(recId); } catch (_) {} }
    goBack();
    return;
  }
  lt.textContent = 'Building view…';
  await new Promise((r) => setTimeout(r, 0));
  try {
    buildModel(data);
  } catch (e) {
    loading.classList.add('hidden');
    console.error(e);
    await dialog(`Couldn't display "${name}": ${e.message || e}`);
    goBack();
    return;
  }
  model.fileName = name;
  model.fileSize = size;
  model.loadMs = Math.round(performance.now() - t0);

  // Camera: start on the file's first scene if it has one, else iso.
  setCamera(prefs.get('camera', 'persp') === 'ortho' ? 'ortho' : 'persp');
  fitBox(model.box, new THREE.Vector3(...VIEWS.Iso), new THREE.Vector3(0, 1, 0), true);
  const sc = $('#scenes');
  sc.innerHTML = '';
  if (data.pages.length) {
    data.pages.forEach((p, i) => {
      const b = el('button', '', esc(p.name || `Scene ${i + 1}`));
      b.onclick = () => goToScene(i);
      sc.appendChild(b);
    });
    sc.classList.remove('hidden');
    const first = data.pages.findIndex((p) => p.eye && p.target);
    if (first >= 0) goToScene(first);
  }
  if (data.root.children.length === 0 && Object.keys(data.meshes).length === 0) toast('This model appears to be empty.');
  else if (model.noteOverflow) toast(`Showing the first ${MAX_NOTES} callouts.`, 3200);
  loading.classList.add('hidden');
  requestRender();

  // Save a thumbnail for the library if the file didn't carry one.
  if (recId) {
    try {
      const rec = await store.get(recId);
      if (rec && !rec.thumb) {
        await new Promise((r) => setTimeout(r, 700));
        renderer.render(scene, camera);
        // Crop a 4:3 window from the middle of the view onto a light background.
        const W = canvas.width, H = canvas.height;
        const cw = W, ch = Math.min(H, Math.round(W * 0.75));
        const tc = document.createElement('canvas');
        tc.width = 480; tc.height = 360;
        const g = tc.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 0, 360);
        grad.addColorStop(0, '#dbe5ee'); grad.addColorStop(1, '#eceeea');
        g.fillStyle = grad; g.fillRect(0, 0, 480, 360);
        g.drawImage(canvas, 0, (H - ch) / 2, cw, ch, 0, 0, 480, 360);
        const blob = await new Promise((r) => tc.toBlob(r, 'image/jpeg', 0.8));
        if (blob) { rec.thumb = blob; await store.put(rec); }
      }
    } catch (_) {}
  }
}

async function addFiles(files) {
  let last = null;
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const id = idFor(f.name, f.size);
    let thumb = null;
    try {
      const { extractThumbnail } = await import('./vendor/openskp.mjs');
      const t = extractThumbnail(buf);
      if (t) thumb = new Blob([t.data], { type: t.mimeType });
    } catch (_) {}
    const rec = { id, name: f.name, size: f.size, added: Date.now(), opened: Date.now(), modified: f.lastModified || null, thumb, data: new Blob([buf]) };
    try { await store.put(rec); } catch (e) { console.warn('Could not save to library', e); }
    last = { buf, name: f.name, id };
  }
  if (last) openBuffer(last.buf, last.name, last.id);
  else renderLibrary();
}

async function openRecord(id) {
  const rec = await store.get(id);
  if (!rec) return;
  store.touch(id);
  const buf = await rec.data.arrayBuffer();
  openBuffer(buf, rec.name, id);
}

// ---------------------------------------------------------------- library
const thumbUrls = [];
async function renderLibrary() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  let list = [];
  try { list = await store.list(); } catch (e) { console.warn(e); }
  const grid = $('#libGrid');
  grid.innerHTML = '';
  $('#libEmpty').classList.toggle('hidden', list.length > 0);
  for (const r of list) {
    const c = el('div', 'card');
    let style = '';
    if (r.thumb) { const u = URL.createObjectURL(r.thumb); thumbUrls.push(u); style = `background-image:url('${u}')`; }
    const when = new Date(r.opened || r.added).toLocaleDateString();
    c.innerHTML = `<div class="thumb" style="${style}">${r.thumb ? '' : 'No preview'}</div>
      <div class="meta"><div class="name">${esc(r.name.replace(/\.skp$/i, ''))}</div><div class="sub">${(r.size / 1048576).toFixed(1)} MB · ${when}</div></div>
      <button class="more" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>`;
    c.onclick = () => openRecord(r.id);
    c.querySelector('.more').onclick = async (e) => {
      e.stopPropagation();
      if (await dialog(`Remove "${r.name}" from this phone's library?\n\nThe original file is not touched.`, { ok: 'Remove', cancel: 'Cancel' })) { await store.remove(r.id); renderLibrary(); }
    };
    grid.appendChild(c);
  }
}

$('#fileInput').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) addFiles(files); };
// Desktop convenience: drag and drop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f); });

// ---------------------------------------------------------------- offline
// Keep a copy on the device, so it opens on a site with no signal once it has
// been visited. There is no service worker while developing, and none on a
// plain file:// open; both fail quietly.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* fine without it */ });
  });
}
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
replaceState('library');
renderLibrary();
