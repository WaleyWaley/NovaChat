/**
 * WebSocket 连接管理器
 * 注意: user_id 统一使用 string 类型 (Snowflake 64-bit 超出 JS Number 安全精度)
 */

import type { WebSocket } from "ws";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

interface ConnectionEntry {
  ws: WebSocket;
  userId: string;
  username: string;
  connectedAt: number;
  lastHeartbeat: number;
}

let _instanceId = 0;
export class ConnectionManager {
  public readonly _id = ++_instanceId;
  private readonly byUserId = new Map<string, ConnectionEntry>();
  private readonly bySocket = new Map<WebSocket, string>();
  private readonly processedPushIds = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  register(userId: number | string, username: string, ws: WebSocket): boolean {
    const uid = String(userId);
    if (this.byUserId.size >= config.WS_MAX_CONNECTIONS) {
      logger.warn({ count: this.byUserId.size }, "Max connections reached");
      return false;
    }
    const existing = this.byUserId.get(uid);
    if (existing) {
      logger.info({ userId: uid }, "Replacing existing connection");
      this.kickExisting(existing);
    }
    const entry: ConnectionEntry = { ws, userId: uid, username, connectedAt: Date.now(), lastHeartbeat: Date.now() };
    this.byUserId.set(uid, entry);
    this.bySocket.set(ws, uid);
    console.log(`[register] uid="${uid}" username="${username}" mapSize=${this.byUserId.size} allKeys=[${[...this.byUserId.keys()].join(',')}]`);
    logger.info({ userId: uid, username, onlineCount: this.byUserId.size }, "User connected");
    return true;
  }

  unregister(ws: WebSocket): string | null {
    const userId = this.bySocket.get(ws);
    if (userId === undefined) return null;
    const entry = this.byUserId.get(userId);
    if (entry && entry.ws !== ws) { this.bySocket.delete(ws); return null; }
    this.byUserId.delete(userId);
    this.bySocket.delete(ws);
    logger.info({ userId, onlineCount: this.byUserId.size }, "User disconnected");
    return userId;
  }

  getByUserId(userId: number | string): WebSocket | null {
    const entry = this.byUserId.get(String(userId));
    return entry && entry.ws.readyState === 1 ? entry.ws : null;
  }

  getUserId(ws: WebSocket): string | null { return this.bySocket.get(ws) ?? null; }

  isOnline(userId: number | string): boolean {
    const entry = this.byUserId.get(String(userId));
    return entry !== undefined && entry.ws.readyState === 1;
  }

  getOnlineCount(): number { return this.byUserId.size; }

  getOnlineUserIds(): string[] { return [...this.byUserId.keys()]; }

  sendToUser(userId: number | string, message: unknown): boolean {
    const key = String(userId);
    const entry = this.byUserId.get(key);
    console.log(`[sendToUser] key="${key}" found=${!!entry} readyState=${entry?.ws?.readyState} mapSize=${this.byUserId.size} mapKeys=[${[...this.byUserId.keys()].join(',')}]`);
    if (!entry || entry.ws.readyState !== 1) return false;
    try { entry.ws.send(JSON.stringify(message)); return true; }
    catch (err) { logger.error({ userId, err }, "Failed to send"); return false; }
  }

  sendToUsers(userIds: (number | string)[], message: unknown): [string[], string[]] {
    const delivered: string[] = []; const missed: string[] = [];
    for (const id of userIds) {
      if (this.sendToUser(id, message)) delivered.push(String(id));
      else missed.push(String(id));
    }
    return [delivered, missed];
  }

  kickUser(userId: number | string, reason: number, message: string): boolean {
    const uid = String(userId);
    const entry = this.byUserId.get(uid);
    if (!entry || entry.ws.readyState !== 1) return false;
    try { entry.ws.send(JSON.stringify({ type: "kicked", payload: { reason, message } })); } catch {}
    setTimeout(() => entry.ws.close(4001, message), 100);
    this.byUserId.delete(uid); this.bySocket.delete(entry.ws);
    logger.info({ userId: uid, reason }, "User kicked");
    return true;
  }

  refreshHeartbeat(ws: WebSocket): void {
    const userId = this.bySocket.get(ws);
    if (userId) { const e = this.byUserId.get(userId); if (e) e.lastHeartbeat = Date.now(); }
  }

  startHeartbeat(intervalSec: number = config.WS_HEARTBEAT_INTERVAL): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now(); const timeoutMs = config.WS_CONNECTION_TIMEOUT * 1000;
      for (const [uid, entry] of this.byUserId) {
        if (now - entry.lastHeartbeat > timeoutMs) {
          logger.warn({ userId: uid }, "Heartbeat timeout");
          entry.ws.close(4002, "Heartbeat timeout");
          this.byUserId.delete(uid); this.bySocket.delete(entry.ws);
        }
      }
    }, intervalSec * 1000);
    logger.info({ intervalSec }, "Heartbeat monitor started");
  }

  stopHeartbeat(): void { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  isDuplicatePush(pushId: number | string): boolean {
    const pid = String(pushId);
    if (this.processedPushIds.has(pid)) return true;
    if (this.processedPushIds.size >= config.PUSH_DEDUP_SIZE) {
      const entries = [...this.processedPushIds];
      for (let i = 0; i < Math.floor(entries.length / 2); i++) this.processedPushIds.delete(entries[i]);
    }
    this.processedPushIds.add(pid);
    return false;
  }

  disconnectAll(reason: string = "Server shutting down"): void {
    for (const [, entry] of this.byUserId) { try { entry.ws.close(4000, reason); } catch {} }
    this.byUserId.clear(); this.bySocket.clear();
    logger.info({ reason }, "All connections closed");
  }

  private kickExisting(entry: ConnectionEntry): void {
    try { entry.ws.close(4001, "Replaced by new connection"); } catch {}
    this.bySocket.delete(entry.ws);
  }
}

export const connectionManager = new ConnectionManager();
