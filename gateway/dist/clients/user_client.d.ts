/**
 * UserService 客户端 — 封装对 C++ user-service 的 12 个 RPC 调用
 *
 * 每个方法对应 user.proto 中 UserService 的一个 RPC。
 * 入参/出参类型与 proto 定义对齐，Phase 1 全部发 HTTP JSON。
 */
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
export declare class UserClient {
    private readonly client;
    private readonly serviceName;
    constructor(userServiceUrl?: string);
    private call;
    register(req: Omit<RegisterReq, "user_id">): Promise<RegisterResp>;
    login(req: LoginReq): Promise<LoginResp>;
    refreshToken(req: RefreshTokenReq): Promise<RefreshTokenResp>;
    logout(userId: number): Promise<LogoutResp>;
    getUserProfile(req: GetUserProfileReq): Promise<GetUserProfileResp>;
    getUsers(req: GetUsersReq): Promise<GetUsersResp>;
    updateProfile(userId: number, fields: Omit<UpdateProfileReq, "user_id">): Promise<UpdateProfileResp>;
    changeUsername(userId: number, newUsername: string): Promise<ChangeUsernameResp>;
    checkUsername(username: string): Promise<CheckUsernameResp>;
    changePassword(userId: number, oldPassword: string, newPassword: string): Promise<ChangePasswordResp>;
    searchUsers(req: SearchUsersReq): Promise<SearchUsersResp>;
    deleteAccount(userId: number, password: string, reason?: string): Promise<DeleteAccountResp>;
}
/** 全局单例 */
export declare const userClient: UserClient;
//# sourceMappingURL=user_client.d.ts.map