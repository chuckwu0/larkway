/**
 * Minimal type declaration for `qrcode-terminal` (no bundled types), so the CLI
 * compiles under TypeScript strict. Only the `generate` overloads we use are
 * declared. See src/cli/ui.ts renderQRCode().
 */
declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean;
  }
  /** Generate a QR for `input`; with a callback, returns the rendered string. */
  export function generate(input: string, callback: (qr: string) => void): void;
  export function generate(
    input: string,
    options: GenerateOptions,
    callback: (qr: string) => void,
  ): void;
  export function generate(input: string, options?: GenerateOptions): void;
  const _default: { generate: typeof generate };
  export default _default;
}
