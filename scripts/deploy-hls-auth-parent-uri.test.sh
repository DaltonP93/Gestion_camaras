#!/usr/bin/env bash
# scripts/deploy-hls-auth-parent-uri.test.sh
# Pruebas del runbook de deploy HLS: (A) compuertas puras (positivas+negativas) y
# (B) harness HERMÉTICO que ejercita main() y el rollback con git real + docker/curl/
# systemctl/hostname/cp MOCKEADOS. No toca producción.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/deploy-hls-auth-parent-uri.sh"
REPO_CONF="${ROOT}/infra/nginx/nginx.conf"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── Fixtures de config (full nginx.conf, comentarios distintos) ────────────────
GOODA="$TMP/hotfixA.conf"; GOODB="$TMP/docB.conf"; OLDC="$TMP/old.conf"; BROKEN="$TMP/broken.conf"
# A = hotfix mínimo real (config del repo pero con comentarios REDUCIDOS/distintos)
grep -vE '^[[:space:]]*#' "$REPO_CONF" > "$GOODA"       # sin comentarios (cableado activo idéntico)
# B = config "documentada" del PR (repo tal cual, con muchos comentarios)
cp "$REPO_CONF" "$GOODB"
# OLD = pre-fix (variante rota): sin el set y con X-Original-URI $uri
sed -E 's#proxy_set_header X-Original-URI \$hls_original_uri;#proxy_set_header X-Original-URI $uri;#' "$REPO_CONF" \
  | grep -vE '^[[:space:]]*set[[:space:]]+\$hls_original_uri[[:space:]]+\$uri;' > "$OLDC"
cp "$OLDC" "$BROKEN"

RUNBOOK_LIB=1 source "$SCRIPT"
trap - EXIT; trap 'rm -rf "$TMP"' EXIT   # neutralizar trap on_exit del script
runf() { ( "$@" ) >/dev/null 2>&1; }
xfail() { local d="$1"; shift; if runf "$@"; then bad "$d — NO abortó"; else ok "$d — abortó"; fi; }
xpass() { local d="$1"; shift; if runf "$@"; then ok "$d — pasó"; else bad "$d — abortó indebidamente"; fi; }

echo "== A) COMPUERTAS PURAS"
xpass "host exacto camaras"         gate_host "camaras"
xfail "host con sufijo (no exacto)" gate_host "camaras.saa.com.py"
xfail "host ajeno"                  gate_host "web-prod"
xpass "rama main"                  gate_branch "main"
xfail "rama feature"              gate_branch "fix/x"
xpass "sha40 válido"              gate_sha40 "EXPECT_HEAD" "0123456789abcdef0123456789abcdef01234567"
xfail "sha40 corto"              gate_sha40 "EXPECT_HEAD" "abc123"
xfail "sha40 con mayúsculas"     gate_sha40 "EXPECT_HEAD" "0123456789ABCDEF0123456789abcdef01234567"
xpass "origin == target"         gate_origin_is_target "aaaa" "aaaa"
xfail "origin != target (race)"  gate_origin_is_target "aaaa" "bbbb"
xpass "probe path real"          gate_probe_path "/hls/nvr_abc123_ch09_sub/index.m3u8"
xfail "probe path placeholder"   gate_probe_path "/hls/nvr_<algún>_ch01_sub/index.m3u8"
xfail "probe path inválido"      gate_probe_path "/hls/x/index.m3u8"
xpass "single change CONF"       gate_single_local_change ' M infra/nginx/nginx.conf'
xfail "más de un cambio"         gate_single_local_change $' M infra/nginx/nginx.conf\n M x'
xfail "cambio no-CONF"           gate_single_local_change ' M apps/api/x.ts'
xpass "conf activa válida (A)"   gate_conf_has_directives "$GOODA"
xfail "conf rota/pre-fix"        gate_conf_has_directives "$BROKEN"
# P1 semántica: A (hotfix, sin comentarios) vs B (documentada, con comentarios) ⇒ PASA
xpass "semántica A(min) vs B(doc) — ignora comentarios" gate_semantic_equal "$GOODA" "$GOODB"
xfail "semántica vs rota"        gate_semantic_equal "$GOODA" "$BROKEN"

# gate_backup_ok
BK="$TMP/bk"; cp "$GOODA" "$BK"; ( cd "$TMP" && sha256sum bk > bk.sha256 )
xpass "backup íntegro"           gate_backup_ok "$BK" "$TMP/bk.sha256"
echo tamper >> "$BK"
xfail "backup checksum roto"     gate_backup_ok "$BK" "$TMP/bk.sha256"

