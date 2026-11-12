import type { Migration } from "./migrations.impl.js";

/**
 * v141：关闭新账号首次登录自动写入的中英文使用指南。
 *
 * 背景：新数据库应当空白起步，知识库里不该自带一堆示例文档。v67 建了
 * INSERT 触发种子、v68 又把它收窄到「首次确认登录」，这里直接把两个触发器删掉，
 * 后续新建的账号（含 seedDatabase 创建的默认 admin）登录后知识树保持为空。
 *
 * 存量账号已经写入的指南属于用户内容，不做删除。
 * 幂等：IF EXISTS，重复执行安全。
 */
export const disableOnboardingSeedMigration: Migration = {
  version: 141,
  name: "disable-new-user-onboarding-seed",
  up(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS users_seed_onboarding_after_insert;
      DROP TRIGGER IF EXISTS users_seed_onboarding_on_first_login;
    `);
  },
};
