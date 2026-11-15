// Reads SketchUp's callouts - leader text (the Text tool) and linear
// dimensions (the Dimension tool) - out of a modern "VFF" .skp file.
//
// Why this file exists: OpenSKP 1.5.0 (the vendored reader) throws the
// geometry away. Its per-definition `texts` carry the string but no position,
// its model-level `dimensions` carry positions but no text, and the VFF path
// never looks for text entities at all. OpenSKP's own C++ reader does read
// them (packages/cpp/src/pages_dimensions.cpp, "Annotation tags and
// visibility", #488), but that work is unreleased and not in the published
// JavaScript build, so the record layout is ported here.
//
// Classic (pre-2013 MFC) files are not handled: their reader hands back text
// strings with no coordinates at all, so there is nothing to place.
//
// All coordinates coming out of here are SketchUp's own: inches, Z-up.

import {
  __isLegacy,
  __extractSkpContents,
  __iterTopLevelLazy,
  __scanVertexPositions,
  __scanInstanceTransforms,
} from './vendor/openskp.mjs';

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const f64 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(o, true);

// Text record (tag 55F0)
const T_TEXT = 0x55f1;        // the string, UTF-8
const T_SCREEN_X = 0x55f2;    // screen fraction, f64
const T_SCREEN_Y = 0x55f3;
const T_ANCHOR = 0x55f4;      // connection block: what the leader points at
const T_LEADER_VEC = 0x55f5;  // leader vector from the anchor to the label
const T_ARROW = 0x55fa;
const T_SHOW_LEADER = 0x55fc;
const T_LEADER_TYPE = 0x55fd;

// Dimension record (tag 5BCC)
const D_A = 0x5bcd;           // connection block, first measured end
const D_B = 0x5bce;           // connection block, second measured end
const D_PLANE_NORMAL = 0x5bcf;
const D_PLANE_X = 0x5bd0;
const D_AXIS = 0x5bd1;        // which axis the offset runs along, u32
const D_OFFSET = 0x5bd2;      // dimension-line offset, f64 inches, signed
const D_BASE = 0x59d8;        // wrapper holding the drawing properties

// Shared
const P_DRAW = 0x07d0;        // drawing properties
const P_LAYER = 0x07d2;       // tag (layer) id
const P_FLAGS = 0x07d3;       // bit 0 = hidden
const C_BLOCK = 0x5208;       // connection block
const C_TYPE = 0x5209;        // 1 = free point stored inline, 2 = anchored
const C_POINT = 0x520a;       // the inline point, 3 x f64
const C_REF = 0x520b;         // the anchored reference
const C_REF_BODY = 0x53fc;
const C_VERTEX_ID = 0x53fd;
const C_INSTANCE_PATH = 0x53fe;
const ID_BASE = 0x05dc;
const ID_VALUE = 0x05de;

// A flat (integer-tagged) TLV list: [u16 tag][u32 length][payload].
function tlvItems(buf) {
  if (!buf) return null;
  const items = [];
  const n = buf.length;
  let off = 0;
  while (off < n) {
    if (off + 6 > n) return null;
    const tag = buf[off] | (buf[off + 1] << 8);
    const len = u32(buf, off + 2);
    if (tag === 0 || off + 6 + len > n) return null;
    items.push({ tag, payload: buf.subarray(off + 6, off + 6 + len) });
    off += 6 + len;
  }
  return items;
}
function tlvFind(items, tag) {
  if (!items) return null;
  for (const it of items) if (it.tag === tag) return it.payload;
  return null;
}
const vec3 = (p) => (p && p.length === 24 ? [f64(p, 0), f64(p, 8), f64(p, 16)] : null);

function hex(d) {
  let s = '';
  for (let i = 0; i < d.length; i++) {
    const h = d[i].toString(16).toUpperCase();
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}
// Same encoding OpenSKP's own reader uses for these ids: a little-endian
// base-256 integer, not a LEB128 varint.
function varInt(b) {
  let v = 0;
  for (let i = 0; i < b.length; i++) v += b[i] * Math.pow(256, i);
  return v;
}

// OpenSKP keeps instance transforms as 13 doubles: a column-major 3x3 basis,
// a translation, and a trailing scale divisor.
function transformPoint(m, p) {
  const w = m[12];
  const s = w && Math.abs(w) > 1e-12 ? 1 / w : 1;
  return [
    (m[0] * p[0] + m[3] * p[1] + m[6] * p[2] + (m[9] || 0)) * s,
    (m[1] * p[0] + m[4] * p[1] + m[7] * p[2] + (m[10] || 0)) * s,
    (m[2] * p[0] + m[5] * p[1] + m[8] * p[2] + (m[11] || 0)) * s,
  ];
}

// An instance path is a run of length-prefixed ids, innermost last.
function instancePath(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const n = buf[off];
    if (n === 0 || off + 1 + n > buf.length) break;
    out.push(hex(buf.subarray(off + 1, off + 1 + n)));
    off += 1 + n;
  }
  return out;
}

