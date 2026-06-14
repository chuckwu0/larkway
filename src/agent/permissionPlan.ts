import type { WorkspacePermissionItem } from "./workspaceStore.js";

export type PermissionCategory =
  | "read"
  | "write"
  | "deploy"
  | "external-message"
  | "production-impact";

export function classifyPermissionCapability(capability: string): PermissionCategory {
  const lower = capability.toLowerCase();
  if (/\b(prod|production|线上|生产|影响用户|真实用户)\b/.test(lower)) {
    return "production-impact";
  }
  if (/\b(deploy|deployment|restart|release|rollback|systemctl|部署|重启|发布|回滚)\b/.test(lower)) {
    return "deploy";
  }
  if (
    /\b(allowed chats?|allowlist|白名单)\b/.test(lower) &&
    /\b(receive mentions?|reply|respond|回复|响应)\b/.test(lower)
  ) {
    return "write";
  }
  if (/\b(message|reply|respond|notify|email|sms|call|外发|发消息|回复|通知|邮件|短信|电话)\b/.test(lower)) {
    return "external-message";
  }
  if (/\b(write|commit|push|merge|mr|edit|modify|create|delete|shell|test|修改|写|提交|创建|删除|测试)\b/.test(lower)) {
    return "write";
  }
  return "read";
}

export function permissionItemsFromCapabilities(
  capabilities: string[],
): WorkspacePermissionItem[] {
  return capabilities.map((capability) => {
    const category = classifyPermissionCapability(capability);
    const requiresHumanGate =
      category === "deploy" ||
      category === "external-message" ||
      category === "production-impact";
    return {
      category,
      capability,
      ...(requiresHumanGate ? { gate: "explicit-human-confirmation" } : {}),
    };
  });
}
