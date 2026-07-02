/**
 * JWT Key Store — 集中管理 JWT 验证密钥
 *
 * 支持:
 *   - RS256 非对称密钥 (PEM 文件加载, 生产环境)
 *   - HS256 共享密钥 (开发环境回退)
 *   - 多密钥轮转 (kid header 匹配)
 *   - Phase 3: 热加载 (SIGHUP / addKey / removeKey)
 *
 * 生产环境中网关只持有公钥用于验证，签名由 C++ user-service 的私钥完成。
 */

import { readFileSync, existsSync } from "fs";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ---- 类型 ----

export interface KeyEntry {
  /** JWT header 中的 kid，用于密钥查找 */
  kid: string;
  /** 签名算法 */
  algorithm: "RS256" | "HS256";
  /** PEM 格式公钥 (RS256) 或共享密钥 (HS256) */
  publicKey: string | Buffer;
  /** false = 已轮转但未过期 token 仍可用 */
  active: boolean;
}

export class KeyStoreError extends Error {
  constructor(
    message: string,
    public readonly kid?: string
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}

// ---- KeyStore ----

export class KeyStore {
  private keys = new Map<string, KeyEntry>();
  private defaultKid: string | null = null;

  constructor() {
    this.loadKeys();
  }

  // ---- 密钥查找 ----

  /**
   * 根据 kid 查找密钥。如果 kid 为 undefined 或找不到，返回默认密钥。
   */
  getKey(kid?: string): KeyEntry {
    // 1. 精确匹配
    if (kid && this.keys.has(kid)) {
      return this.keys.get(kid)!;
    }

    // 2. 回退到默认密钥
    if (this.defaultKid && this.keys.has(this.defaultKid)) {
      if (kid) {
        logger.debug({ kid, defaultKid: this.defaultKid }, "kid not found, using default key");
      }
      return this.keys.get(this.defaultKid)!;
    }

    // 3. 没有密钥可用
    throw new KeyStoreError(
      "No verification key available. Set JWT_PUBLIC_KEY_PATH for RS256 or JWT_SECRET for HS256 fallback.",
      kid
    );
  }

  /** 获取当前默认密钥的 kid */
  getDefaultKid(): string | null {
    return this.defaultKid;
  }

  // ---- 密钥管理 (Phase 3: 热加载) ----

  /** 添加新密钥，自动设为默认 */
  addKey(entry: KeyEntry): void {
    this.keys.set(entry.kid, entry);
    this.defaultKid = entry.kid;
    logger.info({ kid: entry.kid, algorithm: entry.algorithm }, "JWT key added");
  }

  /** 移除已轮转的密钥 */
  removeKey(kid: string): boolean {
    if (kid === this.defaultKid) {
      logger.warn({ kid }, "Cannot remove the default key");
      return false;
    }
    const existed = this.keys.delete(kid);
    if (existed) {
      logger.info({ kid }, "JWT key removed");
    }
    return existed;
  }

  /** 列出所有密钥 (调试用) */
  listKeys(): { kid: string; algorithm: string; active: boolean }[] {
    return [...this.keys.values()].map((k) => ({
      kid: k.kid,
      algorithm: k.algorithm,
      active: k.active,
    }));
  }

  // ---- 密钥加载 ----

  private loadKeys(): void {
    let loaded = false;

    // 1. 尝试从 PEM 文件加载 RS256 公钥 (生产环境)
    if (config.JWT_PUBLIC_KEY_PATH) {
      this.loadPemKey(config.JWT_PUBLIC_KEY_PATH);
      loaded = true;
    }

    // 2. 尝试从 JSON 环境变量加载额外密钥 (密钥轮转测试)
    if (config.JWT_EXTRA_KEYS) {
      this.loadExtraKeys(config.JWT_EXTRA_KEYS);
      loaded = true;
    }

    // 3. HS256 回退 (开发环境)
    if (!loaded && config.JWT_SECRET) {
      this.loadDevFallback(config.JWT_SECRET);
      loaded = true;
    }

    if (!loaded) {
      throw new KeyStoreError(
        "No JWT key source configured. Set JWT_PUBLIC_KEY_PATH, JWT_EXTRA_KEYS, or JWT_SECRET."
      );
    }

    logger.info(
      { keyCount: this.keys.size, defaultKid: this.defaultKid },
      "KeyStore initialized"
    );
  }

  private loadPemKey(path: string): void {
    if (!existsSync(path)) {
      throw new KeyStoreError(`JWT public key file not found: ${path}`);
    }

    const pem = readFileSync(path, "utf-8");
    if (!pem.includes("-----BEGIN")) {
      throw new KeyStoreError(
        `File at ${path} does not appear to be a valid PEM file`
      );
    }

    const entry: KeyEntry = {
      kid: "rs256-main",
      algorithm: "RS256",
      publicKey: pem,
      active: true,
    };

    this.keys.set(entry.kid, entry);
    this.defaultKid = entry.kid;

    logger.info({ path, kid: entry.kid }, "RS256 public key loaded from PEM");
  }

  private loadExtraKeys(jsonStr: string): void {
    let extraKeys: {
      kid: string;
      algorithm: "RS256" | "HS256";
      key: string;
      active?: boolean;
    }[];

    try {
      extraKeys = JSON.parse(jsonStr);
    } catch {
      logger.warn("JWT_EXTRA_KEYS is not valid JSON, ignoring");
      return;
    }

    if (!Array.isArray(extraKeys)) {
      logger.warn("JWT_EXTRA_KEYS is not a JSON array, ignoring");
      return;
    }

    for (const k of extraKeys) {
      const entry: KeyEntry = {
        kid: k.kid,
        algorithm: k.algorithm,
        publicKey: k.key,
        active: k.active ?? true,
      };
      this.keys.set(entry.kid, entry);
      this.defaultKid = entry.kid; // 最后一个成为默认
    }

    logger.info(
      { count: extraKeys.length },
      "Extra JWT keys loaded from JWT_EXTRA_KEYS"
    );
  }

  private loadDevFallback(secret: string): void {
    if (secret === "novachat-dev-secret-change-in-production") {
      logger.warn(
        "Using default JWT_SECRET — this is insecure for production!"
      );
    }

    const entry: KeyEntry = {
      kid: "dev-hs256",
      algorithm: "HS256",
      publicKey: secret,
      active: true,
    };

    this.keys.set(entry.kid, entry);
    this.defaultKid = entry.kid;

    logger.info({ kid: entry.kid }, "HS256 fallback key loaded (dev mode)");
  }
}

/** 全局单例 */
export const keyStore = new KeyStore();
