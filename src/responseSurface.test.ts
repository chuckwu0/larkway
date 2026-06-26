import { describe, expect, it } from "vitest";
import {
  defaultResponseSurfacePrototypeConfig,
  isResponseSurfacePostOutboundAvailable,
  isResponseSurfacePrototypeAllowlisted,
  shouldProvideResponseSurfacePostClient,
} from "./responseSurface.js";

const enabledConfig = {
  ...defaultResponseSurfacePrototypeConfig(),
  enabled: true,
  allowed_chats: ["chat"],
  lazy_card_creation: true,
  post_outbound_enabled: true,
};

describe("response surface production gates", () => {
  it("keeps the default config fully off", () => {
    const cfg = defaultResponseSurfacePrototypeConfig();

    expect(cfg).toMatchObject({
      enabled: false,
      post_outbound_enabled: false,
      kill_switch: false,
      allowed_chats: [],
      allowed_threads: [],
      allowed_mention_open_ids: [],
      max_posts_per_turn: 1,
      max_posts_per_window: 4,
      post_window_ms: 60_000,
    });
    expect(shouldProvideResponseSurfacePostClient(cfg)).toBe(false);
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
