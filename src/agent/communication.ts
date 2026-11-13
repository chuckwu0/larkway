export const COMMUNICATION_CONTRACT_VERSION = 3;

function shellWord(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** A command pointer, not an invocation or a business routing decision. */
export function ordinaryReplyCommand(messageId: string, profile?: string): string {
  return "lark-cli im +messages-reply --message-id " + shellWord(messageId) +
    (profile ? " --profile " + shellWord(profile) : "") +
    " --as bot --reply-in-thread --text '<答复；需@人时用真实at标签>' --idempotency-key " + shellWord(`reply:${messageId}`);
}
