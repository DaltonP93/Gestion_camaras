#!/usr/bin/env bash
# infra/certbot/init-ssl.test.sh
# Prueba REPRODUCIBLE del bootstrap de init-ssl.sh con Docker MOCKEADO (sin red, sin
# contenedores, sin tocar producción). `bash -n` y greps estáticos NO alcanzan: esto
# ejerce el FLUJO real de decisión.
#
# Mockea `docker` (compose run/up/exec, volume inspect), `sleep` y `openssl` en un
# PATH temporal; el "volumen" /etc/letsencrypt se mapea a un dir temporal. Cubre:
#   A) estado VACÍO           → emite (certonly --cert-name camaras-le, entrypoint certbot)
#   B) dummy interrumpido      → NO se confunde con linaje real: lo borra y emite
#   C) linaje ADMINISTRADO     → early-exit: NO re-emite y NO borra el linaje válido
#
# Verifica además el blocker #1: la emisión NO hereda el loop de `renew` (entrypoint
# debe ser el binario `certbot`, si no el mock falla la emisión).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INIT_SSL="${ROOT}/infra/certbot/init-ssl.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"; mkdir -p "$BIN"
export FAKE_LE="$TMP/letsencrypt"
export CALLS_LOG="$TMP/calls.log"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# ── Mock: sleep (no-op) ──
cat > "$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# ── Mock: openssl (escribe placeholders en -keyout/-out, sin criptografía) ──
cat > "$BIN/openssl" <<'EOF'
#!/usr/bin/env bash
out=""; key=""
while [ $# -gt 0 ]; do
  case "$1" in
    -out) out="$2"; shift 2;;
    -keyout) key="$2"; shift 2;;
    *) shift;;
  esac
done
[ -n "$key" ] && printf 'DUMMY-KEY\n'  > "$key"
[ -n "$out" ] && printf 'DUMMY-CERT\n' > "$out"
exit 0
EOF

# ── Mock: docker (compose run/up/exec + volume inspect). /etc/letsencrypt→$FAKE_LE ──
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
LE="$FAKE_LE"
log(){ echo "$*" >> "$CALLS_LOG"; }
rw(){ printf '%s' "$1" | sed "s#/etc/letsencrypt#$LE#g"; }

cmd="${1:-}"; shift || true
if [ "$cmd" = "volume" ]; then echo "$LE"; exit 0; fi
if [ "$cmd" != "compose" ]; then log "docker $cmd $*"; exit 0; fi

sub="${1:-}"; shift || true
case "$sub" in
  up)   log "compose up $*"; exit 0;;
  exec) log "compose exec $*"; exit 0;;
  run)
    entrypoint="__unset__"
    while [ $# -gt 0 ]; do
      case "$1" in
        --rm) shift;;
        --entrypoint) entrypoint="${2:-}"; shift 2;;
        certbot) shift; break;;
        *) shift;;
      esac
    done
    log "run entrypoint=[$entrypoint] cmd=[$*]"
    case "${1:-}" in
      test)
        shift
        args=(); for a in "$@"; do args+=("$(rw "$a")"); done
        test "${args[@]}"; exit $?;;
      sh)
        shift; [ "${1:-}" = "-c" ] && shift
        sh -c "$(rw "${1:-}")"; exit $?;;
      certonly)
        log "ISSUE entrypoint=[$entrypoint] $*"
        name=""
        while [ $# -gt 0 ]; do case "$1" in --cert-name) name="${2:-}"; shift 2;; *) shift;; esac; done
        [ -n "$name" ] || { echo "MOCK: certonly SIN --cert-name" >&2; exit 90; }
        [ "$entrypoint" = "certbot" ] || { echo "MOCK: certonly SIN --entrypoint certbot (heredaría el loop de renew)" >&2; exit 91; }
        # Simular linaje ADMINISTRADO por certbot: archive + live(symlinks) + renewal.conf
        rm -rf "$LE/live/$name"
        mkdir -p "$LE/archive/$name" "$LE/live/$name" "$LE/renewal"
        printf 'REAL-CERT\n' > "$LE/archive/$name/fullchain1.pem"
        printf 'REAL-KEY\n'  > "$LE/archive/$name/privkey1.pem"
        ln -sf "../../archive/$name/fullchain1.pem" "$LE/live/$name/fullchain.pem"
        ln -sf "../../archive/$name/privkey1.pem"  "$LE/live/$name/privkey.pem"
        printf '# managed by certbot\n' > "$LE/renewal/$name.conf"
        exit 0;;
      *) log "run-other $*"; exit 0;;
    esac
    ;;
  *) log "compose $sub $*"; exit 0;;
esac
EOF

chmod +x "$BIN/sleep" "$BIN/openssl" "$BIN/docker"
export PATH="$BIN:$PATH"

