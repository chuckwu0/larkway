import {
  isResponseSurfacePrototypeAllowlisted,
  type ResponseSurfacePrototypeConfig,
} from "../responseSurface.js";

export interface SurfaceControllerInput {
  prototypeConfig?: ResponseSurfacePrototypeConfig;
  chatId: string;
  threadId: string;
  /**
   * PR4 dispatch hook. Production wiring deliberately keeps this false until a
   * later, separately-authorized PR enables real post outbound.
   */
  postOutboundAvailable: boolean;
  postLedgerAvailable?: boolean;
  visibleFallbackAvailable?: boolean;
}

export interface SurfaceControllerDecision {
  /**
   * Whether handler must create the processing card before running the Agent.
   * This stays true for live progress updates even when post/hybrid dispatch is
   * available; final dispatch can still turn the card into a compact audit
   * surface after the post succeeds.
   */
  startCardImmediately: boolean;
  prototypeEnabled: boolean;
  lazyCardCreationEnabled: boolean;
  reason:
    | "prototype-disabled"
    | "kill-switch-active"
    | "not-allowlisted"
    | "lazy-card-disabled"
    | "post-outbound-disabled"
    | "post-outbound-unavailable-card-fallback"
    | "post-ledger-unavailable-card-fallback"
    | "visible-fallback-unavailable-card-fallback"
    | "dynamic-progress-card";
}

export class SurfaceController {
  readonly decision: SurfaceControllerDecision;

  private constructor(decision: SurfaceControllerDecision) {
    this.decision = decision;
  }

  static create(input: SurfaceControllerInput): SurfaceController {
    const cfg = input.prototypeConfig;
    if (!cfg?.enabled) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: false,
        lazyCardCreationEnabled: false,
        reason: "prototype-disabled",
      });
    }

    if (cfg.kill_switch) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: false,
        lazyCardCreationEnabled: false,
        reason: "kill-switch-active",
      });
    }

    if (
      !isResponseSurfacePrototypeAllowlisted(cfg, {
        chatId: input.chatId,
        threadId: input.threadId,
      })
    ) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: false,
        lazyCardCreationEnabled: false,
        reason: "not-allowlisted",
      });
    }

    if (!cfg.lazy_card_creation) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: true,
        lazyCardCreationEnabled: false,
        reason: "lazy-card-disabled",
      });
    }

    if (!cfg.post_outbound_enabled) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: true,
        lazyCardCreationEnabled: false,
        reason: "post-outbound-disabled",
      });
    }

    if (!input.postOutboundAvailable) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: true,
        lazyCardCreationEnabled: false,
        reason: "post-outbound-unavailable-card-fallback",
      });
    }

    if (input.postLedgerAvailable === false) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: true,
        lazyCardCreationEnabled: false,
        reason: "post-ledger-unavailable-card-fallback",
      });
    }

    if (input.visibleFallbackAvailable === false) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: true,
        lazyCardCreationEnabled: false,
        reason: "visible-fallback-unavailable-card-fallback",
      });
    }

    return new SurfaceController({
      startCardImmediately: true,
      prototypeEnabled: true,
      lazyCardCreationEnabled: true,
      reason: "dynamic-progress-card",
    });
  }

  shouldStartCardImmediately(): boolean {
    return this.decision.startCardImmediately;
  }
}
