// Parses a .skp file off the UI thread and returns render-ready buffers.
import {
  __parseToRaw,
  __buildInstancedSceneFromParsed,
  buildModelFromParsed,
  extractThumbnail,
  isDrawableEdge,
} from './vendor/openskp.mjs';
import { readAnnotations } from './annotations.js';

const IN_TO_M = 0.0254;

if (typeof self !== 'undefined' && typeof importScripts !== 'undefined' || (typeof self !== 'undefined' && typeof window === 'undefined' && typeof process === 'undefined')) self.onmessage = (ev) => {
  const { id, buffer } = ev.data;
  try {
    const out = parse(buffer, (stage, cur, tot) =>
      self.postMessage({ id, type: 'progress', stage, cur, tot })
    );
    self.postMessage({ id, type: 'done', result: out.result }, out.transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message ? err.message : err) });
  }
};

export function parse(buffer, onProgress = () => {}) {
  const transfer = [];
  const opts = {
    onProgress: (p) => onProgress(p.stage, p.current, p.total),
  };

  let thumb = null;
  try {
    const t = extractThumbnail(buffer);
    if (t) thumb = { data: t.data, mimeType: t.mimeType };
  } catch (_) { /* thumbnail is optional */ }

  onProgress('Reading file', 0, 1);
  const raw = __parseToRaw(buffer, opts);
  onProgress('Building model', 0, 1);
  const model = buildModelFromParsed(raw);

  // OpenSKP paints unpainted faces with their tag colour. SketchUp paints them
  // with its default front/back material. Swap in sentinel colours so the
  // viewer can tell "default material" faces apart after the scene is built.
  const realLayerColors = {};
  const sentinels = [];
  let k = 0;
  for (const [name, c] of raw.layerColors.entries()) {
    realLayerColors[name] = c;
    const s = [3, 5 + Math.floor(k / 250), 1 + (k % 250)];
    raw.layerColors.set(name, s);
    sentinels.push(s.map((v) => v / 255));
    k++;
  }

  onProgress('Building scene', 0, 1);
  const scene = __buildInstancedSceneFromParsed(raw, opts);

  const isSentinel = (f) =>
    f && sentinels.some((s) => Math.abs(s[0] - f[0]) < 1e-4 && Math.abs(s[1] - f[1]) < 1e-4 && Math.abs(s[2] - f[2]) < 1e-4);

  const materials = scene.gltfMaterials.map((m) => {
    const pbr = m.pbrMetallicRoughness || {};
    const f = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
    return {
      color: [f[0], f[1], f[2]],
      opacity: f[3] ?? 1,
      texture: pbr.baseColorTexture ? pbr.baseColorTexture.index : -1,
      blend: m.alphaMode === 'BLEND',
      mask: m.alphaMode === 'MASK',
      isDefault: isSentinel(f) && !pbr.baseColorTexture,
    };
  });

  const textures = scene.textures.map((t) => {
    const data = t.data instanceof Uint8Array ? t.data : new Uint8Array(t.data || []);
    return { data, mimeType: t.mimeType || 'image/png', filename: t.filename || '' };
  });

  const meshes = {};
  for (const r of scene.meshResources) {
    meshes[r.id] = {
      definitionId: r.definitionId,
      prims: r.primitives.map((p) => {
        transfer.push(p.positions.buffer, p.normals.buffer, p.uvs.buffer, p.indices.buffer);
        return { positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices, material: p.materialIndex };
      }),
    };
  }

  // SketchUp works in inches, Z-up; the viewer in metres, Y-up. The change of
  // basis is linear, so directions convert the same way as points.
  const conv = (p) => [p[0] * IN_TO_M, p[2] * IN_TO_M, -p[1] * IN_TO_M];

  // Edges, per definition, in definition-local glTF space (metres, Y-up).
  const defsByName = new Map();
  for (const [key, d] of model.definitions) {
    const list = defsByName.get(d.name) || [];
    list.push(key);
    defsByName.set(d.name, list);
  }
  const edgeCache = {};
  const edgesFor = (key) => {
    if (key in edgeCache) return edgeCache[key];
    const d = key === 'ROOT' ? model.root : model.definitions.get(key);
    if (!d || !d.edges || d.edges.length === 0) return (edgeCache[key] = null);
    const vmap = new Map();
    for (const v of d.vertices) vmap.set(v.id, v);
    const arr = [];
    for (const e of d.edges) {
      if (!isDrawableEdge(e)) continue;
      const a = vmap.get(e.v1Id), b = vmap.get(e.v2Id);
      if (!a || !b) continue;
      arr.push(a.x * IN_TO_M, a.z * IN_TO_M, -a.y * IN_TO_M, b.x * IN_TO_M, b.z * IN_TO_M, -b.y * IN_TO_M);
    }
    if (!arr.length) return (edgeCache[key] = null);
    const f = new Float32Array(arr);
    transfer.push(f.buffer);
    return (edgeCache[key] = f);
  };

  onProgress('Reading callouts', 0, 1);
  const annotations = buildAnnotations(buffer, raw, conv);

  let nodeCount = 0;
  const mapNode = (n, isRoot) => {
    nodeCount++;
    let defKey = null;
    if (isRoot) defKey = 'ROOT';
    else if (n.definitionId !== undefined && n.definitionId !== null) defKey = n.definitionId;
    else if (n.meshResourceId && meshes[n.meshResourceId]) defKey = meshes[n.meshResourceId].definitionId;
    else {
      const l = defsByName.get(n.definitionName);
      if (l && l.length === 1) defKey = l[0];
    }
    if (defKey !== null) edgesFor(defKey);
    return {
      name: n.name,
      generated: !!n.nameIsGenerated,
      def: n.definitionName,
      layer: n.layer || 'Layer0',
      matrix: n.matrix,
      mesh: n.meshResourceId || null,
      edges: defKey !== null && edgeCache[defKey] ? String(defKey) : null,
      // Callouts hang off the definition, so every instance of a component
      // gets its own copy, placed by that instance's transform.
      notes: defKey !== null && annotations.byDef[String(defKey)] ? String(defKey) : null,
      children: n.children.map((c) => mapNode(c, false)),
    };
  };
  const root = mapNode(scene.sceneHierarchy, true);

  const edges = {};
  for (const [kk, v] of Object.entries(edgeCache)) if (v) edges[String(kk)] = v;

  const pages = (model.pages || []).map((p) => ({
    name: p.name,
    eye: p.eye ? conv(p.eye) : null,
    target: p.target ? conv(p.target) : null,
    up: p.up ? [p.up[0], p.up[2], -p.up[1]] : null,
    fov: p.fov || 35,
    parallel: !!p.parallel,
    orthoHeight: p.orthoHeight ? p.orthoHeight * IN_TO_M : null,
    hiddenLayers: p.hiddenLayers || [],
  }));

  const usedLayers = new Set();
  (function walk(n) { usedLayers.add(n.layer); n.children.forEach(walk); })(root);
  const layers = (model.layers.length ? model.layers : [{ name: 'Layer0', hidden: false }]).map((l) => ({
    name: l.name,
    hidden: !!(l.hidden || (scene.layerHidden && scene.layerHidden[l.name])),
    color: realLayerColors[l.name] || [136, 136, 136],
    used: usedLayers.has(l.name),
  }));

  if (thumb) transfer.push(thumb.data.buffer);
  for (const t of textures) transfer.push(t.data.buffer);

  return {
    transfer: [...new Set(transfer)],
    result: {
      version: model.version,
      units: model.units || null,
      bounds: scene.bounds,
      materials,
      textures,
      meshes,
      edges,
      root,
      pages,
      layers,
      annotations,
      thumb,
      stats: {
        definitions: model.definitions.size,
        nodes: nodeCount,
        meshes: scene.meshResources.length,
      },
    },
  };
}

