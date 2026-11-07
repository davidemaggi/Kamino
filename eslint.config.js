import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      // Throwaway M0 spikes: standalone project outside the workspace.
      "spikes/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
