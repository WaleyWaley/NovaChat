/**
 * 服务注册表 — C++ 后端服务地址管理
 *
 * Phase 1: 配置文件硬编码 (开发环境足够)
 * Phase 3: Consul/Etcd 动态服务发现 + 健康检查 + 负载均衡
 */
export type ServiceName = "user-service" | "message-service" | "media-service";
export interface ServiceInfo {
    name: ServiceName;
    url: string;
    /** 完整的 Protobuf 服务名，如 "nova.user.UserService" */
    fullServiceName: string;
}
/**
 * 获取服务信息
 * @throws 如果服务未注册
 */
export declare function getService(name: ServiceName): ServiceInfo;
/**
 * 获取服务 URL
 */
export declare function getServiceUrl(name: ServiceName): string;
/**
 * 获取完整 Protobuf 服务名 (用于构造 bRPC HTTP 端点)
 */
export declare function getFullServiceName(name: ServiceName): string;
/**
 * Phase 3 预留: 动态更新服务地址
 */
export declare function updateServiceUrl(name: ServiceName, url: string): void;
//# sourceMappingURL=service_registry.d.ts.map