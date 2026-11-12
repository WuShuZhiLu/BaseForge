/**
 * 品牌化环境变量读取：优先 `BASEFORGE_<NAME>`，兼容历史 `BASEFORGE_<NAME>`。
 * 用于部署/运维面（端口、镜像 tag、updater 参数等）——新配置写 BASEFORGE_，
 * 旧 compose/文档里的 BASEFORGE_ 仍然能用，避免升级即断。
 */
export function brandEnv(name: string): string | undefined {
  const next = process.env[`BASEFORGE_${name}`];
  if (next !== undefined && next !== "") return next;
  return process.env[`BASEFORGE_${name}`];
}
