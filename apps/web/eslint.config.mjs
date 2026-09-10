// apps/web/eslint.config.mjs — gate de lint de alto valor y bajo ruido (frontend).
// Mismo criterio que apps/api: bloquear BUGS reales (reglas recommended de js +
// typescript-eslint), no estilo. no-unused-vars arranca como warning (rollout).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'e2e/**', 'public/**', '**/*.js', '**/*.mjs', '**/*.cjs'] },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // React hooks: rules-of-hooks son BUGS reales (hooks condicionales) ⇒ error;
      // exhaustive-deps es ruidosa/heurística ⇒ warning (y respeta los eslint-disable
      // que ya existen en el código).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-useless-escape': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true,
      }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
)
