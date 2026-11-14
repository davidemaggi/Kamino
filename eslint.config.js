import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      // Local Obsidian test vault (gitignored): contains copied plugin builds.
      "vault/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
