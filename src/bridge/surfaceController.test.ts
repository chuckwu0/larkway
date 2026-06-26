import { describe, expect, it } from "vitest";
import { SurfaceController } from "./surfaceController.js";

const allowlistedConfig = {
  enabled: true,
  allowed_chats: ["oc_allowed"],
  allowed_threads: [],
  lazy_card_creation: true,
  post_outbound_enabled: false,
  allowed_mention_open_ids: [],
  max_posts_per_turn: 1,
  max_post_attempts: 3,
  text_threshold_chars: 1200,
};

describe("SurfaceController", () => {
  it("keeps legacy eager card creation when the prototype is disabled", () => {
    const controller = SurfaceController.create({
      prototypeConfig: {
        enabled: false,
        allowed_chats: [],
        allowed_threads: [],
        lazy_card_creation: false,
        post_outbound_enabled: false,
        allowed_mention_open_ids: [],
        max_posts_per_turn: 1,
        max_post_attempts: 3,
        text_threshold_chars: 1200,
      },
      chatId: "oc_allowed",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("prototype-disabled");
  });

  it("keeps legacy card creation outside the dark-launch allowlist", () => {
    const controller = SurfaceController.create({
      prototypeConfig: allowlistedConfig,
      chatId: "oc_other",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("not-allowlisted");
  });

  it("keeps card fallback before PR3 post outbound exists", () => {
    const controller = SurfaceController.create({
      prototypeConfig: allowlistedConfig,
      chatId: "oc_allowed",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("post-outbound-unavailable-card-fallback");
  });

  it("has a future lazy-ready path only when post outbound is available", () => {
    const controller = SurfaceController.create({
      prototypeConfig: allowlistedConfig,
      chatId: "oc_allowed",
      threadId: "om_thread",
      postOutboundAvailable: true,
    });

    expect(controller.shouldStartCardImmediately()).toBe(false);
    expect(controller.decision.reason).toBe("lazy-card-ready");
  });
});
