import globals from "globals";
import tseslint from "typescript-eslint";

const sharedRules = {
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      vars: "local",
    },
  ],
  "no-undef": "error",
  "no-var": "error",
  "prefer-const": "error",
};

export default [
  {
    files: ["src/**/*.{js,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: "readonly",
        browser: "readonly",
      },
    },
    rules: sharedRules,
  },
  {
    // The base no-unused-vars rule cannot see TypeScript type parameters and interfaces,
    // so it reports them as unused bindings. The TS-aware rule understands them.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      ...sharedRules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
];