// Leader text and linear dimensions, grouped by the definition that owns them
// and converted into the viewer's space. Never fatal: a file whose callouts
// can't be read still opens, it just opens without them.
function buildAnnotations(buffer, raw, conv) {
  const out = { byDef: {}, texts: 0, dims: 0, skipped: 0 };
  let ann;
  try {
    ann = readAnnotations(buffer);
  } catch (_) {
    return out;
  }
  const layerName = (id) => (id == null ? null : raw.layerIdToName.get(id) || null);
  const bucket = (owner) => {
    const k = String(owner);
    if (!out.byDef[k]) out.byDef[k] = { texts: [], dims: [] };
    return out.byDef[k];
  };
  for (const t of ann.texts) {
    bucket(t.owner).texts.push({
      text: t.text,
      point: conv(t.point),
      leader: conv(t.leader),
      showLeader: t.showLeader !== false,
      layer: layerName(t.layerId),
      hidden: !!t.hidden,
    });
    out.texts++;
  }
  for (const d of ann.dims) {
    bucket(d.owner).dims.push({
      a: conv(d.a),
      b: conv(d.b),
      offset: conv(d.offsetVec),
      layer: layerName(d.layerId),
      hidden: !!d.hidden,
    });
    out.dims++;
  }
  out.skipped = ann.skipped;
  return out;
}
