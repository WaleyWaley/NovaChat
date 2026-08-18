#pragma once

// =============================================================================
// NovaChat — 密码哈希工具 (PBKDF2-HMAC-SHA256)
//
// 使用 OpenSSL EVP 实现 PBKDF2 密钥派生, 适用于用户密码安全存储.
//
// 哈希格式 (Django/Passlib 风格):
//   $pbkdf2-sha256$<iterations>$<hex_salt>$<hex_hash>
//
// 参数:
//   - 算法:     PBKDF2-HMAC-SHA256
//   - 迭代次数: 100,000 (OWASP 2023 推荐最小值)
//   - Salt:     16 字节随机值
//   - 输出:     32 字节 (SHA256 长度)
//
// 使用:
//   std::string hash = nova::HashPassword("mypassword");
//   bool ok = nova::CheckPassword("mypassword", hash);
// =============================================================================

#include <string>

namespace nova {

// 对明文密码进行哈希, 返回格式化后的哈希字符串
// 每次调用生成新的随机 salt, 因此同一密码两次调用结果不同
std::string HashPassword(const std::string& password);

// 验证明文密码是否匹配已存储的哈希值
// hash: 由 HashPassword() 生成的字符串, 或 Phase 1 的 "hash:" 前缀格式
bool CheckPassword(const std::string& password, const std::string& hash);

}  // namespace nova
