import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist", "bench/dist", "coverage", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    // plain Node scripts users copy as is
    files: ["examples/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
);