// Where a connection points: either a free point written into the record, or a
// vertex somewhere in the model (possibly inside an instance, whose transform
// has to be applied to get back to the annotation's own space).
function connectionPoint(block, vertexPos, instWorld) {
  if (!block) return null;
  const inner = tlvFind(tlvItems(block), C_BLOCK);
  if (!inner) return null;
  const sub = tlvItems(inner);
  const typeBytes = tlvFind(sub, C_TYPE);
  const type = typeBytes && typeBytes.length === 4 ? u32(typeBytes, 0) : null;
  if (type === 1) return vec3(tlvFind(sub, C_POINT));
  const ref = tlvFind(sub, C_REF);
  const body = ref ? tlvFind(tlvItems(ref), C_REF_BODY) : null;
  const fields = body ? tlvItems(body) : null;
  const vertexId = tlvFind(fields, C_VERTEX_ID);
  if (!vertexId) return null;
  const local = vertexPos.get(hex(vertexId));
  if (!local) return null;
  const path = tlvFind(fields, C_INSTANCE_PATH);
  if (path && path.length) {
    const ids = instancePath(path);
    if (!ids.length) ids.push(hex(path));
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = instWorld.get(ids[i]);
      if (m && m.length) return transformPoint(m, local);
    }
  }
  return local;
}

// A two-byte tag needle hits vertex and float data far more often than a real
// record, and a bogus length field can claim hundreds of megabytes. Check the
// candidate parses as a well-formed TLV list carrying both required fields
// before copying anything out of it.
function looksLikeRecord(buf, begin, end, first, second) {
  let off = begin, hasFirst = false, hasSecond = false;
  while (off < end) {
    if (off + 6 > end) return false;
    const tag = buf[off] | (buf[off + 1] << 8);
    const len = u32(buf, off + 2);
    if (tag === 0 || len > end - off - 6) return false;
    if (tag === first) hasFirst = true;
    if (tag === second) hasSecond = true;
    off += 6 + len;
  }
  return hasFirst && hasSecond;
}

function drawingProps(fields) {
  const draw = tlvFind(fields, P_DRAW);
  if (!draw) return { layerId: null, hidden: false };
  const props = tlvItems(draw);
  const layer = tlvFind(props, P_LAYER);
  const flags = tlvFind(props, P_FLAGS);
  return {
    layerId: layer && layer.length ? varInt(layer) : null,
    hidden: !!(flags && flags.length && (flags[0] & 1)),
  };
}

function persistentId(fields) {
  const base = tlvFind(fields, ID_BASE);
  if (!base) return 0;
  const id = tlvFind(tlvItems(base), ID_VALUE);
  return id && id.length && id.length <= 8 ? varInt(id) : 0;
}

// Headers only: [u16 tag][u32 length], no descent, no copying.
function tlvHeaders(md, start, end) {
  const out = [];
  for (let p = start; p + 6 <= end; ) {
    const len = u32(md, p + 2);
    if (len > end - p - 6) break;
    out.push({ offset: p, size: len });
    p += 6 + len;
  }
  return out;
}
const tagAt = (md, off) => hex(md.subarray(off, off + 2));
const findHeader = (headers, md, tag) => headers.find((h) => tagAt(md, h.offset) === tag) || null;

