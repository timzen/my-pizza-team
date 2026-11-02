// eslint.config.js — the web UI's lint rules: JS/TS recommended, React hooks,
// react-refresh, and jsx-a11y's recommended accessibility rules
// (docs/ACCESSIBILITY.md), every one an error. A justified exception is an
// `eslint-disable-next-line <rule> -- <reason>` on the line, never a config
// change.
// One project rule on top: an icon-only <Button size="icon…"> must be an
// IconButton, whose required `label` names it.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // An icon-only Button must be an IconButton (components/ui/icon-button.tsx),
      // which requires a `label` — so an unnamed icon control can't be written.
      'no-restricted-syntax': ['error', {
        selector: "JSXOpeningElement[name.name='Button']:has(JSXAttribute[name.name='size'][value.value=/^icon/])",
        message: 'Icon-only buttons use <IconButton label="…"> (components/ui/icon-button.tsx): the label is the accessible name and the tooltip.',
      }],
    },
  },
  {
    // shadcn-generated primitives idiomatically export variant helpers
    // (buttonVariants, badgeVariants, ...) alongside their components.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
