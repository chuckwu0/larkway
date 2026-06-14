import { describe, expect, it } from "vitest";
import {
  classifyPermissionCapability,
  permissionItemsFromCapabilities,
} from "./permissionPlan.js";

describe("permissionPlan", () => {
  it("classifies task-first permission capabilities into v0.3 categories", () => {
    expect(classifyPermissionCapability("Read Feishu topic history")).toBe("read");
    expect(classifyPermissionCapability("GitLab write/MR")).toBe("write");
    expect(classifyPermissionCapability("deploy/restart Larkway bridge")).toBe("deploy");
    expect(classifyPermissionCapability("reply in allowed chats")).toBe("write");
    expect(classifyPermissionCapability("external message to Feishu")).toBe("external-message");
    expect(classifyPermissionCapability("production-impact operation")).toBe(
      "production-impact",
    );
  });

  it("keeps capability text while adding the category", () => {
    expect(permissionItemsFromCapabilities(["Local shell tests"])).toEqual([
      { category: "write", capability: "Local shell tests" },
    ]);
  });

  it("adds explicit human gates for high-risk categories", () => {
    expect(
      permissionItemsFromCapabilities([
        "deploy/restart",
        "external message to Feishu",
        "production-impact operations",
      ]),
    ).toEqual([
      {
        category: "deploy",
        capability: "deploy/restart",
        gate: "explicit-human-confirmation",
      },
      {
        category: "external-message",
        capability: "external message to Feishu",
        gate: "explicit-human-confirmation",
      },
      {
        category: "production-impact",
        capability: "production-impact operations",
        gate: "explicit-human-confirmation",
      },
    ]);
  });

  it("does not gate normal allowlisted Feishu replies as external messages", () => {
    expect(
      permissionItemsFromCapabilities([
        "Feishu IM: receive mentions and reply in allowed chats",
      ]),
    ).toEqual([
      {
        category: "write",
        capability: "Feishu IM: receive mentions and reply in allowed chats",
      },
    ]);
  });
});
