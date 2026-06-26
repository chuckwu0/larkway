import {
  isResponseSurfacePrototypeAllowlisted,
  type ResponseSurfacePrototypeConfig,
} from "../responseSurface.js";

export interface SurfaceControllerInput {
  prototypeConfig?: ResponseSurfacePrototypeConfig;
  chatId: string;
  threadId: string;
  /**
   * PR3+ hook. This PR deliberately keeps it false in production wiring because
   * real post outbound, ledger, and visible failure fallback are out of scope.
   */
  postOutboundAvailable: boolean;
}

export interface SurfaceControllerDecision {
  /**
   * Whether handler must create the legacy processing card before running the
   * agent. PR1/PR2 production wiring keeps this true in every path.
   */
  startCardImmediately: boolean;
  prototypeEnabled: boolean;
  lazyCardCreationEnabled: boolean;
  reason:
    | "prototype-disabled"
    | "not-allowlisted"
    | "lazy-card-disabled"
    | "post-outbound-unavailable-card-fallback"
    | "lazy-card-ready";
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

    if (!input.postOutboundAvailable) {
      return new SurfaceController({
        startCardImmediately: true,
        prototypeEnabled: true,
        lazyCardCreationEnabled: false,
        reason: "post-outbound-unavailable-card-fallback",
      });
    }

    return new SurfaceController({
      startCardImmediately: false,
      prototypeEnabled: true,
      lazyCardCreationEnabled: true,
      reason: "lazy-card-ready",
    });
  }

  shouldStartCardImmediately(): boolean {
    return this.decision.startCardImmediately;
  }
}
