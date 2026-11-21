import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit tests run in Node. A component test opts in to a browser-like page with
// the comment `// @vitest-environment jsdom` on its first line.
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    env: { ADDS_UP_TEST: "1" },
  },
});
