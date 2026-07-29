import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "packages/db/migrations/**",
      "**/*.config.{js,cjs,mjs,ts}",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // Next.js rules for the web app
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // App Router only — no /pages dir; this rule is irrelevant and noisy.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  // SC-006: no hard-coded user-facing strings in app TSX — everything goes through next-intl t().
  {
    files: ["apps/web/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXText[value=/[A-Za-zÀ-ÿ]{2,}/]",
          message:
            "Não use textos fixos no JSX — use t() do next-intl (SC-006).",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(placeholder|title|alt|label)$/] > Literal[value=/[A-Za-zÀ-ÿ]{2,}/]",
          message:
            "Não use textos fixos em atributos de UI — use t() do next-intl (SC-006).",
        },
      ],
    },
  },
  // Vendored shadcn/ui primitives — not app feature strings; exempt from the SC-006 literal rule.
  {
    files: ["apps/web/components/ui/**/*.tsx"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Tests and scripts may use console and relaxed rules.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/seed/**/*.ts", "apps/web/e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  prettier,
);
