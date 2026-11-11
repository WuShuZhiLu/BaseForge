/**
 * 由图标母图重新生成各端「启动图 / 开屏」资产 —— 统一品牌，避免旧 baseforge 标记残留。
 *
 * 源：build/icon-source.svg（几何与配色唯一来源）
 *
 * 输出：
 *   1. Android（Capacitor @capacitor/splash-screen 使用 @drawable/splash）
 *      frontend/android/app/src/main/res/drawable[-xxxhdpi]/splash.png
 *      —— 背景 #F5F3EE + 居中品牌图标
 *      尺寸与 logo 占比沿用原资产（logo ≈ 短边 26.8%，居中）
 *   2. iOS
 *      frontend/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png
 *      —— 背景 #F5F3EE + 居中品牌图标（短边 26.8%，与 Android 同比例）
 *   3. Windows 便携版解包开屏
 *      build/portable-splash.bmp —— 1bpp 单色黑白（沿用原格式），文案改为 BaseForge
 *
 * 用法：node scripts/build-splash-assets.mjs
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MASTER = path.join(root, "build/icon-source.svg");
const BASE = 1024;

const ANDROID_BG = { r: 245, g: 243, b: 238, alpha: 1 }; // #F5F3EE（与 capacitor.config SplashScreen.backgroundColor 一致）

const TILE = "#352D49";

/* ---------------- Android / iOS 启动图 ---------------- */

const ANDROID_SPLASHES = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
];

