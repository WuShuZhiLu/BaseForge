# 数据备份与迁移

> 定期备份数据，防止意外丢失。支持跨服务器迁移。

---

## 数据位置

所有数据在 SQLite 数据库文件中：`data/baseforge.db`

附件图片在：`data/attachments/`

---

## 备份方法

### 自动备份（推荐）

设置 → 数据管理 → 定时备份 → 设置频率和保留份数

### 手动备份

```bash
cp data/baseforge.db "data/baseforge.db.bak.$(date +%Y%m%d)"
```

### Docker 卷备份

```bash
docker-compose stop
cp -r ./data ./data-backup-$(date +%Y%m%d)
docker-compose start
```

---

## 恢复数据

### 应用内恢复

设置 → 数据管理 → 备份列表 → 选择恢复

### 手动恢复

```bash
docker-compose stop
cp data/baseforge.db.bak data/baseforge.db
docker-compose start
```

---

## 跨服务器迁移

### 方法一：数据库文件

1. 旧服务器停止服务
2. 复制 `data/` 目录到新服务器
3. 新服务器启动

```bash
docker-compose stop
scp -r ./data user@新服务器:/path/to/nowen-note/data
# 新服务器
docker-compose up -d
```

### 方法二：导入/导出

旧服务器：设置 → 数据管理 → 导出数据 → 下载

新服务器：设置 → 数据管理 → 导入数据 → 上传

---

## 邮件备份

配置 SMTP 后可自动发送备份邮件。参考 [邮件备份配置](../backup-email-smtp.md)。

---

## 最佳实践

- 至少每周备份一次
- 备份文件多地保存
- 定期测试恢复
- 升级前先备份

---

## 下一步

- [Docker 一键部署](./docker-deploy.md)
- [NAS 部署教程](./nas-deploy.md)

---

> 本教程基于 nowen-note v1.1.18 编写。
