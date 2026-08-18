// =============================================================================
// NovaChat — 密码哈希实现 (PBKDF2-HMAC-SHA256 via OpenSSL EVP)
// =============================================================================

#include "nova/password.h"
#include "nova/logger.h"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <sstream>
#include <iomanip>
#include <cstring>

namespace nova {

namespace {

// PBKDF2 参数
constexpr int kIterations   = 100000;   // OWASP 2023 推荐最小值
constexpr int kSaltBytes    = 16;       // 128 bits salt (16字节随机数)
constexpr int kHashBytes    = 32;       // SHA256 → 256 bits
constexpr int kOutputBytes  = 32;       // 实际派生密钥长度

// Phase 1 兼容: "hash:" 前缀表示未哈希的明文
constexpr const char* kPhase1Prefix = "hash:";

// --- Hex 编解码 ---

std::string BytesToHex(const uint8_t* data, int len) {
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (int i = 0; i < len; i++) {
        oss << std::setw(2) << static_cast<int>(data[i]);
    }
    return oss.str();
}

bool HexToBytes(const std::string& hex, uint8_t* out, int out_len) {
    if (hex.size() != static_cast<size_t>(out_len * 2)) return false;
    for (int i = 0; i < out_len; i++) {
        unsigned int byte;
        std::stringstream ss;
        ss << std::hex << hex.substr(i * 2, 2);
        ss >> byte;
        out[i] = static_cast<uint8_t>(byte);
    }
    return true;
}

// --- PBKDF2 核心 ---

bool PBKDF2_HMAC_SHA256(const std::string& password,
                        const uint8_t* salt, int salt_len,
                        int iterations,
                        uint8_t* out, int out_len) {
    if (!password.empty() && password.size() > 1024) return false;

    int rc = PKCS5_PBKDF2_HMAC(
        password.data(), static_cast<int>(password.size()),
        salt, salt_len,
        iterations,
        EVP_sha256(),
        out_len, out);

    return rc == 1;
}

// --- 生成随机 Salt ---

bool GenerateSalt(uint8_t* salt, int len) {
    // 使用 OpenSSL 的加密安全随机数生成器
    int rc = RAND_bytes(salt, len);
    return rc == 1;
}

}  // anonymous namespace

// ============================= HashPassword ==================================

std::string HashPassword(const std::string& password) {
    if (password.empty()) {
        NOVA_LOG_WARN << "HashPassword: empty password";
        return "$pbkdf2-sha256$" + std::to_string(kIterations) + "$" +
               std::string(kSaltBytes * 2, '0') + "$" +
               std::string(kHashBytes * 2, '0');
    }

    // 1. 生成随机盐
    uint8_t salt[kSaltBytes];
    if (!GenerateSalt(salt, kSaltBytes)) {
        NOVA_LOG_ERROR << "HashPassword: failed to generate random salt";
        return "";
    }

    // 2. PBKDF2 派生密钥
    uint8_t derived[kOutputBytes];
    if (!PBKDF2_HMAC_SHA256(password, salt, kSaltBytes,
                            kIterations, derived, kOutputBytes)) {
        NOVA_LOG_ERROR << "HashPassword: PBKDF2 derivation failed";
        return "";
    }

    // 3. 格式化为字符串
    std::ostringstream oss;
    oss << "$pbkdf2-sha256$"
        << kIterations << "$"
        << BytesToHex(salt, kSaltBytes) << "$"
        << BytesToHex(derived, kOutputBytes);

    return oss.str();
}

// ============================= CheckPassword =================================

bool CheckPassword(const std::string& password, const std::string& hash) {
    if (password.empty() || hash.empty()) return false;

    // Phase 1 兼容: "hash:" 前缀直接比较明文
    if (hash.size() >= 5 && hash.substr(0, 5) == kPhase1Prefix) {
        bool match = (hash == "hash:" + password);
        if (match) {
            NOVA_LOG_WARN << "CheckPassword: Phase 1 plaintext hash detected, "
                          << "user should re-login to upgrade to PBKDF2";
        }
        return match;
    }

    // 解析 $pbkdf2-sha256$<iterations>$<hex_salt>$<hex_hash>
    // 格式检查
    const std::string prefix = "$pbkdf2-sha256$";
    if (hash.size() < prefix.size() ||
        hash.substr(0, prefix.size()) != prefix) {
        NOVA_LOG_ERROR << "CheckPassword: unknown hash format";
        return false;
    }

    // 提取各段: 跳过 prefix, 按 '$' 分割
    size_t pos = prefix.size();
    size_t next = hash.find('$', pos);
    if (next == std::string::npos) return false;
    int iterations = std::stoi(hash.substr(pos, next - pos));
    pos = next + 1;

    next = hash.find('$', pos);
    if (next == std::string::npos) return false;
    std::string hex_salt = hash.substr(pos, next - pos);
    pos = next + 1;

    std::string hex_hash = hash.substr(pos);

    // 解码 salt
    uint8_t salt[kSaltBytes];
    if (hex_salt.size() != kSaltBytes * 2) {
        NOVA_LOG_ERROR << "CheckPassword: invalid salt length";
        return false;
    }
    HexToBytes(hex_salt, salt, kSaltBytes);

    // PBKDF2 重算
    uint8_t computed[kOutputBytes];
    if (!PBKDF2_HMAC_SHA256(password, salt, kSaltBytes,
                            iterations, computed, kOutputBytes)) {
        return false;
    }

    // 常数时间比较 (防时序攻击)
    std::string hex_computed = BytesToHex(computed, kOutputBytes);
    if (hex_computed.size() != hex_hash.size()) return false;

    int result = 0;
    for (size_t i = 0; i < hex_computed.size(); i++) {
        result |= (hex_computed[i] ^ hex_hash[i]);
    }
    return result == 0;
}

}  // namespace nova
