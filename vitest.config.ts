// One project per module group (signal and dom, fetch, actions), so each suite
// keeps the settings it was written under. The signal, dom and fetch suites
// never set the strict options, and a root-level `expect.requireAssertions`
// reaches every project, `extends` or not, so they are spread only into the
// projects that had them.
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

function chromium() {
  return {
    enabled: true,
    headless: true,
    provider: playwright({
      launchOptions: {
        channel: "chromium",
        // Chromium caps animation frames at ~60Hz, about 16.7ms per awaited frame.
        args: ["--disable-frame-rate-limit"],
      },
    }),
    instances: [{ browser: "chromium" as const }],
    viewport: { width: 1280, height: 720 },
    screenshotFailures: false,
  };
}

const EXCLUDE = ["**/node_modules/**", "**/.stryker-tmp/**"];

const strict = {
  passWithNoTests: false,
  allowOnly: false,
  globals: false,
  expect: {
    requireAssertions: true,
  },
  clearMocks: true,
  mockReset: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
  testTimeout: 5000,
  hookTimeout: 10000,
  sequence: {
    shuffle: { files: false, tests: false },
    concurrent: false,
    hooks: "stack",
  },
  printConsoleTrace: true,
  expandSnapshotDiff: true,
  chaiConfig: {
    truncateThreshold: 0,
    showDiff: true,
    includeStack: true,
  },
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "reactive",
          isolate: true,
          exclude: [...EXCLUDE, "src/**/*.node.test.ts"],
          include: ["src/index.exports.test.ts", "src/signal/**/*.test.ts", "src/dom/**/*.test.ts"],
          browser: chromium(),
        },
      },
      {
        test: {
          name: "fetch",
          isolate: true,
          exclude: [...EXCLUDE, "src/**/*.node.test.ts"],
          include: ["src/fetch/**/*.test.ts"],
          browser: chromium(),
        },
      },
      {
        test: {
          ...strict,
          name: "actions",
          include: ["src/actions/**/*.test.ts"],
          isolate: true,
          exclude: [...EXCLUDE, "src/**/*.node.test.ts"],
          browser: chromium(),
        },
      },
      {
        test: {
          ...strict,
          name: "node",
          environment: "node",
          isolate: true,
          exclude: EXCLUDE,
          include: ["src/**/*.node.test.ts"],
        },
      },
    ],
    bail: process.env["CI"] ? 1 : 0,
    slowTestThreshold: 300,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/*-setup.ts", "src/**/test-helpers/**"],
      reportOnFailure: true,
      reporter: ["text", "text-summary", "lcov"],
    },
  },
});
