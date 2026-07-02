/**
 * 服务注册表 — C++ 后端服务地址管理
 *
 * Phase 1: 配置文件硬编码 (开发环境足够)
 * Phase 3: Consul/Etcd 动态服务发现 + 健康检查 + 负载均衡
 */

import { config } from "../config/index.js";

export type ServiceName = "user-service" | "message-service" | "media-service";

export interface ServiceInfo {
  name: ServiceName;
  url: string;
  /** 完整的 Protobuf 服务名，如 "nova.user.UserService" */
  fullServiceName: string;
}

/** 服务注册表 */
const registry: Record<ServiceName, ServiceInfo> = {
  "user-service": {
    name: "user-service",
    url: config.USER_SERVICE_URL,
    fullServiceName: "nova.user.UserService",
  },
  "message-service": {
    name: "message-service",
    url: config.MESSAGE_SERVICE_URL,
    fullServiceName: "nova.message.MessageService",
  },
  "media-service": {
    name: "media-service",
    url: process.env.MEDIA_SERVICE_URL || "http://127.0.0.1:8003",
    fullServiceName: "nova.media.MediaService",
  },
};

/**
 * 获取服务信息
 * @throws 如果服务未注册
 */
export function getService(name: ServiceName): ServiceInfo {
  const svc = registry[name];
  if (!svc) {
    throw new Error(`Service not found in registry: ${name}`);
  }
  return svc;
}

/**
 * 获取服务 URL
 */
export function getServiceUrl(name: ServiceName): string {
  return getService(name).url;
}

/**
 * 获取完整 Protobuf 服务名 (用于构造 bRPC HTTP 端点)
 */
export function getFullServiceName(name: ServiceName): string {
  return getService(name).fullServiceName;
}

/**
 * Phase 3 预留: 动态更新服务地址
 */
export function updateServiceUrl(name: ServiceName, url: string): void {
  registry[name].url = url;
}
