import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000
  },
  use: {
    baseURL: "http://127.0.0.1:8776",
    viewport: { width: 1440, height: 950 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node dist/cli/index.js serve --root .umos-e2e --host 127.0.0.1 --port 8776 --ui --read-write",
    url: "http://127.0.0.1:8776/health",
    reuseExistingServer: false,
    timeout: 15_000
  }
});
