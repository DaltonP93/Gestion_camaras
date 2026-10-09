#!/usr/bin/env bash
# scripts/check-uploads-nginx.test.sh
# Pruebas NEGATIVAS/positivas del guard de cabeceras de /uploads/. Sin red ni
# nginx: muta COPIAS temporales de infra/nginx/nginx.conf y exige que el guard
# falle (exit 1) ante cada regresión. Falla (exit 1) si cualquier caso no cumple.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GUARD="$HERE/check-uploads-nginx.sh"
CONF="$ROOT/infra/nginx/nginx.conf"

pass=0; fail=0
ok()  { echo "  ok: $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1" >&2; fail=$((fail+1)); }
assert_rc() { if [ "$1" = "$2" ]; then ok "$3 (rc=$2)"; else bad "$3 (esperado rc=$1, fue rc=$2)"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# mutate <nombre> <expresión sed> ; corre el guard sobre la copia mutada.
mutate() {
  local f="$TMP/$1.conf"
  sed -E "$2" "$CONF" > "$f"
  if cmp -s "$f" "$CONF"; then bad "$1: la mutación no cambió nada (¿cambió la config?)"; return 99; fi
  bash "$GUARD" "$f" >/dev/null 2>&1
}

echo "== positivo"
bash "$GUARD" "$CONF" >/dev/null 2>&1; assert_rc 0 $? "nginx.conf del repo ⇒ 0"

echo "== negativos (cada regresión debe abortar)"
mutate no-nosniff  '/location \/uploads\//,/^        \}/{/X-Content-Type-Options/d}'; assert_rc 1 $? "sin nosniff en /uploads/ ⇒ 1"
mutate no-xfo      '/location \/uploads\//,/^        \}/{/X-Frame-Options/d}'; assert_rc 1 $? "sin X-Frame-Options en /uploads/ ⇒ 1"
mutate no-hsts     '/location \/uploads\//,/^        \}/{/Strict-Transport-Security/d}'; assert_rc 1 $? "sin HSTS en /uploads/ ⇒ 1"
mutate no-csp      '/location \/uploads\//,/^        \}/{/Content-Security-Policy/d}'; assert_rc 1 $? "sin CSP en /uploads/ ⇒ 1"
mutate csp-comment '/location \/uploads\//,/^        \}/{s/^([[:space:]]*)(add_header Content-Security-Policy)/\1# \2/}'; assert_rc 1 $? "CSP comentada ⇒ 1"
mutate no-sandbox  '/location \/uploads\//,/^        \}/{/Content-Security-Policy/s/; sandbox"/"/}'; assert_rc 1 $? "CSP sin sandbox ⇒ 1"
mutate allow-scr   '/location \/uploads\//,/^        \}/{/Content-Security-Policy/s/sandbox"/sandbox allow-scripts"/}'; assert_rc 1 $? "sandbox allow-scripts ⇒ 1"
mutate no-fa       "/location \\/uploads\\//,/^        \\}/{/Content-Security-Policy/s/ frame-ancestors 'self';//}"; assert_rc 1 $? "CSP sin frame-ancestors ⇒ 1"
mutate no-location 's/location \/uploads\//location \/uploadz\//'; assert_rc 1 $? "sin location /uploads/ ⇒ 1"
bash "$GUARD" "$TMP/no-existe.conf" >/dev/null 2>&1; assert_rc 1 $? "archivo inexistente ⇒ 1"

echo ""
echo "RESULTADO: $pass ok, $fail fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ guard de cabeceras de /uploads/ verificado"
