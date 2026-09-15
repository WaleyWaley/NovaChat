/**
 * WS 通话/房间 handler — 从 main.ts 拆出
 *
 * handleCallSignal: WebRTC 信令转发 (offer/answer/ICE), 目标不在线回 1101
 * handleRoomSignal: 多人语音房间 (Mesh) — create/join/leave/invite/webrtc
 */

import { connectionManager } from "../connection.js";
import { roomManager } from "../room_manager.js";
import { logger } from "../../utils/logger.js";
import {
  buildCallSignal,
  buildError,
  buildRoomSignal,
  type ClientCallSignal,
  type ClientRoomSignal,
} from "../protocol.js";
import type { ClientSession } from "../client_session.js";

export function handleCallSignal(session: ClientSession, msg: ClientCallSignal): void {
  if (!session.authenticated) return;
  const { signal_type, to_user_id, data } = msg.payload;
  const targetWs = connectionManager.getByUserId(String(to_user_id));
  if (!targetWs) {
    session.send(buildError(msg.seq, 1101, "User not online"));
    return;
  }
  // 转发信令给目标用户
  const forward = buildCallSignal(signal_type, session.userId!, session.username, data);
  targetWs.send(JSON.stringify(forward));
  logger.info({ signal_type, from: session.userId, to: to_user_id }, "Call signal relayed");
}

export function handleRoomSignal(session: ClientSession, msg: ClientRoomSignal): void {
  if (!session.authenticated) return;
  const { action, room_id, invite_user_ids, webrtc } = msg.payload;
  const uid = String(session.userId!);
  const uname = session.username;

  if (action === "create") {
    const rid = roomManager.createRoom(uid, uname);
    session.send(buildRoomSignal({ action: "created", room_id: rid, participants: [{ userId: uid, username: uname }] }));
    logger.info({ roomId: rid, userId: uid }, "Room created");
  } else if (action === "join") {
    const others = roomManager.joinRoom(room_id!, uid, uname);
    if (!others) { session.send(buildError(msg.seq, 1202, "Room not found")); return; }
    // 通知房间内其他人: 新成员加入
    const room = roomManager.getRoom(room_id!);
    for (const p of others) {
      const ws = connectionManager.getByUserId(p.userId);
      if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "user_joined", room_id, from_user_id: uid, from_username: uname, participants: room?.participants })));
    }
    // 告知加入者完整列表
    session.send(buildRoomSignal({ action: "joined", room_id, participants: room?.participants || [] }));
  } else if (action === "leave") {
    const result = roomManager.leaveRoom(uid);
    if (!result) return;
    if (result.remaining.length === 0) return;
    const room = roomManager.getRoom(result.roomId);
    for (const p of result.remaining) {
      const ws = connectionManager.getByUserId(p.userId);
      if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "user_left", room_id: result.roomId, from_user_id: uid, from_username: uname, participants: room?.participants })));
    }
  } else if (action === "invite") {
    if (!invite_user_ids) return;
    const room = roomManager.getUserRoom(uid);
    if (!room) { session.send(buildError(msg.seq, 1202, "You are not in a room")); return; }
    for (const targetId of invite_user_ids) {
      const ws = connectionManager.getByUserId(String(targetId));
      if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "invited", room_id: room.roomId, from_user_id: uid, from_username: uname })));
    }
  } else if (action === "webrtc" && webrtc) {
    // Mesh 模式: 转发 WebRTC 信令到房间内所有其他人
    const room = roomManager.getUserRoom(uid);
    if (!room) return;
    for (const p of room.participants) {
      if (p.userId === uid) continue;
      const ws = connectionManager.getByUserId(p.userId);
      if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "webrtc", from_user_id: uid, from_username: uname, webrtc: { ...webrtc, from_user_id: uid, from_username: uname } })));
    }
  }
}
