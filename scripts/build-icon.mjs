/**
 * 把图标母图 SVG 栅格化成 PC 端打包用的 icon.png
 *
 * 源优先级：
 *   1. build/icon-source.svg            —— 图标母图（精细版，应用图标设计定稿）
 *   2. frontend/public/favicon.svg      —— 回退（浏览器 favicon，32px 简化版）
 *
 * 用途：PC 端 electron 应用图标（electron/icon.png）
 * 输出：1024x1024 PNG
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const SIZE = 1024; // electron-builder 推荐的母图尺寸

const candidates = [
  path.join(root, "build/icon-source.svg"),
  path.join(root, "frontend/public/favicon.svg"),
];

function resolveSource() {
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 读取 SVG 根节点的 width，用于换算渲染密度 */
function readSvgWidth(svgText) {
  const match = svgText.match(/<svg[^>]*\bwidth=["']?([\d.]+)/i);
  const parsed = match ? Number.parseFloat(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
}

async function main() {
  const srcSvg = resolveSource();
  if (!srcSvg) {
    console.error("[build-icon] 找不到任何图标源 SVG：");
    for (const file of candidates) console.error(`  - ${file}`);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(srcSvg);
  const svgWidth = readSvgWidth(svgBuffer.toString("utf8"));

  // 按源 viewBox 宽度等比提升 density，让 sharp 按高 DPI 渲染保留锐利度
  const density = Math.max(96, 96 * (SIZE / svgWidth));

  await sharp(svgBuffer, { density })
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // 透明底
    })
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, "electron/icon.png"));

  const outPng = path.join(root, "electron/icon.png");
  const stat = fs.statSync(outPng);
  console.log(
    `[build-icon] 源：${path.relative(root, srcSvg)} (viewBox 宽 ${svgWidth})`
  );
  console.log(
    `[build-icon] 已生成 ${outPng} (${SIZE}x${SIZE}, ${(stat.size / 1024).toFixed(1)} KB)`
  );
}

main().catch((err) => {
  console.error("[build-icon] 失败：", err);
  process.exit(1);
});
