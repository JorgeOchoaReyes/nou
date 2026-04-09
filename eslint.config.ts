import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"], 
    plugins: { js }, extends: ["js/recommended"], 
    languageOptions: { globals: globals.browser },
    rules: {
      "no-console": "off",
      "indent": ["error", 2],
      "quotes": [2, "double"],
      "semi": [2, "always"]
    } 
  },
  tseslint.configs.recommended,
]);
