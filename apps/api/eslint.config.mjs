// apps/api/eslint.config.mjs — gate de lint de alto valor y bajo ruido.
// Objetivo: bloquear en CI patrones que son BUGS reales (no estilo). Se parte de la
// base recomendada de typescript-eslint (sin chequeo de tipos, rápido) y se apagan
// las reglas ruidosas/estilísticas que en un código maduro sólo generan churn.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'prisma/**', '**/*.js', '**/*.mjs', '**/*.cjs'] },
  // No fallar por directivas eslint-disable "sin uso" heredadas (el repo no tenía lint).
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      // ── Ruido estilístico / intencional en este código maduro → off ──
      'no-undef': 'off',                                     // el compilador TS ya lo cubre
      '@typescript-eslint/no-explicit-any': 'off',           // any acotado intencional en varios puntos
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',   // tipos `Function` en algunos contratos
      '@typescript-eslint/no-require-imports': 'off',        // 1 require() legacy (interop)
      'no-useless-escape': 'off',                            // escapes deliberados en regex
      'no-empty': ['error', { allowEmptyCatch: true }],      // `catch {}` es idioma aquí; bloquea otros vacíos
      // ── Reglas de BUG real que SÍ bloquean CI (además de las recommended de js/tseslint) ──
      // no-unused-vars arranca como WARNING (rollout escalonado): son código muerto
      // preexistente, no bugs de runtime; se ven en el output pero no rompen CI todavía.
      // Subir a 'error' cuando se limpien (seguimiento).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
)
