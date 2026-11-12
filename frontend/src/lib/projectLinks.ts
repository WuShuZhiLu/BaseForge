/**
 * BaseForge 官方仓库 / 分发地址的单一来源。
 *
 * 客户端里凡是要展示「GitHub / Release 下载 / Docker」入口的地方都从这里取，
 * 避免仓库改名或迁移后各处硬编码出现漂移。
 */

export const PROJECT_REPO_URL = "https://github.com/WuShuZhiLu/BaseForge";
export const PROJECT_RELEASES_URL = `${PROJECT_REPO_URL}/releases`;
export const PROJECT_LATEST_RELEASE_URL = `${PROJECT_RELEASES_URL}/latest`;
export const PROJECT_DOCS_BASE_URL = `${PROJECT_REPO_URL}/blob/main/docs`;

/** Docker Hub 镜像名，与 .env.example 的 BASEFORGE_IMAGE_REPOSITORY 保持一致。 */
export const PROJECT_DOCKER_IMAGE = "wushuzhilu/baseforge";
export const PROJECT_DOCKER_RUN_COMMAND =
  `docker run -d --name baseforge -p 3001:3001 -v ~/baseforge-data:/app/data ${PROJECT_DOCKER_IMAGE}:latest`;

/** Gitee 镜像仓库，需与发布同步脚本的 GITEE_REPO 配置一致。 */
export const PROJECT_GITEE_REPO = { owner: "wushuzhilu", repo: "base-forge" } as const;

/** 上游项目地址：仅用于 GPL 归属声明，不是本产品的下载入口。 */
export const UPSTREAM_PROJECT_URL = "https://github.com/cropflre/baseforge";
