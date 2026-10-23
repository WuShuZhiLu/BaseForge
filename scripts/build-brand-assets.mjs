/**
 * 从图标母图派生各尺寸品牌 SVG 资产
 *
 * 源：build/icon-source.svg（1024 唯一母图）
 * 做法：直接复用母图内容、只改 width/height（viewBox 保持 0 0 1024 1024），
 *       因此不论母图里是 rect / polygon / path / clipPath 都能等比派生，
 *       不会出现"某个图元被漏掉"或"手工简化版与母图不一致"的问题。
 *
 * 输出：
 *   - frontend/public/favicon.svg                    32   浏览器标签页
 *   - frontend/public/favicon-mono.svg               32   自适应深浅主题（class + media query）
 *   - frontend/public/base-notes-icon.svg            32   index.html 引用的应用图标
 *   - frontend/public/apple-touch-icon.svg           180  iOS / Android 主屏幕
 *   - frontend/public/icons/brand.svg                24   界面内品牌小图标
 *   - packages/nowen-clipper/public/icons/icon.svg   128  浏览器扩展工具栏图标
 *   - nowen-harmony/{AppScope,entry}/.../media/app_icon.svg  108  鸿蒙应用图标
 *
 * 用法：node scripts/build-brand-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MASTER = path.join(root, "build/icon-source.svg");
const VB = 1024; // 母图 viewBox 边长

/** 取母图根节点内部内容（去掉外层 <svg> 与注释） */
function masterBody(svgText) {
  const inner = svgText.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return inner
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[ \t]+$/gm, "")
    .trim();
}

function svgDoc({ width, height, body, comment, style = "", extraRootAttrs = "" }) {
  if (!width) {
    // 无 width（如鸿蒙）→ 保留 viewBox 自适应
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}"${extraRootAttrs}>
  <!-- ${comment} -->
${style}${body}
</svg>
`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${VB} ${VB}"${extraRootAttrs}>
  <!-- ${comment} -->
${style}${body}
</svg>
`;
}

function writeSvg(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  console.log(`[brand-assets] 写入 ${path.relative(root, absPath)}`);
}

function main() {
  const body = masterBody(fs.readFileSync(MASTER, "utf8"));
  if (!body.includes("clipPath") && !body.includes("polygon")) {
    throw new Error(`母图解析异常：${MASTER}`);
  }

  const DERIVED = "由 build/icon-source.svg 派生，请勿手改；改图标请改母图后重跑本脚本";

  for (const rel of ["frontend/public/favicon.svg", "frontend/public/base-notes-icon.svg"]) {
    writeSvg(path.join(root, rel), svgDoc({ width: 32, height: 32, body, comment: `BaseForge 图标（32）· ${DERIVED}` }));
  }

  writeSvg(
    path.join(root, "frontend/public/apple-touch-icon.svg"),
    svgDoc({ width: 180, height: 180, body, comment: `BaseForge iOS / Android 主屏幕图标（180）· ${DERIVED}` })
  );

  writeSvg(
    path.join(root, "frontend/public/icons/brand.svg"),
    svgDoc({
      width: 24,
      height: 24,
      body,
      comment: `BaseForge 品牌小图标（24）· ${DERIVED}`,
      extraRootAttrs: ' fill="none"',
    })
  );

  writeSvg(
    path.join(root, "packages/nowen-clipper/public/icons/icon.svg"),
    svgDoc({ width: 128, height: 128, body, comment: `BaseForge Web Clipper 工具栏图标 · ${DERIVED}` })
  );

  // 自适应深浅主题：把母图里的 fill 换成 class
  {
    const CLASS_MAP = {
      "#352D49": "tile",
      "#F3E3C4": "letter",
      "#C59348": "base",
      "#90989E": "facet",
      "#3B3A93": "tile",
      "#F7F4EC": "letter",
      "#E0A344": "base",
      "#C5CFD3": "facet",
      "#9FB0BA": "facet",
      "#B0752B": "base",
    };
    const monoBody = body.replace(/fill="(#[0-9A-Fa-f]{6})"/g, (full, hexColor) => {
      const cls = CLASS_MAP[hexColor.toUpperCase()] || CLASS_MAP[hexColor] || "tile";
      return `class="${cls}"`;
    });
    const style = `  <style>
    .tile  { fill: #352D49; }
    .letter{ fill: #F3E3C4; }
    .base  { fill: #C59348; }
    .facet { fill: #90989E; }
    @media (prefers-color-scheme: dark) {
      .tile  { fill: #CFC9E6; }
      .letter{ fill: #241F3D; }
      .base  { fill: #D89A38; }
      .facet { fill: #AEB6BC; }
    }
  </style>
`;
    writeSvg(
      path.join(root, "frontend/public/favicon-mono.svg"),
      svgDoc({ width: 32, height: 32, body: monoBody, comment: `BaseForge 自适应深浅主题 favicon（32）· ${DERIVED}`, style })
    );
  }

  for (const rel of [
    "nowen-harmony/AppScope/resources/base/media/app_icon.svg",
    "nowen-harmony/entry/src/main/resources/base/media/app_icon.svg",
  ]) {
    writeSvg(path.join(root, rel), svgDoc({ body, comment: `BaseForge 鸿蒙应用图标（108）· ${DERIVED}` }));
  }
}

main();