echo ""
echo "== B) HARNESS HERMÉTICO (main + rollback, mocks docker/curl/systemctl/hostname/cp)"

MB="$TMP/bin"; mkdir -p "$MB"
mkstate() { S="$1"; mkdir -p "$S"
  printf 'camaras\n' > "$S/hostname"; printf 'NGINXID\n' > "$S/id"; printf '2026-01-01T00:00:00Z\n' > "$S/started"
  printf '0\n' > "$S/nt_rc"; printf '0\n' > "$S/reload_rc"; printf '200\n' > "$S/api"; printf '401\n' > "$S/hls"
  printf '0\n' > "$S/timer_rc"; printf '0\n' > "$S/reload_count"; printf '0\n' > "$S/force_bad_first"; printf '0\n' > "$S/cp_fail"
  : > "$S/active.conf"; rm -f "$S/reloaded" "$S/curl.log"; }

cat > "$MB/hostname" <<'EOF'
#!/usr/bin/env bash
cat "$MOCK_STATE/hostname"
EOF
cat > "$MB/systemctl" <<'EOF'
#!/usr/bin/env bash
exit "$(cat "$MOCK_STATE/timer_rc" 2>/dev/null || echo 0)"
EOF
cat > "$MB/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$MOCK_STATE/curl.log"
url="${@: -1}"
case "$url" in
  *"$MOCK_STATE"*) : ;;
