/* Read a 3D model in the browser (STL, OBJ or 3MF) and guess the filament and print time a slicer would give,
   without uploading it anywhere.

     import { readModel, estimatePrint } from '/model-estimate.js?v=1';
     const m = await readModel(file);            // { volume mm³, area mm², size [x, y, z] mm, triangles }
     const e = estimatePrint(m, { material: 'PLA', scale: 1 });   // { grams, hours, plastic mm³ }

   The guess follows Bambu Studio's standard profile: 0.2 mm layers, 2 walls, ~1 mm top/bottom, 15% infill, no
   supports, on a Bambu-class printer. It's a ballpark: the slicer's numbers can differ by a fair bit either way. */

const DENSITY = { PLA: 1.24, ABS: 1.04, TPU: 1.21 };   // g/cm³
const SPEED = { PLA: 1, ABS: 0.9, TPU: 0.45 };         // TPU has to print slowly
const LAYER = 0.2;            // mm
const SHELL = 1.0;            // mm of walls / top / bottom around every surface
const INFILL = 0.17;          // share of the inside that gets printed (15% infill plus line overlap)
const SHELL_RATE = 4.5;       // mm³/s for walls and skins (outer walls go slow)
const INFILL_RATE = 12;       // mm³/s for infill
const PER_LAYER = 4;          // s per layer: layer change, travel, seams
const START = 300;            // s: heating, bed levelling, purge line

export function estimatePrint(m, { material = 'PLA', scale = 1 } = {}){
  const s = scale, V = m.volume * s * s * s, A = m.area * s * s, h = m.size[2] * s;
  const shell = Math.min(V, A * SHELL);
  const infill = Math.max(0, V - shell) * INFILL;
  const plastic = shell + infill;
  const sp = SPEED[material] || 1;
  const secs = START + Math.ceil(h / LAYER) * PER_LAYER + (shell / SHELL_RATE + infill / INFILL_RATE) / sp;
  return { plastic, grams: plastic / 1000 * (DENSITY[material] || 1.24) + 0.3, hours: V > 0 ? secs / 3600 : 0 };
}

// volume, surface area and size of a triangle soup given as a flat array of xyz triples (9 numbers per triangle)
function measure(t){
  let vol = 0, area = 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 8 < t.length; i += 9){
    const ax = t[i], ay = t[i + 1], az = t[i + 2], bx = t[i + 3], by = t[i + 4], bz = t[i + 5], cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    if (ax < x0) x0 = ax; if (bx < x0) x0 = bx; if (cx < x0) x0 = cx; if (ax > x1) x1 = ax; if (bx > x1) x1 = bx; if (cx > x1) x1 = cx;
    if (ay < y0) y0 = ay; if (by < y0) y0 = by; if (cy < y0) y0 = cy; if (ay > y1) y1 = ay; if (by > y1) y1 = by; if (cy > y1) y1 = cy;
    if (az < z0) z0 = az; if (bz < z0) z0 = bz; if (cz < z0) z0 = cz; if (az > z1) z1 = az; if (bz > z1) z1 = bz; if (cz > z1) z1 = cz;
  }
  const n = Math.floor(t.length / 9);
  if (!n || !isFinite(x0)) throw new Error('No shapes found in that file');
  return { volume: Math.abs(vol), area, size: [x1 - x0, y1 - y0, z1 - z0], triangles: n };
}

/* ---------- STL ---------- */
function stl(buf){
  const dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  if (n && 84 + n * 50 === buf.byteLength){        // binary
    const t = new Float32Array(n * 9);
    for (let i = 0, o = 84; i < n; i++, o += 50) for (let k = 0; k < 9; k++) t[i * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
    return t;
  }
  const txt = new TextDecoder().decode(buf), out = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; let m;
  while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
  return out;
}

/* ---------- OBJ ---------- */
function obj(buf){
  const v = [], out = [];
  for (const line of new TextDecoder().decode(buf).split('\n')){
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'f'){
      const idx = p.slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? v.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]){ const q = v[i]; if (!q) throw new Error('Broken OBJ file'); out.push(q[0], q[1], q[2]); }
    }
  }
  return out;
}

/* ---------- 3MF (a zip of XML meshes) ---------- */
async function unzipModels(buf){
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out = [];
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a valid 3MF file');
  let p = dv.getUint32(e + 16, true);
  const count = dv.getUint16(e + 10, true);
  for (let i = 0; i < count; i++){
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.model$/i.test(name)) continue;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const data = u8.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8){
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t open 3MF files. Try an STL');
      bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else continue;
    out.push(new TextDecoder().decode(bytes));
  }
  return out;
}
async function threemf(buf){
  const out = [];
  for (const xml of await unzipModels(buf)){
    // each <mesh>: <vertex x= y= z=/> list, then <triangle v1= v2= v3=/> indexes into it
    for (const mesh of xml.split(/<mesh\b/).slice(1)){
      const v = [], vre = /<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g; let m;
      const end = mesh.indexOf('</mesh>'), body = end >= 0 ? mesh.slice(0, end) : mesh;
      while ((m = vre.exec(body))) v.push(+m[1], +m[2], +m[3]);
      const tre = /<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"/g;
      while ((m = tre.exec(body))) for (const i of [+m[1], +m[2], +m[3]]) out.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    }
  }
  return out;
}

export async function readModel(file){
  const name = (file.name || '').toLowerCase(), buf = await file.arrayBuffer();
  if (name.endsWith('.3mf')) return measure(await threemf(buf));
  if (name.endsWith('.obj')) return measure(obj(buf));
  if (name.endsWith('.stl')) return measure(stl(buf));
  throw new Error('Use an STL, 3MF or OBJ file');
}
