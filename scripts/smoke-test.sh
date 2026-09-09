#!/usr/bin/env bash
# smoke-test.sh — verificación post-deploy de VisionCore (solo lectura).
#
# Comprueba que un despliegue recién levantado responde de extremo a extremo:
# health → deep-health (DB+Redis) → login → perfil autenticado → listado RBAC.
# NO muta nada (no crea/borra NVR, no envía correos, no toca cámaras) y NUNCA
# imprime secretos, cookies, tokens ni IPs (invariante #6).
#
# Autenticación por COOKIE HttpOnly (migración P2): el login NO devuelve tokens en
# el cuerpo; deja `access_token`/`refresh_token` como cookies HttpOnly. Este script
# usa un cookie-jar temporal (curl -c/-b) y NUNCA imprime su contenido.
#
# Uso:
#   BASE_URL=http://localhost:4000 SMOKE_USERNAME=admin SMOKE_PASSWORD=... \
#     bash scripts/smoke-test.sh
#
# Salidas: 0 = todo OK · 1 = fallo de aserción · 2 = configuración faltante.
# Si el login exige 2FA/enrolamiento (política MFA), se reporta como INFO y se
# omiten los pasos autenticados sin marcar fallo (no es un error del deploy).
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
USERNAME="${SMOKE_USERNAME:-}"
PASSWORD="${SMOKE_PASSWORD:-}"

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
info() { echo "  ℹ️  $1"; }

# Cookie-jar temporal (se borra al salir). Nunca se imprime su contenido.
COOKIE_JAR="$(mktemp)"
cleanup() { rm -f "$COOKIE_JAR" /tmp/smoke_body /tmp/smoke_login 2>/dev/null; }
trap cleanup EXIT

# GET con código HTTP; cuerpo a /tmp/smoke_body, código a stdout. Envía las cookies
# de sesión del jar (auth por cookie HttpOnly).
http_get() { curl -sS -m 15 -b "$COOKIE_JAR" -o /tmp/smoke_body -w '%{http_code}' "$@" 2>/dev/null; }

echo "== VisionCore smoke test → ${BASE_URL}"

# 1) /health (sin auth)
code=$(http_get "${BASE_URL}/health")
[ "$code" = "200" ] && ok "/health 200" || bad "/health esperaba 200, obtuvo ${code:-sin-respuesta}"

# 2) /api/health/deep (DB + Redis)
code=$(http_get "${BASE_URL}/api/health/deep")
if [ "$code" = "200" ]; then ok "/api/health/deep 200 (DB+Redis)"
else bad "/api/health/deep esperaba 200, obtuvo ${code:-sin-respuesta} — revisar DB/Redis"; fi

# 3) login (requiere credenciales por env)
if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  info "SMOKE_USERNAME/SMOKE_PASSWORD no seteados ⇒ omito pasos autenticados"
  echo "== Resultado parcial: ${pass} ok, ${fail} fail (sin auth)"
  [ "$fail" -eq 0 ] || exit 1; exit 0
fi

# El login deja las cookies HttpOnly en el jar (-c). Se manda Origin same-origin
# por realismo (la guarda CSRF sólo exige Origin cuando YA hay cookie de sesión;
# en el login todavía no la hay, así que pasa igual). NO se imprime el jar.
code=$(curl -sS -m 15 -c "$COOKIE_JAR" -o /tmp/smoke_login -w '%{http_code}' \
  -H 'Content-Type: application/json' -H "Origin: ${BASE_URL}" \
  -d "{\"username\":$(printf '%s' "$USERNAME" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"password\":$(printf '%s' "$PASSWORD" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
  "${BASE_URL}/api/auth/login" 2>/dev/null)

AUTHED=""
if [ "$code" = "200" ]; then
  # El cuerpo YA NO trae tokens (auth por cookie). Éxito = trae `user`; MFA/enroll se
  # detectan por sus flags. La cookie access_token debe existir en el jar.
  flag=$(python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("ERR"); raise SystemExit
if d.get("requiresTwoFactor"): print("MFA")
elif d.get("requiresMfaEnrollment"): print("ENROLL")
elif isinstance(d.get("user"), dict): print("OK")
else: print("ERR")
' < /tmp/smoke_login)
  has_cookie=""
  grep -q 'access_token' "$COOKIE_JAR" 2>/dev/null && has_cookie=1
  case "$flag" in
    OK)
      if [ -n "$has_cookie" ]; then AUTHED=1; ok "login 200 (cookie de sesión establecida)"
      else bad "login 200 con user pero SIN cookie access_token (revisar Set-Cookie)"; fi;;
    MFA)    info "login exige 2FA (política MFA activa) ⇒ omito pasos autenticados";;
    ENROLL) info "login exige enrolar MFA ⇒ omito pasos autenticados";;
    *)      bad "login 200 pero respuesta inesperada (sin user)";;
  esac
else
  bad "login esperaba 200, obtuvo ${code:-sin-respuesta} (verificar usuario/clave)"
fi

# 4) /api/auth/me + 5) /api/nvrs (autenticados por cookie) — solo si el login prendió
if [ -n "$AUTHED" ]; then
  code=$(http_get "${BASE_URL}/api/auth/me")
  [ "$code" = "200" ] && ok "/api/auth/me 200 (perfil)" || bad "/api/auth/me esperaba 200, obtuvo ${code}"

  code=$(http_get "${BASE_URL}/api/nvrs")
  [ "$code" = "200" ] && ok "/api/nvrs 200 (listado RBAC)" || bad "/api/nvrs esperaba 200, obtuvo ${code}"
fi

echo "== Resultado: ${pass} ok, ${fail} fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ Smoke test OK"
