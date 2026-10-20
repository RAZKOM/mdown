// Draws the app icon and writes every format that needs it into ../assets (all committed, so
// building mdown never needs Node):
//   icon.svg       the source drawing
//   icon.png       256 px, for the README
//   icon.ico       Windows icon file
//   mdown.res   the same icon as a precompiled Windows resource, linked into the .exe by build.rs
//   icon.icns      macOS icon, copied into the app bundle by `mdown install`
//   icon-64.rgba   raw pixels for the window icon (tao Icon::from_rgba)
// Run with `node mkicon.mjs`.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f8cff"/>
      <stop offset="1" stop-color="#5b3fd9"/>
    </linearGradient>
  </defs>
  <rect x="12" y="12" width="232" height="232" rx="54" fill="url(#bg)"/>
  <rect x="58" y="42" width="140" height="172" rx="16" fill="#ffffff"/>
  <rect x="78" y="68" width="82" height="18" rx="9" fill="#4338ca"/>
  <rect x="78" y="104" width="100" height="11" rx="5.5" fill="#c7d2fe"/>
  <rect x="78" y="126" width="100" height="11" rx="5.5" fill="#c7d2fe"/>
  <rect x="78" y="148" width="68" height="11" rx="5.5" fill="#c7d2fe"/>
  <rect x="78" y="176" width="100" height="22" rx="6" fill="#e0e7ff"/>
</svg>
`;

const png = (size) => new Resvg(SVG, { fitTo: { mode: "width", value: size } }).render().asPng();
const out = (name, data) => writeFileSync(new URL(`../assets/${name}`, import.meta.url), data);
mkdirSync(new URL("../assets/", import.meta.url), { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = new Map([...sizes, 512].map((s) => [s, png(s)]));

out("icon.svg", SVG);
out("icon.png", pngs.get(256));

// ---- Windows .ico: ICONDIR, one 16-byte ICONDIRENTRY per image, then the PNG data
{
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const data = pngs.get(s);
    const at = 6 + 16 * i;
    head[at] = head[at + 1] = s === 256 ? 0 : s; // 0 means 256
    head.writeUInt16LE(1, at + 4); // planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  out("icon.ico", Buffer.concat([head, ...sizes.map((s) => pngs.get(s))]));
}

// ---- Windows .res (what rc.exe would emit for `1 ICON icon.ico`), so users building with
// `cargo install` don't need the Windows SDK. link.exe takes .res files directly.
{
  const RT_ICON = 3;
  const RT_GROUP_ICON = 14;
  const resource = (type, name, data) => {
    const h = Buffer.alloc(32);
    h.writeUInt32LE(data.length, 0); // DataSize
    h.writeUInt32LE(32, 4); // HeaderSize
    h.writeUInt16LE(0xffff, 8); h.writeUInt16LE(type, 10);
    h.writeUInt16LE(0xffff, 12); h.writeUInt16LE(name, 14);
    h.writeUInt16LE(0x1030, 20); // MOVEABLE | PURE | DISCARDABLE, as rc.exe sets for icons
    h.writeUInt16LE(0x0409, 22); // en-US
    return Buffer.concat([h, data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  };
  const group = Buffer.alloc(6 + 14 * sizes.length);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(sizes.length, 4);
  sizes.forEach((s, i) => {
    const at = 6 + 14 * i;
    group[at] = group[at + 1] = s === 256 ? 0 : s;
    group.writeUInt16LE(1, at + 4);
    group.writeUInt16LE(32, at + 6);
    group.writeUInt32LE(pngs.get(s).length, at + 8);
    group.writeUInt16LE(i + 1, at + 12); // RT_ICON id
  });
  const empty = Buffer.alloc(32);
  empty.writeUInt32LE(32, 4);
  empty.writeUInt16LE(0xffff, 8);
  empty.writeUInt16LE(0xffff, 12);
  out(
    "mdown.res",
    Buffer.concat([empty, ...sizes.map((s, i) => resource(RT_ICON, i + 1, pngs.get(s))), resource(RT_GROUP_ICON, 1, group)]),
  );
}

// ---- macOS .icns: 'icns', total length, then (type, length, PNG) blocks, all big-endian
{
  const kinds = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512],
    ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512], // the @2x variants
  ];
  const blocks = kinds.map(([type, size]) => {
    const data = pngs.get(size);
    const h = Buffer.alloc(8);
    h.write(type, 0, "ascii");
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(blocks);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  out("icon.icns", Buffer.concat([h, body]));
}

// ---- raw RGBA for the window icon; resvg hands back premultiplied pixels, windows want straight
{
  const r = new Resvg(SVG, { fitTo: { mode: "width", value: 64 } }).render();
  const px = Buffer.from(r.pixels);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a > 0 && a < 255) for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, Math.round((px[i + c] * 255) / a));
  }
  out("icon-64.rgba", px);
  console.log("window icon:", r.width, "x", r.height, "bytes", px.length);
}
console.log("wrote assets/ icon.svg icon.png icon.ico mdown.res icon.icns icon-64.rgba");
