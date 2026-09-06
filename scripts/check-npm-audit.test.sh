#!/usr/bin/env bash
# scripts/check-npm-audit.test.sh
# Pruebas NEGATIVAS/positivas de la política de audit (fail-closed). No usa red:
# el clasificador es puro (JSON por stdin); el wrapper se prueba con dirs bogus y
# con `npm` ausente del PATH. Falla (exit 1) si cualquier caso no cumple.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CLASSIFY="$HERE/audit_classify.py"
WRAPPER="$HERE/check-npm-audit.sh"

pass=0; fail=0
ok()  { echo "  ok: $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1" >&2; fail=$((fail+1)); }

# assert_rc <expected> <actual> <label>
assert_rc() { if [ "$1" = "$2" ]; then ok "$3 (rc=$2)"; else bad "$3 (esperado rc=$1, fue rc=$2)"; fi; }

# classify <json> ; devuelve rc del clasificador
classify() { printf '%s' "$1" | ALLOWLIST="${ALLOWLIST:-}" python3 "$CLASSIFY" >/dev/null 2>&1; }

echo "== clasificador (JSON puro)"
classify ""; assert_rc 3 $? "stdin vacío ⇒ 3"
classify "no-es-json{"; assert_rc 3 $? "JSON inválido ⇒ 3"
classify '{"error":{"summary":"ENETUNREACH registry"}}'; assert_rc 4 $? "objeto error (red) ⇒ 4"
classify '{"foo":1}'; assert_rc 5 $? "sin clave vulnerabilities ⇒ 5"
classify '{"vulnerabilities":[]}'; assert_rc 5 $? "vulnerabilities no-objeto ⇒ 5"
classify '{"vulnerabilities":{}}'; assert_rc 0 $? "sin vulns ⇒ 0"
classify '{"vulnerabilities":{"lodash":{"severity":"high"}}}'; assert_rc 1 $? "HIGH fuera de allowlist ⇒ 1"
ALLOWLIST="lodash" classify '{"vulnerabilities":{"lodash":{"severity":"high"}}}'; assert_rc 0 $? "HIGH en allowlist ⇒ 0"
classify '{"vulnerabilities":{"x":{"severity":"moderate"}}}'; assert_rc 0 $? "moderate no bloquea ⇒ 0"
classify '{"vulnerabilities":{"y":{"severity":"critical"}}}'; assert_rc 1 $? "CRITICAL fuera de allowlist ⇒ 1"

echo "== wrapper (precondiciones de entorno, fail-closed)"
# dir inexistente ⇒ != 0 (requisito explícito del pedido)
( cd "$ROOT" && bash "$WRAPPER" does-not-exist >/dev/null 2>&1 ); assert_rc 1 $? "check-npm-audit.sh does-not-exist ⇒ 1"

# dir sin package.json ⇒ != 0
tmp_nopkg="$(mktemp -d)"; ( cd "$ROOT" && bash "$WRAPPER" "$tmp_nopkg" >/dev/null 2>&1 ); assert_rc 1 $? "dir sin package.json ⇒ 1"; rm -rf "$tmp_nopkg"

# npm ausente del PATH ⇒ exit 2 (fail-closed). PATH mínimo con dirname pero sin npm.
tmpbin="$(mktemp -d)"
for t in dirname; do ln -s "$(command -v "$t")" "$tmpbin/$t" 2>/dev/null; done
BASH_ABS="$(command -v bash)"
( cd "$ROOT" && PATH="$tmpbin" "$BASH_ABS" "$WRAPPER" apps/api >/dev/null 2>&1 ); assert_rc 2 $? "npm ausente del PATH ⇒ 2"
rm -rf "$tmpbin"

echo ""
echo "RESULTADO: $pass ok, $fail fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ check-npm-audit fail-closed verificado"
