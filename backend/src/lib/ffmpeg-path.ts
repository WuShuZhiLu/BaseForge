/**
 * ffmpeg 可执行文件定位
 * ---------------------------------------------------------------------------
 * 原先只在 services/modern-media.ts（Live Photo 转码）里解析，视频海报
 * （services/thumbnails.ts）同样需要。放在 lib 而不是让 thumbnails 反向依赖
 * modern-media：后者顶层 import 了 db/schema，缩略图模块要保持"纯 fs + sharp"
 * 的轻量依赖，方便单测和复用。
 */
import { createRequire } from "node:module";

/**
 * 优先级：环境变量 FFMPEG_PATH（部署方可指向系统 ffmpeg）→ 随包分发的
 * ffmpeg-static → 退化为 PATH 中的 "ffmpeg"（不存在时调用方会拿到 spawn
 * ENOENT 并自行降级）。
 */
export function getMediaFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const require = createRequire(__filename);
  try {
    return require("ffmpeg-static") || "ffmpeg";
  } catch {
    // ffmpeg-static 是可选的 native 依赖，缺失平台装不上时整体降级
    return "ffmpeg";
  }
}
