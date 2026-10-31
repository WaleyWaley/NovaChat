import { WebSocket } from "ws";

/**
 * 单个连接的状态
 */
export interface ConnectionEntry {
  ws: WebSocket;
  userId: string;
  username: string;
  connectedAt: number;
  lastHeartbeat: number;
}

/**
 * WebSocket 连接管理器（简化版）
 *
 * 学习目标：
 * 1. 用两个 Map 实现 userId ↔ WebSocket 双向索引
 * 2. 心跳检测：定时扫描，超时断开
 * 3. 同用户多端互踢
 * 4. 单播 / 广播 / 踢人
 */
export class MiniConnectionManager {
  // userId -> ConnectionEntry：用于根据目标用户快速找到 socket
  private readonly byUserId = new Map<string, ConnectionEntry>();

  // WebSocket -> userId：用于连接断开时反向查找用户
  private readonly bySocket = new Map<WebSocket, string>();

  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly maxConnections: number = 10000) {}

  /**
   * 注册一个已认证用户的连接
   *
   * 实现步骤：
   * 1. 把 userId 统一转成 string
   * 2. 如果 byUserId.size >= maxConnections，返回 false
   * 3. 如果该 userId 已有连接，调用内部方法踢掉旧连接
   * 4. 创建 ConnectionEntry，其中 lastHeartbeat = Date.now()
   * 5. 更新 byUserId 和 bySocket
   * 6. 返回 true
   */
  register(userId: string | number, username: string, ws: WebSocket): boolean {
    // TODO: implement
    const userId_ = userId.toString();
    if (this.byUserId.size >= this.maxConnections) {
        return false;
    }
    // 判断是否userId已经有连接
    const existing = this.byUserId.get(userId_);
    if (existing) {
        this.kickExisting(existing);
    }
    const entry_: ConnectionEntry = {ws: ws,userId: userId_, username: username, connectedAt:Date.now(), lastHeartbeat: Date.now()};

    this.byUserId.set(userId_, entry_);
    this.bySocket.set(ws, userId_);
    return true;
  }

  /**
   * 注销一个 WebSocket 连接
   *
   * 实现步骤：
   * 1. 通过 bySocket 找到 userId
   * 2. 安全检查：如果 byUserId 里存的 entry.ws 不是当前 ws，
   *    说明这个 ws 是旧连接，只从 bySocket 删除，返回 null
   * 3. 否则从两个 Map 都删除，返回 userId
   */
  unregister(ws: WebSocket): string | null {
    // 查询当前ws对于的userId
    const userId_ = this.bySocket.get(ws);
    if (userId_ === undefined) {
        return null;
    }
    // 查询当前userId对于的ws
    const entry_ = this.byUserId.get(userId_ as string);
    if (entry_ && entry_.ws !== ws) {
        // 旧连接的关闭回调，byUserId里已经是新连接了
        this.bySocket.delete(ws);
        return null;
    }
    this.bySocket.delete(ws);
    this.byUserId.delete(userId_);
    return userId_;
  }

  /** 根据 userId 获取 WebSocket（仅当 readyState === 1 时返回） */
  getByUserId(userId: string | number): WebSocket | null {
    const entry = this.byUserId.get(userId.toString());
    if (entry !== undefined) {
        const ws_: WebSocket = entry.ws;
        if(ws_.readyState === WebSocket.OPEN)
            return ws_;
    }
    return null;
  }

  /** 判断用户是否在线 */
  isOnline(userId: string | number): boolean {
    return this.getByUserId(userId) !== null;
  }

  /** 当前在线连接数 */
  getOnlineCount(): number {
    return this.byUserId.size;
  }

  /** 所有在线用户 ID */
  getOnlineUserIds(): string[] {
    const allId: string[] = [];
    for (const [uid, _] of this.byUserId) {
        allId.push(uid);
    }
    return allId;
  }

  /**
   * 向单个用户发送消息
   *
   * 实现步骤：
   * 1. 找到 entry
   * 2. 检查 ws.readyState === 1（WebSocket.OPEN）
   * 3. 用 JSON.stringify 后 ws.send
   * 4. 捕获异常，失败返回 false
   */
  sendToUser(userId: string | number, message: unknown): boolean {
    const entry = this.byUserId.get(userId.toString());
    if (entry === undefined || entry.ws.readyState !== WebSocket.OPEN) {
        return false;
    } else {
        const ws_: WebSocket = entry.ws;
        const message_ = JSON.stringify(message);
        try {
            ws_.send(message_);
        } catch (err) {
            console.log(err);
            return false;
        }
        return true;
    }
  }

  /**
   * 批量发送消息
   *
   * 返回 [delivered, missed]
   * delivered: 成功送达的用户 ID 列表
   * missed: 未送达的用户 ID 列表
   */
  sendToUsers(
        userIds: (string | number)[],
        message: unknown
    ): [string[], string[]] {
        const delivered: string[] = [];
    const missed: string[] = [];
    const message_ = JSON.stringify(message);
    for (const userId of userIds) {
        const userId_: string = userId.toString();
        const entry_ = this.byUserId.get(userId_);

        // 用户不在线和ws没连接，短路求解，当entry_是undefined就不会判断||后面的
        if (entry_ === undefined || entry_.ws.readyState !== WebSocket.OPEN) {
            missed.push(userId_);
            continue;
        }

        try {
            entry_.ws.send(message_);
            delivered.push(userId_);
        } catch (err) {
            missed.push(userId_);
            console.error("ws.send()异常:", err);
        }
    }
    return [delivered, missed];
  }
  /**
   * 强制断开某用户的连接
   *
   * 实现步骤：
   * 1. 找到 entry，检查 readyState
   * 2. 先发 { type: "kicked", payload: { reason } }
   * 3. 等待 100ms 后 ws.close(4001, reason)
   * 4. 从 byUserId 和 bySocket 删除
   */
  kickUser(userId: string | number, reason: string): boolean {
    const userId_: string = userId.toString();
    const entry = this.byUserId.get(userId_);
    if (entry === undefined || entry.ws.readyState !== WebSocket.OPEN) {
        return false;
    } else {
        const ws_: WebSocket = entry.ws;
        const msg: object = { type: "kicked", payload: { reason } };
        // 没写在setTimeout是防止在这100ms里userId又连接的新的ws然后被误删了
        this.byUserId.delete(userId_);
        this.bySocket.delete(ws_);
        //ws的send回调签名是(err?:undefined)，成功就是undefined。
        ws_.send(JSON.stringify(msg), (err) => {
            if (err) {
                console.error("发送失败：", err);
            }
        });
        // 4001是自定的错误码
        setTimeout(() => {
            ws_.close(4001, reason);
        }, 100);
        return true;
    }
  }

  /** 刷新某条连接的心跳时间 */
  refreshHeartbeat(ws: WebSocket): void {
    const userId = this.bySocket.get(ws);
    if (userId === undefined) {
        console.error("当前WS未找到");
        return;
    }

    const entry = this.byUserId.get(userId);
    if (entry === undefined) {
        console.error("当前UserId对应的连接未找到");
        return;
    }
    entry.lastHeartbeat = Date.now();
  }

  /**
   * 启动心跳检测定时器
   *
   * 实现步骤：
   * 1. 如果 heartbeatTimer 已存在，直接返回
   * 2. setInterval 每隔 intervalSec 秒执行一次
   * 3. 遍历 byUserId 中所有 entry
   * 4. 如果 Date.now() - entry.lastHeartbeat > timeoutSec * 1000
   *    - 打日志 "Heartbeat timeout"
   *    - ws.close(4002, "Heartbeat timeout")
   *    - 从 byUserId 和 bySocket 删除
   */
  startHeartbeat(intervalSec: number = 30, timeoutSec: number = 120): void {
    if (this.heartbeatTimer !== null) {
        return;
    } else {
        this.heartbeatTimer = setInterval(() => {
            const timeOut: { userId: string, entry: ConnectionEntry }[] = [];
            for (const [userId, entry] of this.byUserId) {
                if (Date.now() - entry.lastHeartbeat > timeoutSec * 1000) {
                    timeOut.push({ userId, entry });
                }
            }
            for (const { userId, entry } of timeOut) {
                console.log("Heartbeat timeout:", userId);
                entry.ws.close(4002, "Heartbeat timeout");
                this.byUserId.delete(userId);
                this.bySocket.delete(entry.ws);
            }
        },intervalSec*1000);
    }
  }

  /** 停止心跳检测 */
  stopHeartbeat(): void {
    if (this.heartbeatTimer === null) {
        return;
    }
    else {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        return;
    }
  }

  /** 断开所有连接 */
  disconnectAll(reason: string = "Server shutting down"): void {
    if (this.byUserId.size === 0) {
        return;
    }
    for(const [_, entry] of this.byUserId)
    {
        entry.ws.close(4000, reason);
    }
    this.bySocket.clear();
    this.byUserId.clear();
  }

  /**
   * 内部方法：踢掉旧连接
   * 注意：这里只从 bySocket 删除旧 ws，不删 byUserId，
   * 因为马上会被新连接覆盖
   */
  private kickExisting(entry: ConnectionEntry): void {
    try {
      entry.ws.close(4001, "Replaced by new connection");
    } catch {
      // ignore
    }
    this.bySocket.delete(entry.ws);
  }
}
