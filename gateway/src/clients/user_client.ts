/**
 * UserService 客户端 — 封装对 C++ user-service 的 12 个 RPC 调用
 *
 * 每个方法对应 user.proto 中 UserService 的一个 RPC。
 * 入参/出参类型与 proto 定义对齐，Phase 1 全部发 HTTP JSON。
 * 
 * 网关的每个路由大都会调用 userClient 里的一个方法，而 userClient 里的每个方法又对应后端 C++ user-service 的 user.proto 中的一个 RPC 方法。
 *
 * 不过有两类操作是网关自己处理的，不会转发给 user-service：

 * JWT 相关：注册/登录成功后的签发、刷新 token、登出后的 session 失效。
 * 网关侧附加逻辑：比如改密码成功后，网关会主动把该用户的所有 session 清掉。
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
  user_id: string | number;   // int64: base.ts 解析后为 string (精度安全)
  // 注: 无 token 字段 — user-service 不签发 token (BFF 模式), JWT 由网关统一签发
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
  // 注: 无 token 字段 — JWT 由网关统一签发
  user: UserProfile | null;
}

export interface GetUserProfileReq {
  user_id?: string | number;
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
  user_id: string | number;
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
  user_id: string | number;
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
  user_id: string | number;
  old_password: string;
  new_password: string;
}

export interface ChangePasswordResp {
  error_code: number;
  error_message: string;
}

export interface DeleteAccountReq {
  user_id: string | number;
  password: string;
  reason?: string;
}

export interface DeleteAccountResp {
  error_code: number;
  error_message: string;
}

export interface UserProfile {
  user_id: string | number;   // int64: 经 base.ts 解析后为 string
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

  // 泛型，TReq 是请求体类型限制为object类型，TResp 是响应体类型
  private call<TReq extends object, TResp>(
    method: string,
    body: TReq,
    opts?: CallOptions
  ): Promise<TResp> {
    // 调用 BrpcClient 的 call 方法，传入 serviceName、method、body 和 opts
    return this.client.call<TReq, TResp>(this.serviceName, method, body, opts);
  }

  // ===== 认证 =====

  // 注册不需要user_id，用户还没有获取。Omit<RegisterReq, "user_id"> 表示从 RegisterReq 类型中排除 user_id 属性
  async register(req: Omit<RegisterReq, "user_id">): Promise<RegisterResp> {
    // req as RegisterReq 是类型断言，告诉 TypeScript 编译器 req 可以被视为 RegisterReq 类型
    // 因为 call 方法要求 body 是 RegisterReq，但 register 的参数是 Omit<RegisterReq, "user_id">，类型不完全一致。所以用 as 强制转换一下。实际上运行时 user_id 本来也不需要传。
    return this.call<RegisterReq, RegisterResp>("Register", req as RegisterReq);
  }

  async login(req: LoginReq): Promise<LoginResp> {
    return this.call<LoginReq, LoginResp>("Login", req);
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
    userId: string | number,
    fields: Omit<UpdateProfileReq, "user_id">
  ): Promise<UpdateProfileResp> {
    return this.call<UpdateProfileReq, UpdateProfileResp>("UpdateProfile", {
      user_id: userId,
      ...fields,
    });
  }

  async changeUsername(userId: string | number, newUsername: string): Promise<ChangeUsernameResp> {
    return this.call<ChangeUsernameReq, ChangeUsernameResp>("ChangeUsername", {
      user_id: userId,
      new_username: newUsername,
    });
  }

  async checkUsername(username: string): Promise<CheckUsernameResp> {
    return this.call<CheckUsernameReq, CheckUsernameResp>("CheckUsername", { username });
  }

  async changePassword(
    userId: string | number,
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

  async deleteAccount(userId: string | number, password: string, reason?: string): Promise<DeleteAccountResp> {
    return this.call<DeleteAccountReq, DeleteAccountResp>("DeleteAccount", {
      user_id: userId,
      password,
      reason: reason ?? "",
    });
  }
}

/** 全局单例 */
export const userClient = new UserClient();
