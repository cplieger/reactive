// The synced base is cplieger/ci's; change it there, never here.
import baseConfig from "./eslint.config.base.mjs";

export default [
  ...baseConfig,
  // Layered after the base's disableTypeChecked block so these rules actually turn off.
  {
    files: ["src/actions/**/*.test.ts", "src/fetch/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
      "@typescript-eslint/no-deprecated": "off",
      "no-throw-literal": "off",
      curly: "off",
    },
  },
];
