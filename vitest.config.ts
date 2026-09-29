import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Windows CI runners are several times slower at fs/process work under the
    // parallel suite; the 5s default produced sporadic timeouts there only.
    ...(process.platform === "win32" ? { testTimeout: 20_000, hookTimeout: 20_000 } : {}),
  },
});
