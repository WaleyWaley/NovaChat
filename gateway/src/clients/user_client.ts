/**
 * UserService 客户端 — 封装对 C++ user-service 的 12 个 RPC 调用
 *
 * 每个方法对应 user.proto 中 UserService 的一个 RPC。
 * 入参/出参类型与 proto 定义对齐，Phase 1 全部发 HTTP JSON。
 */

import { BrpcClient, type BrpcResponse, type CallOptions } from "./base.js";
import { getServiceUrl, getFullServiceName } from "./service_registry.js";

// ---- 类型定义 (与 user.proto 对齐) ----

export interface RegisterReq {
  username: string;
  password: string;
  first_name: string;
  last_name?: string;
  phone?: string;
  invite_hash?: string;
}

export interface RegisterResp {
  error_code: number;
  error_message: string;
  user_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: UserProfile | null;
}

export interface LoginReq {
  username: string;
  password: string;
  device_name?: string;
  device_type?: string;
}

export interface LoginResp {
  error_code: number;
  error_message: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: UserProfile | null;
}

export interface RefreshTokenReq {
  refresh_token: string;
}

export interface RefreshTokenResp {
  error_code: number;
  error_message: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface LogoutReq {
  user_id: number;
}

export interface LogoutResp {
  error_code: number;
  error_message: string;
}

export interface GetUserProfileReq {
  user_id?: number;
  username?: string;
}

export interface GetUserProfileResp {
  error_code: number;
  error_message: string;
  user: UserProfile | null;
}

export interface GetUsersReq {
  user_ids: number[];
}

export interface GetUsersResp {
  error_code: number;
  error_message: string;
  users: UserProfile[];
}

export interface UpdateProfileReq {
  user_id: number;
  first_name?: string;
  last_name?: string;
  bio?: string;
  avatar_photo_id?: string;
}

export interface UpdateProfileResp {
  error_code: number;
  error_message: string;
  user: UserProfile | null;
}

export interface ChangeUsernameReq {
  user_id: number;
  new_username: string;
}

export interface ChangeUsernameResp {
  error_code: number;
  error_message: string;
  username: string;
}

export interface CheckUsernameReq {
  username: string;
}

export interface CheckUsernameResp {
  error_code: number;
  error_message: string;
  is_available: boolean;
}

export interface SearchUsersReq {
  query: string;
  limit: number;
  offset_id?: number;
}

export interface SearchUsersResp {
  error_code: number;
  error_message: string;
  users: UserProfile[];
  has_more: boolean;
}

export interface ChangePasswordReq {
  user_id: number;
  old_password: string;
  new_password: string;
}

export interface ChangePasswordResp {
  error_code: number;
  error_message: string;
}

export interface DeleteAccountReq {
  user_id: number;
  password: string;
  reason?: string;
}

export interface DeleteAccountResp {
  error_code: number;
  error_message: string;
}

export interface UserProfile {
  user_id: number;
  username: string;
  first_name: string;
  last_name: string;
  bio: string;
  avatar_photo_id: string;
  status: number;
  last_seen_at: number;
  is_verified: boolean;
  phone: string;
  created_at: number;
  updated_at: number;
}

// ---- UserClient ----

export class UserClient {
  private readonly client: BrpcClient;
  private readonly serviceName: string;

  constructor(userServiceUrl?: string) {
    const url = userServiceUrl ?? getServiceUrl("user-service");
    this.client = new BrpcClient(url);
    this.serviceName = getFullServiceName("user-service");
  }

  private call<TReq extends object, TResp>(
    method: string,
    body: TReq,
    opts?: CallOptions
  ): Promise<TResp> {
    return this.client.call<TReq, TResp>(this.serviceName, method, body, opts);
  }

  // ===== 认证 =====

  async register(req: Omit<RegisterReq, "user_id">): Promise<RegisterResp> {
    return this.call<RegisterReq, RegisterResp>("Register", req as RegisterReq);
  }

  async login(req: LoginReq): Promise<LoginResp> {
    return this.call<LoginReq, LoginResp>("Login", req);
  }

  async refreshToken(req: RefreshTokenReq): Promise<RefreshTokenResp> {
    return this.call<RefreshTokenReq, RefreshTokenResp>("RefreshToken", req);
  }

  async logout(userId: number): Promise<LogoutResp> {
    return this.call<LogoutReq, LogoutResp>("Logout", { user_id: userId });
  }

  // ===== 资料查询 =====

  async getUserProfile(req: GetUserProfileReq): Promise<GetUserProfileResp> {
    return this.call<GetUserProfileReq, GetUserProfileResp>("GetUserProfile", req);
  }

  async getUsers(req: GetUsersReq): Promise<GetUsersResp> {
    return this.call<GetUsersReq, GetUsersResp>("GetUsers", req);
  }

  // ===== 资料修改 =====

  async updateProfile(
    userId: number,
    fields: Omit<UpdateProfileReq, "user_id">
  ): Promise<UpdateProfileResp> {
    return this.call<UpdateProfileReq, UpdateProfileResp>("UpdateProfile", {
      user_id: userId,
      ...fields,
    });
  }

  async changeUsername(userId: number, newUsername: string): Promise<ChangeUsernameResp> {
    return this.call<ChangeUsernameReq, ChangeUsernameResp>("ChangeUsername", {
      user_id: userId,
      new_username: newUsername,
    });
  }

  async checkUsername(username: string): Promise<CheckUsernameResp> {
    return this.call<CheckUsernameReq, CheckUsernameResp>("CheckUsername", { username });
  }

  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string
  ): Promise<ChangePasswordResp> {
    return this.call<ChangePasswordReq, ChangePasswordResp>("ChangePassword", {
      user_id: userId,
      old_password: oldPassword,
      new_password: newPassword,
    });
  }

  // ===== 搜索 =====

  async searchUsers(req: SearchUsersReq): Promise<SearchUsersResp> {
    return this.call<SearchUsersReq, SearchUsersResp>("SearchUsers", req);
  }

  // ===== 账户管理 =====

  async deleteAccount(userId: number, password: string, reason?: string): Promise<DeleteAccountResp> {
    return this.call<DeleteAccountReq, DeleteAccountResp>("DeleteAccount", {
      user_id: userId,
      password,
      reason: reason ?? "",
    });
  }
}

/** 全局单例 */
export const userClient = new UserClient();