// A definition's own id, by the same rule the reader uses: a direct DE05 or
// DC05, then only dictionary / entity-header containers. Walking into C409 or
// 6419 would pick up a vertex or instance id instead.
const ID_CONTAINERS = ['8813', 'D007', '8913', '8A13', '8B13', '8C13', '8D13'];
function entityIdFromTlv(md, rec, recEnd, depth) {
  if (depth > 24 || rec + 6 > recEnd) return null;
  const kids = tlvHeaders(md, rec + 6, recEnd);
  for (const k of kids) {
    const t = tagAt(md, k.offset);
    if (t === 'DE05' && k.size > 0 && k.size <= 8) return varInt(md.subarray(k.offset + 6, k.offset + 6 + k.size));
    if (t === 'DC05' && k.size >= 6 && md[k.offset + 6] === 0xde && md[k.offset + 7] === 0x05) {
      const z = u32(md, k.offset + 8);
      if (z > 0 && z <= 8 && z <= k.size - 6) return varInt(md.subarray(k.offset + 12, k.offset + 12 + z));
    }
  }
  for (const k of kids) {
    if (!ID_CONTAINERS.includes(tagAt(md, k.offset))) continue;
    const id = entityIdFromTlv(md, k.offset, k.offset + 6 + k.size, depth + 1);
    if (id !== null) return id;
  }
  return null;
}

// Every `7C15` record in the definition list is one component/group. An
// annotation inside such a span belongs to that definition and is stored in
// its local coordinates; one outside every span belongs to the model root, in
// world coordinates. Only the real list (F901 -> 7017 -> 7117) counts: hunting
// for the `7C15` bytes anywhere would false-match inside geometry and park
// callouts on the wrong definition.
function definitionSpans(md) {
  const spans = [];
  if (md.length < 6) return spans;
  let top = tlvHeaders(md, 0, md.length);
  if (top.length === 1 && tagAt(md, top[0].offset) === 'F401') {
    top = tlvHeaders(md, top[0].offset + 6, top[0].offset + 6 + top[0].size);
  }
  for (const h of top) {
    if (tagAt(md, h.offset) !== 'F901') continue;
    let level = tlvHeaders(md, h.offset + 6, h.offset + 6 + h.size);
    let ok = true;
    for (const expected of ['7017', '7117']) {
      const found = findHeader(level, md, expected);
      if (!found) { ok = false; break; }
      level = tlvHeaders(md, found.offset + 6, found.offset + 6 + found.size);
    }
    if (!ok) continue;
    for (const rec of level) {
      if (tagAt(md, rec.offset) !== '7C15') continue;
      const id = entityIdFromTlv(md, rec.offset, rec.offset + 6 + rec.size, 0);
      if (id === null) continue;
      spans.push({ id, begin: rec.offset, end: rec.offset + 6 + rec.size });
    }
  }
  // Innermost span wins, so search shortest-first.
  spans.sort((a, b) => a.end - a.begin - (b.end - b.begin));
  return spans;
}
function ownerOf(spans, offset) {
  for (const s of spans) if (offset >= s.begin && offset < s.end) return s.id;
  return 'ROOT';
}

/**
 * Pull the callouts out of a modern .skp.
 *
 * Returns `{ texts, dims, skipped }`, every entry tagged with the `owner`
 * definition id it belongs to ('ROOT' for the model level). Returns empty
 * lists for classic files rather than throwing.
 */