async function makeSplash(outPath, W, H, bg, logoSize) {
  const icon = await sharp(path.join(root, "electron/icon.png"))
    .resize(logoSize, logoSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const left = Math.round((W - logoSize) / 2);
  const top = Math.round((H - logoSize) / 2);
  await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
    .composite([{ input: icon, left, top }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return path.relative(root, outPath);
}

/* ---------------- Windows 便携版开屏（1bpp BMP） ---------------- */

function parseMarkPolygons() {
  const svg = fs.readFileSync(MASTER, "utf8");
  const out = [];
  // 母图把图形放在一个 <g transform="translate(A,B) scale(S) translate(C,D)"> 里，
  // 这里必须把这个变换算进去，否则取到的是变换前的坐标，位置与大小全错。
  let g = { a: 0, b: 0, s: 1, c: 0, d: 0 };
  const gm = svg.match(
    /<g[^>]*transform="translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)\s*scale\(\s*([-\d.]+)\s*\)\s*translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)"/
  );
  if (gm) g = { a: +gm[1], b: +gm[2], s: +gm[3], c: +gm[4], d: +gm[5] };
  const mapPt = ([x, y]) => [
    g.a + g.s * (x + g.c),
    g.b + g.s * (y + g.d),
  ];
  const re = /<polygon\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const fill = (attrs.match(/fill="([^"]*)"/) || [])[1] || "#000000";
    const pts = (attrs.match(/points="([^"]*)"/) || [])[1];
    if (!pts) continue;
    out.push({
      fill,
      points: pts.trim().split(/\s+/).map((p) => mapPt(p.split(",").map(Number))),
    });
  }
  return out;
}

function buildPortableSplashSvg(W, H) {
  const polys = parseMarkPolygons();
  // 记号包围盒：直接由换算后的多边形点算出来。
  // 母图的 <g> 比例会变（当前 scale 0.6911 ⇒ 占画幅 ~60%），写死坐标会随比例改动作废。
  const xs = polys.flatMap((p) => p.points.map(([x]) => x));
  const ys = polys.flatMap((p) => p.points.map(([, y]) => y));
  const box = {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
  const scale = 62 / (box.y1 - box.y0); // 记号高约 62px
  const ox = 34;
  const oy = 46;
  const tx = (x) => (ox + (x - box.x0) * scale).toFixed(2);
  const ty = (y) => (oy + (y - box.y0) * scale).toFixed(2);

  const shapes = polys
    .map((p) => {
      // 字怀 = 底色（靛蓝）→ 单色下变黑（透出背景）；其余 → 白
      const color = p.fill.toUpperCase() === TILE ? "#000000" : "#ffffff";
      const pts = p.points.map(([x, y]) => `${tx(x)},${ty(y)}`).join(" ");
      return `  <polygon points="${pts}" fill="${color}"/>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000000"/>
  <rect x="3.5" y="3.5" width="${W - 7}" height="${H - 7}" rx="10" fill="none" stroke="#ffffff" stroke-width="1.5"/>
${shapes}
  <text x="118" y="75" font-family="Arial, Segoe UI, Helvetica, sans-serif" font-size="22" font-weight="700" fill="#ffffff">BaseForge</text>
  <text x="118" y="95" font-family="Arial, Segoe UI, Helvetica, sans-serif" font-size="13" fill="#ffffff">Starting application…</text>
  <circle cx="148" cy="118" r="3" fill="#ffffff"/>
  <circle cx="164" cy="118" r="3" fill="#ffffff"/>
  <circle cx="180" cy="118" r="3" fill="#ffffff"/>
  <line x1="22" y1="148" x2="${W - 22}" y2="148" stroke="#ffffff" stroke-width="1"/>
  <text x="22" y="172" font-family="Arial, Segoe UI, Helvetica, sans-serif" font-size="12" fill="#ffffff">Preparing portable files…</text>
</svg>
`;
}

function write1bppBmp(grayRaw, W, H, outPath, threshold = 115) {
  const rowBytes = Math.ceil(W / 32) * 4;
  const dataOffset = 14 + 40 + 8; // file header + BITMAPINFOHEADER + 2 色调色板
  const fileSize = dataOffset + rowBytes * H;
  const buf = Buffer.alloc(fileSize);

  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(dataOffset, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(H, 22); // 正数 = 自下而上
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(1, 28); // 1bpp
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(rowBytes * H, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(2, 46);
  buf.writeUInt32LE(2, 50);
  // 调色板：0=黑，1=白
  const pal = dataOffset - 8;
  buf.writeUInt32LE(0x00000000, pal);
  buf.writeUInt32LE(0x00ffffff, pal + 4);

  for (let y = 0; y < H; y++) {
    const srcY = H - 1 - y; // BMP 自下而上
    const rowStart = dataOffset + y * rowBytes;
    for (let x = 0; x < W; x++) {
      const lum = grayRaw[srcY * W + x];
      if (lum > threshold) {
        buf[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  fs.writeFileSync(outPath, buf);
  return path.relative(root, outPath);
}

/* ---------------- main ---------------- */

async function main() {
  if (!fs.existsSync(MASTER)) throw new Error(`找不到图标母图：${MASTER}`);

  // 1) Android
  for (const [dir, W, H] of ANDROID_SPLASHES) {
    const logoSize = Math.round(0.268 * Math.min(W, H));
    const out = path.join(root, "frontend/android/app/src/main/res", dir, "splash.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    console.log(`[splash] ${await makeSplash(out, W, H, ANDROID_BG, logoSize)}  ${W}x${H} logo ${logoSize}`);
  }

  // 2) iOS
  const iosDir = path.join(root, "frontend/ios/App/App/Assets.xcassets/Splash.imageset");
  if (fs.existsSync(iosDir)) {
    const S = 2732;
    const logoSize = Math.round(0.268 * S); // 与 Android 同一比例（短边 26.8%）
    for (const name of fs.readdirSync(iosDir).filter((n) => n.endsWith(".png"))) {
      const out = path.join(iosDir, name);
      console.log(`[splash] ${await makeSplash(out, S, S, ANDROID_BG, logoSize)}  ${S}x${S} logo ${logoSize}`);
    }
  }

  // 3) Windows 便携版开屏
  const bmpOut = path.join(root, "build/portable-splash.bmp");
  if (fs.existsSync(bmpOut)) {
    const W = 360;
    const H = 200;
    const svg = buildPortableSplashSvg(W, H);
    // 4x 渲染再下采样：保留笔画灰度，二值化后小字才不会断笔
    const { data, info } = await sharp(Buffer.from(svg), { density: 72 * 4 })
      .resize(W, H, { kernel: "lanczos3" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    console.log(`[splash] ${write1bppBmp(data, info.width, info.height, bmpOut)}  ${info.width}x${info.height} 1bpp`);
  } else {
    console.log("[splash] 跳过 build/portable-splash.bmp（文件不存在）");
  }
}

main().catch((err) => {
  console.error("[splash] 失败：", err);
  process.exit(1);
});
