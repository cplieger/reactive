// Vitest configuration for @cplieger/reactive unit tests.
//
// Every test file runs in a real headless Chromium through Browser Mode rather
// than a DOM emulator. There is no `environment` and no per-file
// `@vitest-environment` pragma: Browser Mode is not an environment, it is a
// runner, and it replaces the emulator outright here because this package has no
// pure-Node tests to keep out of the browser. The DOM half (`el`, `bindList`,
// `reconcile`, `patch`) needs a real DOM, and the signal engine is indifferent
// to which globals exist, so one project covers both.
//
// `channel: "chromium"` opts into Chromium's newer headless mode, which is the
// real browser rather than the separate headless-shell build, so a behavior
// verified here is the behavior a consumer gets. CI installs the browser with
// `npx playwright install --with-deps chromium`; locally it is a one-time
// `npx --no-install playwright install chromium`.
//
// Run: vitest --run (single pass) or vitest (watch mode).
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          channel: "chromium",
        },
      }),
      instances: [{ browser: "chromium" }],
      // Fixed viewport so anything layout-dependent is reproducible; a real
      // browser computes real boxes, unlike the emulator this replaced.
      viewport: { width: 1280, height: 720 },
      // A failure screenshot per failing test is noise in CI and cannot be
      // read from a job log; the assertion diff is the useful artifact.
      screenshotFailures: false,
    },
  },
});
