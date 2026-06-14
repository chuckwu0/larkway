/**
 * src/lark/outboundCardClient.ts
 *
 * Transport-neutral abstraction for the two OUTBOUND card network calls:
 *   - createCard  → create the initial interactive card (reply to user msg)
 *   - patchCard   → update an existing card's content
 *
 * card.ts owns all card-JSON building + throttle/retry orchestration; it only
 * delegates the leaf network call to an OutboundCardClient. The sole
 * implementation is the Channel-SDK-backed `ChannelCardClient` (channelCardClient.ts);
 * tests inject a fake.
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The transport-neutral outbound surface card.ts depends on. Implementations
 * deliver the (already-built) card JSON to Feishu and return the message id.
 */
export interface OutboundCardClient {
  /**
   * Create the initial card by replying to the user's message.
   * @param replyToMessageId  The om_xxx message id of the user's message.
   * @param cardJson          Stringified Card JSON 2.0 (already built by card.ts).
   * @param opts.replyInThread  When true, anchor the reply as a new topic thread.
   * @returns The created card's message id (used for subsequent patches).
   */
  createCard(
    replyToMessageId: string,
    cardJson: string,
    opts: { replyInThread: boolean; threadId?: string }
  ): Promise<{ messageId: string }>;

  /**
   * Update an existing card's content.
   * @param messageId  The om_xxx message id of the card to patch.
   * @param cardJson   Stringified Card JSON 2.0 (already built by card.ts).
   */
  patchCard(messageId: string, cardJson: string): Promise<void>;
}
