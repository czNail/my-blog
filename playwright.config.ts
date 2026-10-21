import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4174/my-blog/",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    } : {},
  },
  webServer: {
    command: "pnpm run preview --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174/my-blog/",
    reuseExistingServer: !process.env.CI,
  },
});
