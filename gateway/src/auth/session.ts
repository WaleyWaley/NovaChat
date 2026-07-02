/**
 * Session 管理 — 会话生命周期跟踪
 *
 * Phase 2.1: 内存实现 (Map + 索引), 支持 logout/password-change 即时失效
 * Phase 2.2: 升级为 Redis 实现 (接口不变)
 *
 * 核心用途:
 *   - 用户登出时立即标记 session 为失效
 *   - 修改密码后清空所有旧 session (强制重新登录)
 *   - Token 验证时检查 session 是否已被撤销
 */

import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ---- 类型 ----

export interface Session {
  /** JWT payload 中的 session_id (由签发方生成) */
  sessionId: string;
  userId: number;
  deviceName?: string;
  deviceType?: string;
  createdAt: number; // unix ms
  expiresAt: number; // unix ms (Token exp 时间)
  /** 非 undefined 表示已被撤销的时间 */
  invalidatedAt?: number; // unix ms
  lastActivityAt: number; // unix ms
}

// ---- SessionStore 接口 ----

export interface SessionStore {
  /** 创建新 session。如果 sessionId 已存在则忽略 (去重)。 */
  create(session: Omit<Session, "lastActivityAt">): Promise<void>;

  /** 根据 sessionId 查找 */
  get(sessionId: string): Promise<Session | null>;

  /** 查找某用户的所有 session */
  findByUserId(userId: number): Promise<Session[]>;

  /** 标记单个 session 为失效 (登出) */
  invalidate(sessionId: string): Promise<void>;

  /** 标记用户所有 session 为失效 (改密码、删号) */
  invalidateAllForUser(userId: number): Promise<void>;

  /** 更新 session 活跃时间 */
  updateActivity(sessionId: string): Promise<void>;

  /** 清理过期和已失效的 session，返回清理数量 */
  cleanup(): Promise<number>;
}

// ---- InMemorySessionStore ----

export class InMemorySessionStore implements SessionStore {
  /** sessionId → Session */
  private readonly sessions = new Map<string, Session>();

  /** userId → Set<sessionId> 反向索引 */
  private readonly userIndex = new Map<number, Set<string>>();

  /** 清理定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;

  // ---- SessionStore 实现 ----

  async create(session: Omit<Session, "lastActivityAt">): Promise<void> {
    if (this.sessions.has(session.sessionId)) {
      return; // 已存在，幂等
    }

    const full: Session = {
      ...session,
      lastActivityAt: Date.now(),
    };

    this.sessions.set(session.sessionId, full);

    // 维护反向索引
    let idSet = this.userIndex.get(session.userId);
    if (!idSet) {
      idSet = new Set();
      this.userIndex.set(session.userId, idSet);
    }
    idSet.add(session.sessionId);
  }

  async get(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * 同步查询 session (供 verifyAccessToken 等同步函数使用)
   * Phase 2.2 升级 Redis 后此方法将被移除，verifyAccessToken 改为 async
   */
  getSync(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async findByUserId(userId: number): Promise<Session[]> {
    const idSet = this.userIndex.get(userId);
    if (!idSet) return [];

    const results: Session[] = [];
    for (const sid of idSet) {
      const s = this.sessions.get(sid);
      if (s) results.push(s);
    }
    return results;
  }

  async invalidate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.invalidatedAt = Date.now();
      logger.debug({ sessionId, userId: session.userId }, "Session invalidated");
    }
  }

  async invalidateAllForUser(userId: number): Promise<void> {
    const idSet = this.userIndex.get(userId);
    if (!idSet) return;

    const now = Date.now();
    let count = 0;
    for (const sid of idSet) {
      const s = this.sessions.get(sid);
      if (s && !s.invalidatedAt) {
        s.invalidatedAt = now;
        count++;
      }
    }

    logger.info({ userId, invalidatedCount: count }, "All user sessions invalidated");
  }

  async updateActivity(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [sid, session] of this.sessions) {
      // 清理: 已过期 或 失效超过 1 天
      if (
        session.expiresAt < now ||
        (session.invalidatedAt && now - session.invalidatedAt > 24 * 3600 * 1000)
      ) {
        this.sessions.delete(sid);
        const idSet = this.userIndex.get(session.userId);
        if (idSet) {
          idSet.delete(sid);
          if (idSet.size === 0) {
            this.userIndex.delete(session.userId);
          }
        }
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug({ removed, remaining: this.sessions.size }, "Session cleanup completed");
    }
    return removed;
  }

  // ---- 生命周期 ----

  /** 启动定时清理 */
  startCleanupTimer(intervalMs: number = config.SESSION_CLEANUP_INTERVAL): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) =>
        logger.error({ err }, "Session cleanup error")
      );
    }, intervalMs);
    logger.info(
      { intervalMs },
      "Session cleanup timer started"
    );
  }

  /** 停止定时清理 */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 当前 session 数量 */
  get size(): number {
    return this.sessions.size;
  }
}

/** 全局单例 */
export const sessionStore = new InMemorySessionStore();
