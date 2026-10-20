// Generates tiny sample models for samples/: an ASCII STL pyramid and a GLB cube.
import { writeFileSync } from "node:fs";

const p = [[0,0,0],[2,0,0],[2,2,0],[0,2,0],[1,1,2]];
const faces = [[0,2,1],[0,3,2],[0,1,4],[1,2,4],[2,3,4],[3,0,4]];
const norm = (a,b,c) => { const u=b.map((v,i)=>v-a[i]), w=c.map((v,i)=>v-a[i]); const n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]]; const l=Math.hypot(...n)||1; return n.map(v=>v/l); };
let stl = "solid pyramid\n";
for (const f of faces) { const [a,b,c]=f.map(i=>p[i]); stl += `facet normal ${norm(a,b,c).join(" ")}\n outer loop\n`; for (const v of [a,b,c]) stl += `  vertex ${v.join(" ")}\n`; stl += " endloop\nendfacet\n"; }
writeFileSync("../samples/models/pyramid.stl", stl + "endsolid pyramid\n");

// GLB: unit cube with per-face normals, one material.
const cube = [], idx = [];
const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
dirs.forEach((n, f) => {
  const a = n.map((v,i)=>[1,0,0][i]); // placeholder to keep tangent maths readable
  const t = Math.abs(n[1]) === 1 ? [1,0,0] : [0,1,0];
  const b = [n[1]*t[2]-n[2]*t[1], n[2]*t[0]-n[0]*t[2], n[0]*t[1]-n[1]*t[0]];
  const base = f * 4;
  for (const [s, r] of [[-1,-1],[1,-1],[1,1],[-1,1]]) cube.push(...n.map((v,i)=>(v + s*t[i]*1 + r*b[i]*1)/2), ...n);
  idx.push(base,base+1,base+2, base,base+2,base+3);
});
const vbuf = Buffer.from(new Float32Array(cube).buffer);
const ibuf = Buffer.from(new Uint16Array(idx).buffer);
const bin = Buffer.concat([vbuf, ibuf]);
const json = {
  asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.2, 0.55, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.6 } }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5,-0.5,-0.5], max: [0.5,0.5,0.5] },
    { bufferView: 0, byteOffset: 12, componentType: 5126, count: 24, type: "VEC3" },
    { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
  ],
  bufferViews: [{ buffer: 0, byteLength: vbuf.length, byteStride: 24 }, { buffer: 0, byteOffset: vbuf.length, byteLength: ibuf.length }],
  buffers: [{ byteLength: bin.length }],
};
const pad = (b, ch) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, ch)]);
const j = pad(Buffer.from(JSON.stringify(json)), 0x20), bn = pad(bin, 0);
const head = Buffer.alloc(12); head.write("glTF"); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bn.length, 8);
const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.write(type, 4); return h; };
writeFileSync("../samples/models/cube.glb", Buffer.concat([head, ch(j.length, "JSON"), j, ch(bn.length, "BIN\0"), bn]));

