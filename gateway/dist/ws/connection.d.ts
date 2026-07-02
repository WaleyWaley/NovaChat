/**
 * WebSocket 连接管理器 — 网关注册的核心数据结构
 *
 * 维护:
 *   - userId → WebSocket 映射 (在线路由)
 *   - WebSocket → userId 反向映射 (断开时清理)
 *   - push_id 去重缓存 (幂等推送)
 *
 * Node.js 单线程模型下无需 mutex，但需要注意异步 I/O 回调中的一致性。
 */
import type { WebSocket } from "ws";
export declare class ConnectionManager {
    /** userId → ConnectionEntry */
    private readonly byUserId;
    /** WebSocket → userId (用于 close 事件快速反查) */
    private readonly bySocket;
    /** push_id 去重缓存 (LRU 风格 — 超容量时清空最旧的一半) */
    private readonly processedPushIds;
    /** 心跳定时器 */
    private heartbeatTimer;
    /**
     * 用户上线注册
     * @returns false 如果已达最大连接数或用户已在线 (旧连接会被 kick)
     */
    register(userId: number, username: string, ws: WebSocket): boolean;
    /**
     * 用户下线注销 (由 WebSocket close 事件触发)
     */
    unregister(ws: WebSocket): number | null;
    /** 根据 userId 查找 WebSocket 连接 */
    getByUserId(userId: number): WebSocket | null;
    /** 根据 WebSocket 反查 userId */
    getUserId(ws: WebSocket): number | null;
    /** 用户是否在线 */
    isOnline(userId: number): boolean;
    /** 当前在线用户数 */
    getOnlineCount(): number;
    /** 获取所有在线 userId 列表 */
    getOnlineUserIds(): number[];
    /**
     * 向指定用户推送消息
     * @returns true 如果成功送达，false 如果用户不在线
     */
    sendToUser(userId: number, message: unknown): boolean;
    /**
     * 批量推送给同一网关节点的多个在线用户
     * @returns [deliveredIds, missedIds]
     */
    sendToUsers(userIds: number[], message: unknown): [number[], number[]];
    /**
     * 强制断开用户连接
     * @param reason KickReason 枚举值
     * @param closeCode WebSocket close code
     */
    kickUser(userId: number, reason: number, message: string): boolean;
    /** 更新用户心跳时间 */
    refreshHeartbeat(ws: WebSocket): void;
    /**
     * 启动心跳检测定时器
     * 定期扫描超时连接并主动断开
     */
    startHeartbeat(intervalSec?: number): void;
    /** 停止心跳检测 */
    stopHeartbeat(): void;
    /**
     * 检查并记录 push_id
     * @returns true 如果该 push_id 已经处理过 (应跳过)
     */
    isDuplicatePush(pushId: number): boolean;
    /**
     * 断开所有连接 (优雅关闭时调用)
     */
    disconnectAll(reason?: string): void;
    private kickExisting;
}
/**
 * 全局连接管理器单例
 * 所有路由和中间件共享此实例
 */
export declare const connectionManager: ConnectionManager;
//# sourceMappingURL=connection.d.ts.map