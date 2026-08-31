import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Conservative first-pass ruleset. Recommended correctness rules only; no
 * stylistic set, and historical-noise rules turned off so Slice 7 can land
 * without a repo-wide cleanup.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "dist-tests/**", "node_modules/**", "drizzle/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-empty": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "no-control-regex": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
