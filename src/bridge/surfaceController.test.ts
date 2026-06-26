import { describe, expect, it } from "vitest";
import { SurfaceController } from "./surfaceController.js";

const allowlistedConfig = {
  enabled: true,
  allowed_chats: ["chat_allowed"],
  allowed_threads: [],
  lazy_card_creation: true,
  post_outbound_enabled: false,
  allowed_mention_open_ids: [],
  max_posts_per_turn: 1,
  max_post_attempts: 3,
  text_threshold_chars: 1200,
};

const postEnabledConfig = {
  ...allowlistedConfig,
  post_outbound_enabled: true,
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
      chatId: "chat_allowed",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("prototype-disabled");
  });

  it("keeps legacy card creation outside the dark-launch allowlist", () => {
    const controller = SurfaceController.create({
      prototypeConfig: allowlistedConfig,
      chatId: "chat_other",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("not-allowlisted");
  });

  it("keeps card fallback when post outbound is disabled by config", () => {
    const controller = SurfaceController.create({
      prototypeConfig: allowlistedConfig,
      chatId: "chat_allowed",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("post-outbound-disabled");
  });

  it("keeps card fallback before post outbound transport is available", () => {
    const controller = SurfaceController.create({
      prototypeConfig: postEnabledConfig,
      chatId: "chat_allowed",
      threadId: "om_thread",
      postOutboundAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("post-outbound-unavailable-card-fallback");
  });

  it("keeps card fallback when post ledger is unavailable", () => {
    const controller = SurfaceController.create({
      prototypeConfig: postEnabledConfig,
      chatId: "chat_allowed",
      threadId: "om_thread",
      postOutboundAvailable: true,
      postLedgerAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("post-ledger-unavailable-card-fallback");
  });

  it("keeps card fallback when visible failure fallback is unavailable", () => {
    const controller = SurfaceController.create({
      prototypeConfig: postEnabledConfig,
      chatId: "chat_allowed",
      threadId: "om_thread",
      postOutboundAvailable: true,
      visibleFallbackAvailable: false,
    });

    expect(controller.shouldStartCardImmediately()).toBe(true);
    expect(controller.decision.reason).toBe("visible-fallback-unavailable-card-fallback");
  });

  it("has a future lazy-ready path only when post outbound is available", () => {
    const controller = SurfaceController.create({
      prototypeConfig: postEnabledConfig,
      chatId: "chat_allowed",
      threadId: "om_thread",
      postOutboundAvailable: true,
      postLedgerAvailable: true,
      visibleFallbackAvailable: true,
    });

    expect(controller.shouldStartCardImmediately()).toBe(false);
    expect(controller.decision.reason).toBe("lazy-card-ready");
  });
});