export function readAnnotations(buffer) {
  const empty = { texts: [], dims: [], skipped: 0 };
  const data = new Uint8Array(buffer);
  let md;
  try {
    if (__isLegacy(data)) return empty;
    md = __extractSkpContents(data, {}).modelData;
  } catch (_) {
    return empty;
  }

  // Find the candidate records first. This is a plain two-byte scan over the
  // model data, far cheaper than the walks below, and a model with no
  // callouts - most of them - then costs nothing more than the scan.
  const candidates = [];
  const n = md.length;
  for (let j = 0; j + 6 <= n; j++) {
    const isText = md[j] === 0xf0 && md[j + 1] === 0x55;
    const isDim = md[j] === 0xcc && md[j + 1] === 0x5b;
    if (!isText && !isDim) continue;
    const len = u32(md, j + 2);
    if (len < 40 || j + 6 + len > n) continue;
    if (!looksLikeRecord(md, j + 6, j + 6 + len, isText ? T_TEXT : D_A, isText ? T_ANCHOR : D_B)) continue;
    const fields = tlvItems(md.subarray(j + 6, j + 6 + len));
    if (!fields) continue;
    candidates.push({ j, isText, fields });
  }
  if (!candidates.length) return empty;

  const spans = definitionSpans(md);
  const noTransforms = new Map();

  // Only a callout anchored to a vertex needs these, and building them means
  // walking the whole model, so do it on first use rather than every open.
  let vertexPos = null;
  let instWorld = null;
  function resolve(block, owner) {
    if (!vertexPos) {
      vertexPos = new Map();
      instWorld = new Map();
      for (const { node } of __iterTopLevelLazy(md, 0, md.length)) {
        __scanVertexPositions(node, vertexPos);
        __scanInstanceTransforms(node, instWorld);
      }
    }
    // A definition's own callouts are already in its local space; only
    // model-level ones need instance transforms resolved to world space.
    return connectionPoint(block, vertexPos, owner === 'ROOT' ? instWorld : noTransforms);
  }

  const texts = [];
  const dims = [];
  let skipped = 0;

  for (const { j, isText, fields } of candidates) {
    const owner = ownerOf(spans, j);

    if (isText) {
      const value = tlvFind(fields, T_TEXT);
      const anchor = tlvFind(fields, T_ANCHOR);
      if (!value || !anchor) continue;
      const point = resolve(anchor, owner);
      let text = '';
      try { text = new TextDecoder('utf-8').decode(value); } catch (_) { continue; }
      text = text.replace(/\0+$/, '').replace(/\s+$/, '');
      if (!text) continue;
      if (!point) { skipped++; continue; }
      const sx = tlvFind(fields, T_SCREEN_X);
      const sy = tlvFind(fields, T_SCREEN_Y);
      const leaderType = tlvFind(fields, T_LEADER_TYPE);
      const arrow = tlvFind(fields, T_ARROW);
      const show = tlvFind(fields, T_SHOW_LEADER);
      const props = drawingProps(fields);
      texts.push({
        owner,
        pid: persistentId(fields),
        text,
        point,
        // Relative to `point`, the way SketchUp's own Text#vector is.
        leader: vec3(tlvFind(fields, T_LEADER_VEC)) || [0, 0, 0],
        screen: sx && sy && sx.length === 8 && sy.length === 8 ? [f64(sx, 0), f64(sy, 0)] : null,
        leaderType: leaderType && leaderType.length === 4 ? u32(leaderType, 0) : null,
        arrowType: arrow && arrow.length === 4 ? u32(arrow, 0) : null,
        showLeader: show && show.length === 1 ? show[0] !== 0 : true,
        layerId: props.layerId,
        hidden: props.hidden,
      });
      continue;
    }

    const a = resolve(tlvFind(fields, D_A), owner);
    const b = resolve(tlvFind(fields, D_B), owner);
    if (!a || !b) { skipped++; continue; }
    // OpenSKP's public field names have these two the other way round; 5BCF is
    // the plane normal and 5BD0 its X axis.
    const normal = vec3(tlvFind(fields, D_PLANE_NORMAL));
    const planeX = vec3(tlvFind(fields, D_PLANE_X));
    const axisBytes = tlvFind(fields, D_AXIS);
    const offBytes = tlvFind(fields, D_OFFSET);
    const offset = offBytes && offBytes.length === 8 ? f64(offBytes, 0) : 0;
    // Which way the dimension line is pushed off the measured segment.
    let offsetVec = [0, 0, 0];
    if (axisBytes && axisBytes.length === 4 && normal && planeX) {
      const axis = u32(axisBytes, 0);
      if (axis === 1) {
        offsetVec = [
          (normal[1] * planeX[2] - normal[2] * planeX[1]) * offset,
          (normal[2] * planeX[0] - normal[0] * planeX[2]) * offset,
          (normal[0] * planeX[1] - normal[1] * planeX[0]) * offset,
        ];
      } else if (axis === 2) {
        offsetVec = [-planeX[0] * offset, -planeX[1] * offset, -planeX[2] * offset];
      }
    }
    const base = tlvFind(fields, D_BASE);
    const props = base ? drawingProps(tlvItems(base)) : { layerId: null, hidden: false };
    dims.push({
      owner,
      pid: base ? persistentId(tlvItems(base)) : 0,
      a,
      b,
      offsetVec,
      layerId: props.layerId,
      hidden: props.hidden,
    });
  }

  // The same record can be reached more than once on files that repeat a
  // definition's bytes; persistent ids make the duplicates easy to drop.
  return { texts: dedupe(texts), dims: dedupe(dims), skipped };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = a.pid
      ? `${a.owner}/${a.pid}`
      : `${a.owner}/${a.text || ''}/${(a.point || a.a || []).join(',')}/${(a.b || []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
