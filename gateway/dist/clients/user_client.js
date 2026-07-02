/**
 * UserService 客户端 — 封装对 C++ user-service 的 12 个 RPC 调用
 *
 * 每个方法对应 user.proto 中 UserService 的一个 RPC。
 * 入参/出参类型与 proto 定义对齐，Phase 1 全部发 HTTP JSON。
 */
import { BrpcClient } from "./base.js";
import { getServiceUrl, getFullServiceName } from "./service_registry.js";
// ---- UserClient ----
export class UserClient {
    client;
    serviceName;
    constructor(userServiceUrl) {
        const url = userServiceUrl ?? getServiceUrl("user-service");
        this.client = new BrpcClient(url);
        this.serviceName = getFullServiceName("user-service");
    }
    call(method, body, opts) {
        return this.client.call(this.serviceName, method, body, opts);
    }
    // ===== 认证 =====
    async register(req) {
        return this.call("Register", req);
    }
    async login(req) {
        return this.call("Login", req);
    }
    async refreshToken(req) {
        return this.call("RefreshToken", req);
    }
    async logout(userId) {
        return this.call("Logout", { user_id: userId });
    }
    // ===== 资料查询 =====
    async getUserProfile(req) {
        return this.call("GetUserProfile", req);
    }
    async getUsers(req) {
        return this.call("GetUsers", req);
    }
    // ===== 资料修改 =====
    async updateProfile(userId, fields) {
        return this.call("UpdateProfile", {
            user_id: userId,
            ...fields,
        });
    }
    async changeUsername(userId, newUsername) {
        return this.call("ChangeUsername", {
            user_id: userId,
            new_username: newUsername,
        });
    }
    async checkUsername(username) {
        return this.call("CheckUsername", { username });
    }
    async changePassword(userId, oldPassword, newPassword) {
        return this.call("ChangePassword", {
            user_id: userId,
            old_password: oldPassword,
            new_password: newPassword,
        });
    }
    // ===== 搜索 =====
    async searchUsers(req) {
        return this.call("SearchUsers", req);
    }
    // ===== 账户管理 =====
    async deleteAccount(userId, password, reason) {
        return this.call("DeleteAccount", {
            user_id: userId,
            password,
            reason: reason ?? "",
        });
    }
}
/** 全局单例 */
export const userClient = new UserClient();
//# sourceMappingURL=user_client.js.map