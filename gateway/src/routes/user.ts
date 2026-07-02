/**
 * 用户相关 REST API 端点 — 客户端通过 HTTP 调用的路由
 *
 * 每个端点:
 *   1. JWT 中间件已提取 user_id → request.userId
 *   2. 构造请求 body (与 user.proto 对齐)
 *   3. 调用 userClient 转发到 C++ user-service
 *   4. 返回响应给客户端
 *
 * 路由前缀: /api
 */

import type { FastifyInstance } from "fastify";
import { userClient } from "../clients/user_client.js";
import { sessionStore } from "../auth/session.js";
import { logger } from "../utils/logger.js";
import {
  type RegisterReq,
  type LoginReq,
  type SearchUsersReq,
} from "../clients/user_client.js";

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // =====================================================================
  // 认证相关
  // =====================================================================

  /**
   * POST /api/auth/register
   * 注册新用户 (注册即登录，返回 Token)
   */
  app.post<{ Body: RegisterReq }>(
    "/api/auth/register",
    async (request, reply) => {
      const { username, password, first_name, last_name, phone, invite_hash } =
        request.body;

      // 基础参数校验
      if (!username || !password || !first_name) {
        return reply.status(400).send({
          error_code: 1104,
          error_message: "username, password, and first_name are required",
        });
      }

      logger.info({ username }, "Register request");

      const result = await userClient.register({
        username,
        password,
        first_name,
        last_name: last_name ?? "",
        phone: phone ?? "",
        invite_hash: invite_hash ?? "",
      });

      return reply.send(result);
    }
  );

  /**
   * POST /api/auth/login
   * 用户名+密码登录
   */
  app.post<{ Body: LoginReq }>(
    "/api/auth/login",
    async (request, reply) => {
      const { username, password, device_name, device_type } = request.body;

      if (!username || !password) {
        return reply.status(400).send({
          error_code: 1006,
          error_message: "username and password are required",
        });
      }

      logger.info({ username }, "Login request");

      const result = await userClient.login({
        username,
        password,
        device_name: device_name ?? "",
        device_type: device_type ?? "",
      });

      return reply.send(result);
    }
  );

  /**
   * POST /api/auth/refresh
   * 刷新 Token (Token 轮转)
   */
  app.post<{ Body: { refresh_token: string } }>(
    "/api/auth/refresh",
    async (request, reply) => {
      const { refresh_token } = request.body;

      if (!refresh_token) {
        return reply.status(400).send({
          error_code: 1004,
          error_message: "refresh_token is required",
        });
      }

      const result = await userClient.refreshToken({ refresh_token });
      return reply.send(result);
    }
  );

  /**
   * POST /api/auth/logout
   * 登出 (需认证)
   */
  app.post("/api/auth/logout", async (request, reply) => {
    const userId = request.userId;
    const sessionId = request.sessionId;
    if (userId === undefined) {
      return reply.status(401).send({
        error_code: 1004,
        error_message: "Authentication required",
      });
    }

    // Phase 2.1: 注销当前 session 和该用户的所有 session
    if (sessionId) {
      await sessionStore.invalidate(sessionId);
    }
    await sessionStore.invalidateAllForUser(userId);

    const result = await userClient.logout(userId);
    return reply.send(result);
  });

  // =====================================================================
  // 资料查询
  // =====================================================================

  /**
   * GET /api/users/:id
   * 获取单个用户资料
   */
  app.get<{ Params: { id: string } }>(
    "/api/users/:id",
    async (request, reply) => {
      const idParam = request.params.id;

      // 支持按 user_id 或 @username 查询
      const isNumeric = /^\d+$/.test(idParam);

      const result = await userClient.getUserProfile(
        isNumeric
          ? { user_id: parseInt(idParam, 10) }
          : { username: idParam }
      );

      return reply.send(result);
    }
  );

  /**
   * POST /api/users/batch
   * 批量获取用户资料
   */
  app.post<{ Body: { user_ids: number[] } }>(
    "/api/users/batch",
    async (request, reply) => {
      const { user_ids } = request.body;

      if (!user_ids || !Array.isArray(user_ids)) {
        return reply.status(400).send({
          error_code: 1101,
          error_message: "user_ids array is required",
        });
      }

      if (user_ids.length > 100) {
        return reply.status(400).send({
          error_code: 1101,
          error_message: "Maximum 100 user_ids per request",
        });
      }

      const result = await userClient.getUsers({ user_ids });
      return reply.send(result);
    }
  );

  // =====================================================================
  // 资料修改 (均需认证)
  // =====================================================================

  /**
   * PATCH /api/users/me
   * 更新当前用户资料
   */
  app.patch<{
    Body: {
      first_name?: string;
      last_name?: string;
      bio?: string;
      avatar_photo_id?: string;
    };
  }>("/api/users/me", async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.status(401).send({
        error_code: 1004,
        error_message: "Authentication required",
      });
    }

    const result = await userClient.updateProfile(userId, request.body);
    return reply.send(result);
  });

  /**
   * PUT /api/users/me/username
   * 修改用户名
   */
  app.put<{ Body: { new_username: string } }>(
    "/api/users/me/username",
    async (request, reply) => {
      const userId = request.userId;
      if (userId === undefined) {
        return reply.status(401).send({
          error_code: 1004,
          error_message: "Authentication required",
        });
      }

      const { new_username } = request.body;
      if (!new_username) {
        return reply.status(400).send({
          error_code: 1104,
          error_message: "new_username is required",
        });
      }

      const result = await userClient.changeUsername(userId, new_username);
      return reply.send(result);
    }
  );

  /**
   * PUT /api/users/me/password
   * 修改密码
   */
  app.put<{ Body: { old_password: string; new_password: string } }>(
    "/api/users/me/password",
    async (request, reply) => {
      const userId = request.userId;
      if (userId === undefined) {
        return reply.status(401).send({
          error_code: 1004,
          error_message: "Authentication required",
        });
      }

      const { old_password, new_password } = request.body;
      if (!old_password || !new_password) {
        return reply.status(400).send({
          error_code: 1006,
          error_message: "old_password and new_password are required",
        });
      }

      const result = await userClient.changePassword(
        userId,
        old_password,
        new_password
      );

      // Phase 2.1: 密码修改后清除所有旧 session (强制重新登录)
      if (result.error_code === 0) {
        await sessionStore.invalidateAllForUser(userId);
        logger.info({ userId }, "All sessions invalidated after password change");
      }

      return reply.send(result);
    }
  );

  /**
   * DELETE /api/users/me
   * 删除账户
   */
  app.delete<{ Body: { password: string; reason?: string } }>(
    "/api/users/me",
    async (request, reply) => {
      const userId = request.userId;
      if (userId === undefined) {
        return reply.status(401).send({
          error_code: 1004,
          error_message: "Authentication required",
        });
      }

      const { password, reason } = request.body;
      if (!password) {
        return reply.status(400).send({
          error_code: 1006,
          error_message: "password is required for account deletion",
        });
      }

      const result = await userClient.deleteAccount(
        userId,
        password,
        reason ?? ""
      );
      return reply.send(result);
    }
  );

  // =====================================================================
  // 搜索 & 检查
  // =====================================================================

  /**
   * GET /api/users/check-username/:username
   * 检查用户名可用性
   */
  app.get<{ Params: { username: string } }>(
    "/api/users/check-username/:username",
    async (request, reply) => {
      const { username } = request.params;
      const result = await userClient.checkUsername(username);
      return reply.send(result);
    }
  );

  /**
   * GET /api/users/search
   * 搜索用户 (按 username 或 first_name 前缀匹配)
   */
  app.get<{
    Querystring: { query: string; limit?: string; offset_id?: string };
  }>("/api/users/search", async (request, reply) => {
    const { query, limit, offset_id } = request.query;

    if (!query) {
      return reply.status(400).send({
        error_code: 1101,
        error_message: "query parameter is required",
      });
    }

    const req: SearchUsersReq = {
      query,
      limit: limit ? parseInt(limit, 10) : 20,
      offset_id: offset_id ? parseInt(offset_id, 10) : 0,
    };

    const result = await userClient.searchUsers(req);
    return reply.send(result);
  });
}