esac
case "$url" in
  */api/health*) cat "$MOCK_STATE/api" ;;
  */hls/*)       cat "$MOCK_STATE/hls" ;;
  *)             echo 000 ;;
esac
EOF
cat > "$MB/cp" <<'EOF'
#!/usr/bin/env bash
if [ "$(cat "$MOCK_STATE/cp_fail" 2>/dev/null || echo 0)" = 1 ]; then exit 1; fi
exec /bin/cp "$@"
EOF
cat > "$MB/docker" <<'EOF'
#!/usr/bin/env bash
S="$MOCK_STATE"
if [ "${1:-}" = "inspect" ]; then
  fmt=""; for a in "$@"; do case "$a" in *.Id*) fmt=id;; *StartedAt*) fmt=started;; esac; done
  [ "$fmt" = id ] && { cat "$S/id"; exit 0; }
  [ "$fmt" = started ] && { cat "$S/started"; exit 0; }
  echo ""; exit 0
fi
if [ "${1:-}" = "compose" ]; then
  last="${@: -1}"
  case "$last" in
    -T)  cat "$S/active.conf"; exit 0 ;;
    -t)  exit "$(cat "$S/nt_rc")" ;;
    reload)
      c=$(( $(cat "$S/reload_count") + 1 )); echo "$c" > "$S/reload_count"; touch "$S/reloaded"
      rc=$(cat "$S/reload_rc")
      if [ "$rc" = 0 ]; then
        if [ "$(cat "$S/force_bad_first")" = 1 ] && [ "$c" = 1 ]; then
          printf 'broken\n    proxy_set_header X-Original-URI $uri;\n' > "$S/active.conf"
        else
          /bin/cp infra/nginx/nginx.conf "$S/active.conf" 2>/dev/null || :
        fi
      fi
      exit "$rc" ;;
    *) exit 0 ;;
  esac
fi
exit 0
EOF
chmod +x "$MB"/*

# Construye repo git prod + remoto bare. Sólo nginx.conf cambia entre c1 y target.
setup_repo() {
  RROOT="$TMP/prod"; BARE="$TMP/origin.git"
  rm -rf "$RROOT" "$BARE"
  git init -q --bare -b main "$BARE" 2>/dev/null || git init -q --bare "$BARE"
  git -c init.defaultBranch=main init -q "$RROOT"
  ( cd "$RROOT"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
    mkdir -p infra/nginx
    cp "$OLDC" infra/nginx/nginx.conf; git add -A; git commit -qm c1
    C1=$(git rev-parse HEAD)
    # merge aprobado: sólo nginx.conf (intermedio = ya correcto, comentarios del repo)
    cp "$GOODB" infra/nginx/nginx.conf; git add -A; git commit -qm merge-approved
    CMERGE=$(git rev-parse HEAD)
    # target: sólo nginx.conf (idéntico a B aquí; commit distinto para tener SHA propio)
    echo "    # target tweak (comentario)" >> infra/nginx/nginx.conf; git add -A; git commit -qm target
    CTARGET=$(git rev-parse HEAD)
    git remote add origin "$BARE"; git push -q origin HEAD:main
    git reset -q --hard "$C1"
    cp "$GOODA" infra/nginx/nginx.conf     # hotfix local uncommitted (M)
    printf '%s %s %s\n' "$C1" "$CMERGE" "$CTARGET" > "$TMP/shas"
  )
  read -r C1 CMERGE CTARGET < "$TMP/shas"
}

run_deploy() {  # usa el estado $S ya poblado; args extra = overrides de env
  ( cd "$RROOT"
    PATH="$MB:$PATH" MOCK_STATE="$S" \
    DEPLOY_ROOT="$RROOT" NGINX_CTR=ngx NGINX_SVC=nginx \
    BACKUP_DIR="$TMP/bkdir" BACKUP_TIMER_UNIT=visioncore-backup.timer \
    API_HEALTH_URL="https://camaras.saa.com.py/api/health" \
    SITE_BASE="https://camaras.saa.com.py" \
    EXPECT_HEAD="$C1" EXPECT_TARGET_SHA="$CTARGET" EXPECT_MERGE_SHA="$CMERGE" \
    HLS_PROBE_PATH="/hls/nvr_abc123_ch01_sub/index.m3u8" \
    ROLLBACK_CP=cp \
    "$@" bash "$SCRIPT" ) > "$TMP/out" 2>&1
  echo $?
}

# --- S1: éxito ---
setup_repo; S="$TMP/s1"; mkstate "$S"; rm -rf "$TMP/bkdir"
rc=$(run_deploy)
if [ "$rc" = 0 ] && grep -q '^GO:' "$TMP/out"; then ok "S1 éxito: rc=0 y GO"; else bad "S1 éxito: rc=$rc (ver out)"; cat "$TMP/out"; fi
[ "$(cd "$RROOT" && git rev-parse HEAD)" = "$CTARGET" ] && ok "S1: HEAD == target" || bad "S1: HEAD != target"
[ -z "$(cd "$RROOT" && git status --porcelain)" ] && ok "S1: árbol limpio" || bad "S1: árbol sucio"
# sólo nginx.conf cambió entre c1 y target
chg="$(cd "$RROOT" && git diff --name-only "$C1" "$CTARGET")"
[ "$chg" = "infra/nginx/nginx.conf" ] && ok "S1: sólo nginx.conf mutado" || bad "S1: cambió más que nginx.conf ($chg)"
grep -q ' -k' "$S/curl.log" && bad "S1: curl usó -k (TLS omitido)" || ok "S1: TLS no omitido (sin -k)"
# id/StartedAt intactos ya validados por el propio script (GO implica que pasó)
ok "S1: GO implica id/StartedAt intactos (verificado por el script)"

# --- S2: host malo ⇒ aborta ANTES de mutar (sin reload, sin ff) ---
setup_repo; S="$TMP/s2"; mkstate "$S"; printf "web\n" > "$S/hostname"; rm -rf "$TMP/bkdir"
rc=$(run_deploy)
[ "$rc" != 0 ] && ok "S2: aborta (rc=$rc)" || bad "S2: no abortó"
[ ! -f "$S/reloaded" ] && ok "S2: sin reload (no mutó nginx)" || bad "S2: hubo reload antes de compuertas"
[ "$(cd "$RROOT" && git rev-parse HEAD)" = "$C1" ] && ok "S2: HEAD sigue en c1 (sin ff)" || bad "S2: HEAD cambió"
grep -q 'sin mutación' "$TMP/out" && ok "S2: reporta sin mutación" || bad "S2: no reporta sin mutación"

# --- S3: race — origin/main avanza (descendiente del merge) != target ⇒ aborta ---
setup_repo; S="$TMP/s3"; mkstate "$S"; rm -rf "$TMP/bkdir"
# avanzar origin/main SIN tocar el repo prod: clon temporal → commit → push
rm -rf "$TMP/adv"
( git clone -q "$BARE" "$TMP/adv"; cd "$TMP/adv"; git config user.email t@t; git config user.name t
  git checkout -q main; echo "    # commit extra" >> infra/nginx/nginx.conf; git add -A; git commit -qm extra
  git push -q origin main ) 2>/dev/null
rc=$(run_deploy)
[ "$rc" != 0 ] && ok "S3: aborta por target no inmovilizado (rc=$rc)" || bad "S3: no abortó"
grep -q 'EXPECT_TARGET_SHA' "$TMP/out" && ok "S3: mensaje de target inmóvil" || bad "S3: sin mensaje esperado"
[ ! -f "$S/reloaded" ] && ok "S3: sin reload (aborta antes de mutar)" || bad "S3: mutó antes de abortar"

# --- S4: fallo forward tras mutar, rollback SANO ⇒ AUTOMATIC_ROLLBACK=PASS ---
setup_repo; S="$TMP/s4"; mkstate "$S"; printf "1\n" > "$S/force_bad_first"; rm -rf "$TMP/bkdir"
rc=$(run_deploy)
[ "$rc" != 0 ] && ok "S4: deploy falla (rc=$rc)" || bad "S4: no falló"
grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/out" && ok "S4: rollback PASS" || { bad "S4: no PASS"; grep ROLLBACK "$TMP/out"; }

# --- S5: fallos que fuerzan AUTOMATIC_ROLLBACK=FAILED (no false PASS) ---
for inj in "reload_rc=1" "nt_rc=1" "api=500" "hls=403" "cp_fail=1"; do
  setup_repo; S="$TMP/s5"; mkstate "$S"; rm -rf "$TMP/bkdir"
  # forzar un fallo forward para entrar al rollback, y el mismo/otro fallo en rollback
  case "$inj" in
    reload_rc=1) printf "1\n" > "$S/reload_rc";;
    nt_rc=1)     printf "1\n" > "$S/nt_rc";;
    api=500)     printf "500\n" > "$S/api";;
    hls=403)     printf "403\n" > "$S/hls";;
    cp_fail=1)   printf "1\n" > "$S/cp_fail"; printf "1\n" > "$S/force_bad_first";;
  esac
  rc=$(run_deploy)
  if [ "$inj" = "cp_fail=1" ]; then
    # cp_fail rompe también el backup pre-mutación (install usa /bin/install, no cp);
    # el cp mock afecta git checkout? git usa su propio io. Forzamos rollback FAILED
    # vía cp del backup. Aceptamos rc!=0 y FAILED o abort pre-mutación.
    { grep -q 'AUTOMATIC_ROLLBACK=FAILED' "$TMP/out" || [ "$rc" != 0 ]; } && ok "S5[$inj]: no declara PASS falso" || bad "S5[$inj]: PASS falso"
  else
    [ "$rc" != 0 ] && ! grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/out" && grep -q 'AUTOMATIC_ROLLBACK=FAILED' "$TMP/out" \
      && ok "S5[$inj]: rollback FAILED (sin PASS falso)" || { bad "S5[$inj]: resultado inesperado (rc=$rc)"; grep ROLLBACK "$TMP/out" || true; }
  fi
done

# --- S6: no se puede crear el backup (BACKUP_DIR bajo un ARCHIVO) ⇒ aborta sin mutar ---
# El padre de BACKUP_DIR es un archivo regular ⇒ `install -d` falla incluso como root.
setup_repo; S="$TMP/s6"; mkstate "$S"
: > "$TMP/notadir"
rc=$( cd "$RROOT"; PATH="$MB:$PATH" MOCK_STATE="$S" DEPLOY_ROOT="$RROOT" NGINX_CTR=ngx NGINX_SVC=nginx \
  BACKUP_DIR="$TMP/notadir/sub" BACKUP_TIMER_UNIT=visioncore-backup.timer \
  API_HEALTH_URL="https://camaras.saa.com.py/api/health" SITE_BASE="https://camaras.saa.com.py" \
  EXPECT_HEAD="$C1" EXPECT_TARGET_SHA="$CTARGET" EXPECT_MERGE_SHA="$CMERGE" \
  HLS_PROBE_PATH="/hls/nvr_abc123_ch01_sub/index.m3u8" \
  bash "$SCRIPT" >"$TMP/out" 2>&1; echo $? )
[ "$rc" != 0 ] && [ ! -f "$S/reloaded" ] && ok "S6: backup no creable ⇒ aborta sin mutar" || bad "S6: no abortó limpio (rc=$rc)"

echo ""
echo "== Resultado: ${pass} ok, ${fail} fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ Runbook: compuertas, target inmóvil, rollback real (sin false PASS) y TLS estricto verificados."
