# JWT 密钥管理 (`keys.ts`)

## 技术职责

本模块实现 `KeyStore` 类，作为网关层所有 JWT 验证密钥的**集中配置中心**。它从多种来源加载密钥，并通过 `kid`（Key ID）机制支持多密钥共存与轮转。

核心能力包括：

- **密钥加载** — 启动时按优先级依次尝试三种来源：
  1. `JWT_PUBLIC_KEY_PATH` — 从 PEM 文件加载 RS256 公钥（**生产环境**）
  2. `JWT_EXTRA_KEYS` — 从 JSON 环境变量加载额外密钥（用于密钥轮转测试）
  3. `JWT_SECRET` — HS256 共享密钥（**开发环境回退**，含默认密钥警告）
- **密钥查找** — `getKey(kid?)` 方法优先精确匹配 `kid`，若未找到则回退到默认密钥。若没有任何密钥可用则抛出 `KeyStoreError`。
- **密钥轮转** — `addKey` 添加新密钥并自动设为默认，`removeKey` 移除已轮转的旧密钥（不能移除当前默认密钥），实现**零停机密钥替换**。
- **调试接口** — `listKeys()` 列出所有密钥的状态，便于运维排查。

## 业务角色

在 NovaChat 的安全架构中，密钥管理是**信任的基石**。网关持有公钥或共享密钥来验证 Token，但绝不触碰私钥：

1. **生产安全** — RS256 非对称算法确保私钥只存在于 C++ user-service，即使网关被攻破，攻击者也无法伪造合法 Token。
2. **密钥轮转** — 大型 IM 系统出于安全合规需要定期更换密钥，多 kid 支持使新旧密钥可以平滑过渡：旧密钥签发的 Token 在其有效期内仍然可用，新请求自动使用新密钥。
3. **开发友好** — 开发环境中自动回退到 HS256 共享密钥，无需配置 PEM 文件，降低本地开发门槛。默认密钥字符串带有醒目警告，防止误用于生产。

## 系统集成

- **`jwt.ts`** — `verifyAccessToken` 和 `verifyRefreshToken` 在验证 Token 前都通过 `keyStore.getKey(kid)` 获取对应公钥，完成签名验证。
- **环境配置** — 读取 `config/index.ts` 中的 `JWT_PUBLIC_KEY_PATH`、`JWT_EXTRA_KEYS`、`JWT_SECRET` 三个配置项。
- **C++ user-service** — 密钥对的分工：user-service 持有 RS256 私钥并负责签发 Token，网关仅持有公钥做验证。
