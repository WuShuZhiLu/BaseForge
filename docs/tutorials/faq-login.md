# 登录和鉴权常见问题

> 解决登录失败、密码问题、2FA 等常见问题。

---

## 登录失败

### Q：提示「用户名或密码错误」？

1. 确认用户名和密码正确
2. 默认管理员：`admin` / `admin123`
3. 检查大小写
4. 联系管理员重置密码

### Q：提示「网络错误」？

1. 检查服务器地址是否正确
2. 确认服务器正在运行
3. 检查网络连接

### Q：Docker 部署后打不开？

1. 确认 Docker 容器正在运行：`docker-compose ps`
2. 检查端口映射是否正确
3. 查看日志：`docker-compose logs`

---

## 密码问题

### Q：忘记密码？

管理员可以帮普通用户重置密码。

如果是管理员自己忘记密码：

```bash
# Docker 环境
docker-compose exec backend node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const db = new DatabaseSync('data/baseforge.db');
const hash = bcrypt.hashSync('新密码', 10);
db.prepare('UPDATE users SET passwordHash = ? WHERE username = ?').run(hash, 'admin');
console.log('密码已重置');
"
```

### Q：密码修改后其他设备需要重新登录吗？

修改密码后，其他设备的 JWT 会在到期后失效，需要重新登录。

---

## 两步验证（2FA）

### Q：手机丢失了怎么办？

使用恢复码登录。登录后在安全设置中重新配置 2FA。

### Q：验证码总是不对？

1. 确认手机时间准确（2FA 验证码基于时间）
2. 确认使用的是正确的验证器 App
3. 尝试输入下一个验证码（可能刚好跨时间窗口）

### Q：如何关闭 2FA？

登录后 → 安全设置 → 两步验证 → 关闭 → 输入当前验证码确认。

---

## 体验账号

### Q：体验账号有哪些限制？

- 无法修改密码和用户名
- 无法启用/关闭 2FA
- 数据可能被定期重置

### Q：如何从体验账号转为正式账号？

体验账号无法升级。需要管理员创建新账号，或自行部署。

---

## 快速登录

### Q：什么是快速登录？

快速登录是一种无需输入密码的登录方式，适合个人设备。启用后下次打开会自动登录。

### Q：如何启用快速登录？

登录时勾选「记住密码」或「自动登录」。

---

## 下一步

- [安全设置](./security.md) — 密码和 2FA
- [数据备份与迁移](./backup-migrate.md) — 备份数据

---

> 本教程基于 nowen-note v1.1.18 编写。
