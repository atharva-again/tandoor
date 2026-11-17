import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/brand/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
