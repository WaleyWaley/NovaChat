/**
 * 消息历史 REST 路由 — 前端刷新后恢复会话列表与历史消息 (Phase 4.2)
 *
 * 鉴权: JWT 中间件注入 request.userId, 网关不信任客户端传的 user_id
 */

import type { FastifyInstance } from "fastify";
import { messageClient } from "../clients/message_client.js";
import { logger } from "../utils/logger.js";

interface DialogsBody {
  limit?: number;
}

interface HistoryBody {
  peer_type?: number;
  peer_id?: string | number;
  limit?: number;
  offset_id?: string | number;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/messages/dialogs
   * 我聊过天的对端列表 (双向: 我发出的 + 发给我的)
   */
  app.post<{ Body: DialogsBody }>(
    "/api/messages/dialogs",
    async (request, reply) => {
      // JWT 从中间件拿到request.userId
      const userId = request.userId;
      if (userId === undefined) {
        return reply.status(401).send({
          error_code: 1004,
          error_message: "Authentication required",
        });
      }

      logger.debug({ userId }, "Fetching dialogs");
      const result = await messageClient.getDialogs(userId);
      return reply.send(result);
    }
  );

  /**
   * POST /api/messages/history
   * 与某个对端的完整双向历史 (游标分页, 最新优先)
   */
  app.post<{ Body: HistoryBody }>(
    "/api/messages/history",
    async (request, reply) => {
      const userId = request.userId;
      if (userId === undefined) {
        return reply.status(401).send({
          error_code: 1004,
          error_message: "Authentication required",
        });
      }

      const { peer_type, peer_id, limit, offset_id } = request.body;
      if (!peer_id) {
        return reply.status(400).send({
          error_code: 1302,
          error_message: "peer_id is required",
        });
      }

      logger.debug({ userId, peer_id }, "Fetching conversation history");
      const result = await messageClient.getConversation({
        user_id: userId,
        peer_type: peer_type ?? 1,
        peer_id,
        limit: limit ?? 50,
        offset_id: offset_id ?? 0,
      });
      return reply.send(result);
    }
  );
}
