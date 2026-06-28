import { describe, expect, it } from "vitest";
import {
  defaultResponseSurfacePrototypeConfig,
  isResponseSurfaceMentionAllowed,
  isResponseSurfaceCardKitAvailable,
  isResponseSurfacePostOutboundAvailable,
  isResponseSurfacePrototypeAllowlisted,
  shouldProvideResponseSurfaceCardKitClient,
  shouldProvideResponseSurfacePostClient,
} from "./responseSurface.js";

const enabledConfig = {
  ...defaultResponseSurfacePrototypeConfig(),
  allowed_chats: ["chat"],
};

describe("response surface production gates", () => {
  it("enables CardKit surfaces and agent-authored mentions by default", () => {
    const cfg = defaultResponseSurfacePrototypeConfig();

    expect(cfg).toMatchObject({
      enabled: true,
      post_outbound_enabled: true,
      cardkit_streaming_enabled: true,
      kill_switch: false,
      allow_agent_mentions: true,
      allowed_chats: [],
      allowed_threads: [],
      allowed_mention_open_ids: [],
    });
    expect(isResponseSurfacePrototypeAllowlisted(cfg, { chatId: "any_chat", threadId: "any_thread" }))
      .toBe(true);
    expect(shouldProvideResponseSurfaceCardKitClient(cfg)).toBe(true);
    expect(isResponseSurfaceCardKitAvailable(cfg, { chatId: "any_chat", threadId: "any_thread" }, {
      cardKitClientAvailable: true,
    })).toBe(true);
    expect(shouldProvideResponseSurfacePostClient(cfg)).toBe(true);
    expect(isResponseSurfaceMentionAllowed(cfg, "peer_bot")).toBe(true);
    expect(isResponseSurfaceMentionAllowed(cfg, "all")).toBe(false);
    expect(isResponseSurfaceMentionAllowed(cfg, "@all")).toBe(false);
  });

  it("treats non-empty chat or thread allowlists as scoped rollout gates", () => {
    const cfg = { ...enabledConfig, allowed_chats: ["chat_a"], allowed_threads: ["thread_b"] };

    expect(isResponseSurfacePrototypeAllowlisted(cfg, { chatId: "chat_a", threadId: "thread_x" }))
      .toBe(true);
    expect(isResponseSurfacePrototypeAllowlisted(cfg, { chatId: "chat_x", threadId: "thread_b" }))
      .toBe(true);
    expect(isResponseSurfacePrototypeAllowlisted(cfg, { chatId: "chat_x", threadId: "thread_x" }))
      .toBe(false);
  });

  it("uses kill_switch as an emergency post-client gate", () => {
    const cfg = { ...enabledConfig, kill_switch: true };

    expect(isResponseSurfacePrototypeAllowlisted(cfg, { chatId: "chat", threadId: "thread" }))
      .toBe(false);
    expect(shouldProvideResponseSurfacePostClient(cfg)).toBe(false);
    expect(
      isResponseSurfacePostOutboundAvailable(cfg, { chatId: "chat", threadId: "thread" }, {
        postClientAvailable: true,
      }),
    ).toBe(false);
  });

  it("does not provide a post client when post outbound is disabled", () => {
    const cfg = { ...enabledConfig, post_outbound_enabled: false };

    expect(shouldProvideResponseSurfacePostClient(cfg)).toBe(false);
  });

  it("can narrow or disable agent-authored mentions without hardcoded default ids", () => {
    const narrowed = { ...enabledConfig, allowed_mention_open_ids: ["peer_a"] };
    expect(isResponseSurfaceMentionAllowed(narrowed, "peer_a")).toBe(true);
    expect(isResponseSurfaceMentionAllowed(narrowed, "peer_b")).toBe(false);

    const disabled = { ...enabledConfig, allow_agent_mentions: false };
    expect(isResponseSurfaceMentionAllowed(disabled, "peer_a")).toBe(false);
  });
});
