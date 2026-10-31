import { WebSocketServer, type WebSocket } from "ws";
import { pathToFileURL } from "url";
import { MiniConnectionManager } from "./MiniConnectionManager.js";
/**
 * 简化的 WebSocket 服务器
 *
 * 协议（和 NovaChat 网关一致）：
 * - 客户端先发 { type: "auth", seq, payload: { access_token, username } }
 * - 服务端回 { type: "auth_ok", seq, payload: { user_id, username } }
 * - 之后客户端可以发 ping，服务端回 pong
 * - 服务端可主动推送消息
 *
 * 本实验室只关注连接管理，access_token 不做真实 JWT 校验。
 */

interface ClientMessage {
  type: string;
  seq: number;
  payload?: Record<string, unknown>;
}

function buildAuthOk(seq: number, userId: string, username: string) {
  return { type: "auth_ok", seq, payload: { user_id: userId, username } };
}

function buildPong(seq: number) {
  return { type: "pong", seq };
}

function buildError(seq: number, code: number, message: string) {
  return { type: "error", seq, payload: { code, message } };
}

export class MiniWebSocketServer {
  private readonly manager = new MiniConnectionManager();
  private readonly wss: WebSocketServer;
  private readonly authenticated =  new WeakSet<WebSocket>();
  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
  }

  start(): void {
    this.wss.on("connection", (ws) => {
      console.log("[server] new connection");

      // 发送 welcome
      ws.send(JSON.stringify({ type: "welcome", payload: { message: "Mini WS Server" } }));

      ws.on("message", (rawData) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(rawData.toString()) as ClientMessage;
        } catch {
          ws.send(JSON.stringify(buildError(0, 1302, "Invalid JSON")));
          return;
        }

        if (!this.authenticated.has(ws) && msg.type !== "auth" && msg.type !== "ping") {
            ws.send(JSON.stringify(buildError(msg.seq, 1004, "Authentication required")));
            return;
        }

        if (msg.type === "auth") {
          this.handleAuth(ws, msg);
        } else if (msg.type === "ping") {
          this.handlePing(ws, msg);
        } else {
          ws.send(JSON.stringify(buildError(msg.seq, 1302, `Unknown message type:${msg.type}`)));
        }
      });

      ws.on("close", () => {
        this.manager.unregister(ws);
        this.authenticated.delete(ws);
        
        console.log("[server] connection closed");
      });

      ws.on("error", (err) => {
        console.error("[server] ws error", err);
      });
    });

    // 启动心跳
    this.manager.startHeartbeat(5, 15);

    console.log(`[server] Mini WebSocket server listening on ws://localhost:${this.wss.options.port}`);
  }

  private handleAuth(ws: WebSocket, msg: ClientMessage): void {
    const payload = msg.payload ?? {};
    const username = (payload.username as string) || "user";
    const userId = (payload.user_id as string | number) || username;

    const ok = this.manager.register(userId, username, ws);
    if (!ok) {
      ws.send(JSON.stringify(buildError(msg.seq, 5002, "Server busy")));
      ws.close(4000, "Server busy");
      return;
    }

    ws.send(JSON.stringify(buildAuthOk(msg.seq, String(userId), username)));
    this.authenticated.add(ws);
    console.log(`[server] user ${userId} (${username}) authenticated`);
  }

  private handlePing(ws: WebSocket, msg: ClientMessage): void {
    this.manager.refreshHeartbeat(ws);
    ws.send(JSON.stringify(buildPong(msg.seq)));
  }

  /** 外部调用：向某个用户推送消息 */
  pushToUser(userId: string | number, message: unknown): boolean {
    return this.manager.sendToUser(userId, message);
  }

  /** 外部调用：获取在线用户数 */
  getOnlineCount(): number {
    return this.manager.getOnlineCount();
  }

  /** 外部调用：强制踢人 */
  kickUser(userId: string | number, reason: string): boolean {
    return this.manager.kickUser(userId, reason);
  }

  stop(): void {
    this.manager.stopHeartbeat();
    this.manager.disconnectAll("Server stopping");
    this.wss.close();
  }
}

// 只有直接运行本文件时才自动启动服务器（被 import 时不启动，方便测试）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parseInt(process.argv[2] || "3001", 10);
  const server = new MiniWebSocketServer(port);
  server.start();

  // 用于测试：每 10 秒向所有在线用户广播一条消息
  setInterval(() => {
    const count = server.getOnlineCount();
    if (count > 0) {
      console.log(`[server] online count: ${count}`);
    }
  }, 10000);
}
