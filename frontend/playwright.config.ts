import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 20000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:15173",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 15173 --strictPort",
    url: "http://127.0.0.1:15173",
    reuseExistingServer: true,
    timeout: 30000,
  },
  reporter: "list",
});
