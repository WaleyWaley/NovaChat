/**
 * NovaChat Gateway — 头像上传/删除路由 (Phase 4.3)
 *
 * 链路: 客户端 multipart 上传 → 网关落盘到共享卷 AVATAR_DIR →
 *       avatar_photo_id (文件名) 写入 user-service → nginx 从同一卷静态服务。
 *
 * 安全要点:
 *   - 文件名由网关生成 (u<user_id>_<epoch>_<rand>.<ext>), 绝不用客户端原始文件名
 *   - mimetype 白名单 + 2MB 上限 (multipart 插件 limits)
 *   - 删除旧文件时 path.basename 校验, 防路径穿越
 *   - /api/users/me/avatar 不在 auth.ts 的 NO_AUTH 前缀列表 → 自动受 JWT 保护
 */
import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { pipeline } from "node:stream/promises";
import { createWriteStream, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { userClient } from "../clients/user_client.js";

/** mimetype → 扩展名白名单 */
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAX_SIZE = 2 * 1024 * 1024; // 2MB

/** 校验 avatar_photo_id 形如纯文件名 (防路径穿越) */
function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && path.basename(name) === name;
}

export async function avatarRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: { files: 1, fileSize: MAX_SIZE },
    // 默认 false 时 busboy 超限会静默截断 (2MB 截断后仍 200) — 显式抛错
    throwFileSizeLimit: true,
  });

  /**
   * POST /api/users/me/avatar — multipart 上传头像
   * body: file=<图片>  (png/jpeg/webp/gif, ≤2MB)
   */
  app.post("/api/users/me/avatar", async (request, reply) => {
    const userId = request.userId; // auth.ts 注入
    if (userId === undefined) {
      return reply.status(401).send({
        error_code: 1004,
        error_message: "Authentication required",
      });
    }

    const file = await request.file();
    if (!file) {
      return reply.status(400).send({
        error_code: 1302,
        error_message: "file field is required",
      });
    }

    const ext = EXT[file.mimetype];
    if (!ext) {
      return reply.status(400).send({
        error_code: 1302,
        error_message: "unsupported image type (png/jpeg/webp/gif only)",
      });
    }

    mkdirSync(config.AVATAR_DIR, { recursive: true });

    // 网关生成文件名: 用户ID + 毫秒时间戳 + 随机后缀 (新文件名天然绕开浏览器缓存)
    const rand = Math.random().toString(36).slice(2, 8);
    const name = `u${userId}_${Date.now()}_${rand}.${ext}`;
    const filePath = path.join(config.AVATAR_DIR, name);

    try {
      // 流式落盘: pipeline 完成保证文件已写完, 之后才更新 DB
      await pipeline(file.file, createWriteStream(filePath));

      // 超限检测: busboy 达到 fileSize 上限会截断流并置 truncated=true
      // (插件抛的 RequestFileTooLargeError 只在解析完整个请求后才送达,
      //  而单文件上传 handler 早已返回, 所以这里用 truncated 标志做确定性判断)
      if (file.file.truncated) {
        await unlink(filePath).catch(() => {});
        return reply.status(413).send({
          error_code: 1401, // FILE_TOO_LARGE
          error_message: "File too large (max 2MB)",
        });
      }
    } catch (err) {
      // 超限 (throwFileSizeLimit: true) → 文件流抛 RequestFileTooLargeError (413)
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 413) {
        await unlink(filePath).catch(() => {}); // 清掉可能写了一半的文件
        return reply.status(413).send({
          error_code: 1401, // FILE_TOO_LARGE
          error_message: "File too large (max 2MB)",
        });
      }
      logger.error({ err, userId }, "Failed to write avatar file");
      await unlink(filePath).catch(() => {});
      return reply.status(500).send({
        error_code: 5001,
        error_message: "Failed to save avatar file",
      });
    }

    // 先查旧头像 (更新前查, 更新后就是新文件名了), best-effort
    let oldAvatar = "";
    try {
      const prof = await userClient.getUserProfile({ user_id: userId });
      oldAvatar = prof.user?.avatar_photo_id ?? "";
    } catch {
      // 查不到旧头像不阻塞上传
    }

    // 更新 user-service 的资料 (avatar_photo_id 存文件名)
    const result = await userClient.updateProfile(userId, { avatar_photo_id: name });
    if (result.error_code && result.error_code !== 0) {
      // 回滚: DB 没更新成功, 删掉刚落盘的文件
      await unlink(filePath).catch(() => {});
      return reply.send(result);
    }

    // 顺带清理旧头像文件 (best-effort, 失败不影响上传成功)
    if (oldAvatar && isSafeName(oldAvatar)) {
      await unlink(path.join(config.AVATAR_DIR, oldAvatar)).catch(() => {});
    }

    logger.info({ userId, name }, "Avatar uploaded");
    return reply.send({
      error_code: 0,
      avatar_photo_id: name,
      avatar_url: `/avatars/${name}`,
    });
  });

  /**
   * DELETE /api/users/me/avatar — 移除头像
   * user_dao UpdateProfile 对 avatar_photo_id 无条件覆盖, 传 "" 即清空
   */
  app.delete("/api/users/me/avatar", async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.status(401).send({
        error_code: 1004,
        error_message: "Authentication required",
      });
    }

    // 先查当前头像, 删掉旧文件
    try {
      const prof = await userClient.getUserProfile({ user_id: userId });
      const old = prof.user?.avatar_photo_id;
      if (old && isSafeName(old)) {
        await unlink(path.join(config.AVATAR_DIR, old)).catch(() => {});
      }
    } catch {
      // 查询失败不阻塞清空操作
    }

    const result = await userClient.updateProfile(userId, { avatar_photo_id: "" });
    if (result.error_code && result.error_code !== 0) {
      return reply.send(result);
    }

    logger.info({ userId }, "Avatar removed");
    return reply.send({ error_code: 0 });
  });
}