run_case() {  # $1 = etiqueta
  : > "$CALLS_LOG"
  ( cd "$ROOT" && bash "$INIT_SSL" ) > "$TMP/out.$1.log" 2>&1
  echo $?
}

echo "== Test bootstrap init-ssl.sh (docker mockeado) — linaje camaras-le"

# ── Caso A: estado VACÍO → debe emitir ──
rm -rf "$FAKE_LE"; mkdir -p "$FAKE_LE"
rcA="$(run_case A)"
[ "$rcA" = "0" ] && ok "A(vacío): init-ssl.sh termina 0" || bad "A(vacío): rc=$rcA (ver $TMP/out.A.log)"
grep -q "ISSUE entrypoint=\[certbot\] .*--cert-name" "$CALLS_LOG" \
  && ok "A: certonly ejecutado con entrypoint certbot y --cert-name" \
  || bad "A: no se ejecutó certonly correctamente"
[ -f "$FAKE_LE/renewal/camaras-le.conf" ] && ok "A: linaje administrado creado (renewal.conf)" || bad "A: no se creó renewal.conf"
[ -L "$FAKE_LE/live/camaras-le/fullchain.pem" ] && ok "A: live/…/fullchain.pem es symlink (managed)" || bad "A: fullchain no es symlink managed"
[ ! -f "$FAKE_LE/live/camaras-le/.dummy" ] && ok "A: marcador .dummy removido antes de emitir" || bad "A: quedó el .dummy"
grep -q "compose exec nginx nginx -s reload" "$CALLS_LOG" && ok "A: nginx recargado tras emitir" || bad "A: no se recargó nginx"

# ── Caso B: dummy interrumpido (sin renewal.conf) → NO confundir, borrar y emitir ──
rm -rf "$FAKE_LE"; mkdir -p "$FAKE_LE/live/camaras-le"
printf 'DUMMY\n' > "$FAKE_LE/live/camaras-le/fullchain.pem"
printf 'DUMMY\n' > "$FAKE_LE/live/camaras-le/privkey.pem"
touch "$FAKE_LE/live/camaras-le/.dummy"       # marcador de dummy (NO hay renewal.conf)
rcB="$(run_case B)"
[ "$rcB" = "0" ] && ok "B(dummy): init-ssl.sh termina 0" || bad "B(dummy): rc=$rcB (ver $TMP/out.B.log)"
grep -q "ISSUE entrypoint=\[certbot\]" "$CALLS_LOG" \
  && ok "B: NO se confundió el dummy con linaje real → emitió" \
  || bad "B: no emitió (¿el test -f fullchain hizo early-exit incorrecto?)"
[ -f "$FAKE_LE/renewal/camaras-le.conf" ] && ok "B: linaje administrado creado tras recuperar" || bad "B: no quedó renewal.conf"
[ -L "$FAKE_LE/live/camaras-le/fullchain.pem" ] && ok "B: live reemplazado por symlink managed" || bad "B: live sigue siendo dummy"

# ── Caso C: linaje ADMINISTRADO presente → early-exit, sin re-emitir ni borrar ──
rm -rf "$FAKE_LE"; mkdir -p "$FAKE_LE/renewal" "$FAKE_LE/archive/camaras-le" "$FAKE_LE/live/camaras-le"
printf 'REAL-CERT\n' > "$FAKE_LE/archive/camaras-le/fullchain1.pem"
printf 'REAL-KEY\n'  > "$FAKE_LE/archive/camaras-le/privkey1.pem"
ln -sf "../../archive/camaras-le/fullchain1.pem" "$FAKE_LE/live/camaras-le/fullchain.pem"
ln -sf "../../archive/camaras-le/privkey1.pem"  "$FAKE_LE/live/camaras-le/privkey.pem"
printf 'ORIGINAL-MANAGED\n' > "$FAKE_LE/renewal/camaras-le.conf"
rcC="$(run_case C)"
[ "$rcC" = "0" ] && ok "C(managed): init-ssl.sh termina 0 (early-exit)" || bad "C(managed): rc=$rcC (ver $TMP/out.C.log)"
grep -q "ISSUE" "$CALLS_LOG" && bad "C: se re-emitió sobre un linaje administrado (no debía)" || ok "C: NO se re-emitió (certonly no llamado)"
[ "$(cat "$FAKE_LE/renewal/camaras-le.conf")" = "ORIGINAL-MANAGED" ] \
  && ok "C: renewal.conf del linaje administrado quedó INTACTO" \
  || bad "C: se modificó/borró el linaje administrado"
[ ! -f "$FAKE_LE/live/camaras-le/.dummy" ] && ok "C: no se creó dummy sobre el linaje administrado" || bad "C: se creó un dummy sobre un linaje válido"

echo ""
echo "== Resultado: ${pass} ok, ${fail} fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ Bootstrap de init-ssl.sh correcto en los 3 estados."
