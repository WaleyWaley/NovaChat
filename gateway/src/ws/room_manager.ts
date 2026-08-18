/**
 * Phase 4.1: Room Manager — 多人语音房间管理 (Mesh 模式)
 *
 * 每个房间就是一个 participant 列表。
 * Mesh 模式下, 每个新加入的成员要和其他所有人建立 P2P 连接。
 * 信令通过 gateway 的 room_signal 广播给房间内所有人。
 */

import { logger } from "../utils/logger.js";

interface Participant {
  userId: string;
  username: string;
}

interface Room {
  roomId: string;
  participants: Participant[];
  createdAt: number;
}

class RoomManager {
  private rooms = new Map<string, Room>();
  private userRooms = new Map<string, string>(); // userId → roomId

  /** 创建房间, 返回 roomId */
  createRoom(userId: string, username: string): string {
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    this.rooms.set(roomId, {
      roomId,
      participants: [{ userId, username }],
      createdAt: Date.now(),
    });
    this.userRooms.set(userId, roomId);
    logger.info({ roomId, userId, username }, "Room created");
    return roomId;
  }

  /** 加入房间, 返回房间内其他参与者列表 */
  joinRoom(roomId: string, userId: string, username: string): Participant[] | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const existing = room.participants.find(p => p.userId === userId);
    if (existing) {
      existing.username = username; // 更新用户名
      return room.participants.filter(p => p.userId !== userId);
    }

    room.participants.push({ userId, username });
    this.userRooms.set(userId, roomId);
    const others = room.participants.filter(p => p.userId !== userId);
    logger.info({ roomId, userId, username, totalParticipants: room.participants.length }, "User joined room");
    return others;
  }

  /** 离开房间, 返回剩余参与者列表 (空则房间解散) */
  leaveRoom(userId: string): { roomId: string; remaining: Participant[] } | null {
    const roomId = this.userRooms.get(userId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.participants = room.participants.filter(p => p.userId !== userId);
    this.userRooms.delete(userId);

    if (room.participants.length === 0) {
      this.rooms.delete(roomId);
      logger.info({ roomId }, "Room dissolved (all participants left)");
      return { roomId, remaining: [] };
    }

    logger.info({ roomId, userId, remaining: room.participants.length }, "User left room");
    return { roomId, remaining: room.participants };
  }

  /** 获取用户所在的房间 */
  getUserRoom(userId: string): Room | undefined {
    const roomId = this.userRooms.get(userId);
    if (!roomId) return undefined;
    return this.rooms.get(roomId);
  }

  /** 获取房间信息 */
  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }
}

export const roomManager = new RoomManager();
