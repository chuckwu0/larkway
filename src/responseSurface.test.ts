import { describe, expect, it } from "vitest";
import {
  defaultResponseSurfacePrototypeConfig,
  isResponseSurfacePostOutboundAvailable,
  isResponseSurfacePrototypeAllowlisted,
  shouldProvideResponseSurfacePostClient,
} from "./responseSurface.js";

const enabledConfig = {
  ...defaultResponseSurfacePrototypeConfig(),
  allowed_chats: ["chat"],
  lazy_card_creation: true,
};

describe("response surface production gates", () => {
  it("enables post surfaces by default while keeping auto-mentions off", () => {
    const cfg = defaultResponseSurfacePrototypeConfig();

    expect(cfg).toMatchObject({
      enabled: true,
      post_outbound_enabled: true,
      kill_switch: false,
      allowed_chats: [],
      allowed_threads: [],
      allowed_mention_open_ids: [],
      max_posts_per_turn: 1,
      max_posts_per_window: 4,
      post_window_ms: 60_000,
    });
    expect(isResponseSurfacePrototypeAllowlisted(cfg, { chatId: "any_chat", threadId: "any_thread" }))
      .toBe(true);
    expect(shouldProvideResponseSurfacePostClient(cfg)).toBe(true);
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

  it("does not provide a post client when the runtime window cap is zero", () => {
    const cfg = { ...enabledConfig, max_posts_per_window: 0 };

    expect(shouldProvideResponseSurfacePostClient(cfg)).toBe(false);
  });
});
