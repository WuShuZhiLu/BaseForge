import { inferBrowserServerBaseUrl } from "./serverUrl";

/**
 * pdfjs cMap / 标准字体资源的绝对基址（由 vite 的 pdfjsAssetsPlugin 提供）。
 *
 * 注意必须返回绝对路径：应用是 path 路由（如 /kb/xxx/notes/1），
 * 相对路径会按当前页面 URL 解析成 /kb/xxx/pdfjs/... 而落空，
 * 表现为中文 PDF 丢字、部分页渲染失败空白。
 */
export function pdfjsAssetUrl(kind: "cmaps" | "standard_fonts"): string {
  const suffix = `pdfjs/${kind}/`;
  if (typeof window === "undefined" || window.location.protocol === "file:") {
    return import.meta.env.BASE_URL + suffix;
  }
  // 反代子路径部署时 inferBrowserServerBaseUrl 给出部署前缀，其余场景为 ""
  const base = inferBrowserServerBaseUrl(window.location);
  const prefix = base ? new URL(base).pathname.replace(/\/+$/, "") : "";
  return `${window.location.origin}${prefix}/${suffix}`;
}
