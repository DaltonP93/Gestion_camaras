#!/usr/bin/env bash
# scripts/deploy-hls-auth-parent-uri.test.sh
# Pruebas del runbook de deploy HLS y su bootstrap:
#   (A) compuertas puras (positivas+negativas);
#   (B) harness HERMÉTICO de main() (git real + docker/curl/systemctl/hostname/cp MOCKEADOS);
#   (C) rollback SECUENCIAL con CONTADORES (corte por fase, sin PASS falso);
#   (D) bootstrap desde un checkout SIN los scripts (extracción del target Git inmóvil).
# No toca producción.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/deploy-hls-auth-parent-uri.sh"
BOOT="${ROOT}/scripts/deploy-hls-auth-bootstrap.sh"
CHECKSH="${ROOT}/scripts/check-hls-auth-nginx.sh"
REPO_CONF="${ROOT}/infra/nginx/nginx.conf"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── Fixtures de config (full nginx.conf, comentarios distintos) ────────────────
GOODA="$TMP/hotfixA.conf"; GOODB="$TMP/docB.conf"; OLDC="$TMP/old.conf"; BROKEN="$TMP/broken.conf"
# A = hotfix mínimo real (config del repo pero SIN comentarios: cableado activo idéntico)
grep -vE '^[[:space:]]*#' "$REPO_CONF" > "$GOODA"
# B = config "documentada" del PR (repo tal cual, con muchos comentarios)
cp "$REPO_CONF" "$GOODB"
# OLD = pre-fix (variante rota): sin el set y con X-Original-URI $uri
sed -E 's#proxy_set_header X-Original-URI \$hls_original_uri;#proxy_set_header X-Original-URI $uri;#' "$REPO_CONF" \
  | grep -vE '^[[:space:]]*set[[:space:]]+\$hls_original_uri[[:space:]]+\$uri;' > "$OLDC"
cp "$OLDC" "$BROKEN"

RUNBOOK_LIB=1 source "$SCRIPT"
trap - EXIT; trap 'rm -rf "$TMP"' EXIT   # neutralizar trap on_exit del script
set +e                                    # el source activó -e; lo apagamos para el test
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
xpass "container running=true"   gate_container_running "true"
xfail "container running=false"  gate_container_running "false"
xfail "container running vacío"  gate_container_running ""
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
BK="$TMP/bk0"; cp "$GOODA" "$BK"; ( cd "$TMP" && sha256sum bk0 > bk0.sha256 )
xpass "backup íntegro"           gate_backup_ok "$BK" "$TMP/bk0.sha256"
echo tamper >> "$BK"
xfail "backup checksum roto"     gate_backup_ok "$BK" "$TMP/bk0.sha256"

echo ""
echo "== Mocks (docker/curl/systemctl/hostname/cp) con contadores"
MB="$TMP/bin"; mkdir -p "$MB"
mkstate() { S="$1"; mkdir -p "$S"
  printf 'camaras\n' > "$S/hostname"; printf 'NGINXID\n' > "$S/id"; printf '2026-01-01T00:00:00Z\n' > "$S/started"
  printf 'true\n' > "$S/running"
  printf '0\n' > "$S/nt_rc"; printf '0\n' > "$S/reload_rc"; printf '200\n' > "$S/api"; printf '401\n' > "$S/hls"
  printf '0\n' > "$S/timer_rc"
  printf '0\n' > "$S/reload_count"; printf '0\n' > "$S/nt_count"; printf '0\n' > "$S/cp_count"
  printf '0\n' > "$S/force_bad_first"; printf '0\n' > "$S/cp_fail"
  cp "$GOODB" "$S/active.conf"                 # baseline: config activa ya corre el hotfix (válida)
  rm -f "$S/reloaded" "$S/curl.log" "$S/docker.log"; }

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
  */api/health*) cat "$MOCK_STATE/api" ;;
  */hls/*)       cat "$MOCK_STATE/hls" ;;
  *)             echo 000 ;;
esac
EOF
cat > "$MB/cp" <<'EOF'
#!/usr/bin/env bash
c=$(( $(cat "$MOCK_STATE/cp_count" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$MOCK_STATE/cp_count"
if [ "$(cat "$MOCK_STATE/cp_fail" 2>/dev/null || echo 0)" = 1 ]; then exit 1; fi
exec /bin/cp "$@"
EOF
cat > "$MB/docker" <<'EOF'
#!/usr/bin/env bash
S="$MOCK_STATE"
echo "$*" >> "$S/docker.log"
if [ "${1:-}" = "inspect" ]; then
  fmt=""; for a in "$@"; do case "$a" in *Running*) fmt=running;; *.Id*) fmt=id;; *StartedAt*) fmt=started;; esac; done
  case "$fmt" in
    running) cat "$S/running" ;;
    id)      cat "$S/id" ;;
    started) cat "$S/started" ;;
    *)       echo "" ;;
  esac
  exit 0
fi
if [ "${1:-}" = "compose" ]; then
  last="${@: -1}"
  case "$last" in
    -T)  cat "$S/active.conf"; exit 0 ;;
    -t)  c=$(( $(cat "$S/nt_count" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$S/nt_count"; exit "$(cat "$S/nt_rc")" ;;
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

# Construye repo git prod + remoto bare. C1 = SIN scripts (como ed3e0cc). El merge
# aprobado y el target agregan 7 archivos versionados (como el PR real), incluidos
# los scripts REALES del runbook para que el bootstrap pueda extraerlos del target.
setup_repo() {
  RROOT="$TMP/prod"; BARE="$TMP/origin.git"
  rm -rf "$RROOT" "$BARE"
  git init -q --bare -b main "$BARE" 2>/dev/null || git init -q --bare "$BARE"
  git -c init.defaultBranch=main init -q "$RROOT"
  ( cd "$RROOT"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
    mkdir -p infra/nginx
    cp "$OLDC" infra/nginx/nginx.conf; git add -A; git commit -qm c1        # SIN scripts
    C1=$(git rev-parse HEAD)
    # merge aprobado: nginx.conf corregido + los 6 archivos nuevos del PR (7 en total).
    cp "$GOODB" infra/nginx/nginx.conf
    mkdir -p scripts docs/runbooks apps/api/src/routes
    cp "$SCRIPT"  scripts/deploy-hls-auth-parent-uri.sh
    cp "$CHECKSH" scripts/check-hls-auth-nginx.sh
    cp "$BOOT"    scripts/deploy-hls-auth-bootstrap.sh
    printf '# runbook doc (inerte en el test)\n'      > docs/runbooks/hls-auth-parent-uri-deploy.md
    printf '#!/usr/bin/env bash\n# test inerte\n'     > scripts/deploy-hls-auth-parent-uri.test.sh
    printf '// hlsAuth route test (inerte)\n'         > apps/api/src/routes/hlsAuth.route.test.ts
    git add -A; git commit -qm merge-approved
    CMERGE=$(git rev-parse HEAD)
    # target: tweak menor a nginx.conf (SHA propio, descendiente del merge)
    echo "    # target tweak (comentario)" >> infra/nginx/nginx.conf; git add -A; git commit -qm target
    CTARGET=$(git rev-parse HEAD)
    git remote add origin "$BARE"; git push -q origin HEAD:main
    git reset -q --hard "$C1"               # vuelve al estado productivo viejo (sin scripts)
    cp "$GOODA" infra/nginx/nginx.conf      # hotfix local uncommitted (M)
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
    "$@" bash "$SCRIPT" ) > "$TMP/out" 2>&1
  echo $?
}

echo ""
echo "== B) HARNESS HERMÉTICO (main() con git real + mocks)"

# --- S1: éxito + HONESTIDAD (target multi-archivo, sólo reload de nginx) ---
setup_repo; S="$TMP/s1"; mkstate "$S"; rm -rf "$TMP/bkdir"
rc=$(run_deploy)
if [ "$rc" = 0 ] && grep -q '^GO:' "$TMP/out"; then ok "S1 éxito: rc=0 y GO"; else bad "S1 éxito: rc=$rc (ver out)"; cat "$TMP/out"; fi
[ "$(cd "$RROOT" && git rev-parse HEAD)" = "$CTARGET" ] && ok "S1: HEAD == target" || bad "S1: HEAD != target"
[ -z "$(cd "$RROOT" && git status --porcelain)" ] && ok "S1: árbol limpio (todos los archivos del target avanzaron)" || bad "S1: árbol sucio"
nfiles="$(cd "$RROOT" && git diff --name-only "$C1" "$CTARGET" | grep -c .)"
chg="$(cd "$RROOT" && git diff --name-only "$C1" "$CTARGET" | tr '\n' ' ')"
{ [ "$nfiles" -ge 5 ] && printf '%s' "$chg" | grep -q 'infra/nginx/nginx.conf'; } \
  && ok "S1: target multi-archivo ($nfiles archivos), incluye nginx.conf (como el PR real)" \
  || bad "S1: target no representa el ff real multi-archivo ($chg)"
missing=0
for f in scripts/deploy-hls-auth-parent-uri.sh scripts/check-hls-auth-nginx.sh scripts/deploy-hls-auth-bootstrap.sh docs/runbooks/hls-auth-parent-uri-deploy.md; do
  [ -f "$RROOT/$f" ] || { missing=1; bad "S1: falta $f tras el ff"; }
done
[ "$missing" = 0 ] && ok "S1: archivos inertes/scripts del target presentes en el checkout"
if grep -Eq '(^| )(build|up|restart|recreate|down)( |$)' "$S/docker.log"; then
  bad "S1: docker ejecutó un verbo de ciclo de vida (build/up/restart/recreate/down)"
else ok "S1: único cambio de runtime = reload de nginx (sin build/up/restart/recreate/down)"; fi
[ -f "$S/reloaded" ] && ok "S1: hubo reload de nginx" || bad "S1: no hubo reload"
grep -q ' -k' "$S/curl.log" && bad "S1: curl usó -k (TLS omitido)" || ok "S1: TLS no omitido (sin -k)"

# --- S2: host malo ⇒ aborta ANTES de mutar ---
setup_repo; S="$TMP/s2"; mkstate "$S"; printf "web\n" > "$S/hostname"; rm -rf "$TMP/bkdir"
rc=$(run_deploy)
[ "$rc" != 0 ] && ok "S2: aborta (rc=$rc)" || bad "S2: no abortó"
[ ! -f "$S/reloaded" ] && ok "S2: sin reload (no mutó nginx)" || bad "S2: hubo reload antes de compuertas"
[ "$(cd "$RROOT" && git rev-parse HEAD)" = "$C1" ] && ok "S2: HEAD sigue en c1 (sin ff)" || bad "S2: HEAD cambió"
grep -q 'sin mutación' "$TMP/out" && ok "S2: reporta sin mutación" || bad "S2: no reporta sin mutación"

# --- S3: race — origin/main avanza != target ⇒ aborta antes de mutar ---
setup_repo; S="$TMP/s3"; mkstate "$S"; rm -rf "$TMP/bkdir"
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
{ grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/out" && ! grep -q 'AUTOMATIC_ROLLBACK=FAILED' "$TMP/out"; } \
  && ok "S4: rollback PASS (sin FAILED)" || { bad "S4: no PASS limpio"; grep ROLLBACK "$TMP/out"; }

# --- S5a: fallos POST-mutación que fuerzan AUTOMATIC_ROLLBACK=FAILED (rc!=0 + FAILED + sin PASS) ---
for inj in "reload_rc=1" "nt_rc=1" "cp_fail=1"; do
  setup_repo; S="$TMP/s5"; mkstate "$S"; rm -rf "$TMP/bkdir"
  printf "1\n" > "$S/force_bad_first"       # forzar fallo forward para entrar al rollback
  case "$inj" in
    reload_rc=1) printf "1\n" > "$S/reload_rc";;
    nt_rc=1)     printf "1\n" > "$S/nt_rc";;
    cp_fail=1)   printf "1\n" > "$S/cp_fail";;
  esac
  rc=$(run_deploy)
  { [ "$rc" != 0 ] && grep -q 'AUTOMATIC_ROLLBACK=FAILED' "$TMP/out" && ! grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/out"; } \
    && ok "S5a[$inj]: rc!=0 + FAILED + sin PASS (estricto)" \
    || { bad "S5a[$inj]: no cumple estricto (rc=$rc)"; grep ROLLBACK "$TMP/out" || true; }
done

# --- S5b: API/HLS caídos en BASELINE ⇒ aborta ANTES de mutar (fail-closed; ni PASS ni mutación) ---
for inj in "api=500" "hls=403"; do
  setup_repo; S="$TMP/s5b"; mkstate "$S"; rm -rf "$TMP/bkdir"
  case "$inj" in api=500) printf "500\n" > "$S/api";; hls=403) printf "403\n" > "$S/hls";; esac
  rc=$(run_deploy)
  { [ "$rc" != 0 ] && grep -q 'baseline' "$TMP/out" && [ ! -f "$S/reloaded" ] \
    && ! grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/out" && grep -q 'sin mutación' "$TMP/out"; } \
    && ok "S5b[$inj]: baseline caído ⇒ aborta sin mutar (sin PASS)" \
    || { bad "S5b[$inj]: no abortó en baseline (rc=$rc)"; grep -iE 'baseline|mutaci|rollback' "$TMP/out" || true; }
done

# --- S6: no se puede crear el backup ⇒ aborta sin mutar ---
setup_repo; S="$TMP/s6"; mkstate "$S"
: > "$TMP/notadir"
rc=$( cd "$RROOT"; PATH="$MB:$PATH" MOCK_STATE="$S" DEPLOY_ROOT="$RROOT" NGINX_CTR=ngx NGINX_SVC=nginx \
  BACKUP_DIR="$TMP/notadir/sub" BACKUP_TIMER_UNIT=visioncore-backup.timer \
  API_HEALTH_URL="https://camaras.saa.com.py/api/health" SITE_BASE="https://camaras.saa.com.py" \
  EXPECT_HEAD="$C1" EXPECT_TARGET_SHA="$CTARGET" EXPECT_MERGE_SHA="$CMERGE" \
  HLS_PROBE_PATH="/hls/nvr_abc123_ch01_sub/index.m3u8" \
  bash "$SCRIPT" >"$TMP/out" 2>&1; echo $? )
[ "$rc" != 0 ] && [ ! -f "$S/reloaded" ] && ok "S6: backup no creable ⇒ aborta sin mutar" || bad "S6: no abortó limpio (rc=$rc)"

# --- S7: contenedor nginx no corriendo ⇒ aborta antes de mutar ---
setup_repo; S="$TMP/s7"; mkstate "$S"; printf 'false\n' > "$S/running"; rm -rf "$TMP/bkdir"
rc=$(run_deploy)
[ "$rc" != 0 ] && [ ! -f "$S/reloaded" ] && ok "S7: Running=false ⇒ aborta sin mutar" || bad "S7: no abortó por contenedor detenido (rc=$rc)"

echo ""
echo "== C) ROLLBACK SECUENCIAL (contadores; corte por fase; sin PASS falso)"
cnt() { cat "$S/$1" 2>/dev/null || echo "?"; }
setup_rb() {  # RB con archivo actual + backup válido (GOODB) y checksum
  RB="$TMP/rb"; rm -rf "$RB"; mkdir -p "$RB/infra/nginx" "$RB/bk"
  cp "$GOODB" "$RB/infra/nginx/nginx.conf"
  cp "$GOODB" "$RB/bk/backup.conf"; ( cd "$RB/bk" && sha256sum backup.conf > backup.conf.sha256 )
}
call_rb() {  # ejecuta do_rollback AISLADO con mocks; deja salida en $TMP/rbout, rc en RBRC
  ( cd "$RB"; trap - EXIT; set +e
    export MOCK_STATE="$S"; export PATH="$MB:$PATH"
    NGINX_SVC=nginx; BACKUP_TIMER_UNIT=visioncore-backup.timer
    API_HEALTH_URL="https://camaras.saa.com.py/api/health"
    SITE_BASE="https://camaras.saa.com.py"
    HLS_PROBE_PATH="/hls/nvr_abc123_ch01_sub/index.m3u8"
    BACKUP_FILE="$RB/bk/backup.conf"; BACKUP_SUMS="$RB/bk/backup.conf.sha256"
    do_rollback
  ) > "$TMP/rbout" 2>&1
  RBRC=$?
}
no_pass() { ! grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/rbout"; }
has_failed() { grep -q 'AUTOMATIC_ROLLBACK=FAILED' "$TMP/rbout"; }

# R1: checksum corrupto ⇒ FAILED fase1; cp=0, nt=0, reload=0
S="$TMP/rb1"; mkstate "$S"; setup_rb; echo tamper >> "$RB/bk/backup.conf"; call_rb
{ [ "$RBRC" != 0 ] && has_failed && no_pass && [ "$(cnt cp_count)" = 0 ] && [ "$(cnt nt_count)" = 0 ] && [ "$(cnt reload_count)" = 0 ]; } \
  && ok "R1 checksum corrupto: FAILED fase1 (cp=0 nt=0 reload=0)" || { bad "R1 (cp=$(cnt cp_count) nt=$(cnt nt_count) rl=$(cnt reload_count))"; cat "$TMP/rbout"; }

# R2: cp falla ⇒ FAILED fase2; nt=0, reload=0
S="$TMP/rb2"; mkstate "$S"; setup_rb; printf '1\n' > "$S/cp_fail"; call_rb
{ [ "$RBRC" != 0 ] && has_failed && no_pass && [ "$(cnt nt_count)" = 0 ] && [ "$(cnt reload_count)" = 0 ]; } \
  && ok "R2 cp falla: FAILED fase2 (nt=0 reload=0)" || { bad "R2 (cp=$(cnt cp_count) nt=$(cnt nt_count) rl=$(cnt reload_count))"; cat "$TMP/rbout"; }

# R3: nginx -t falla ⇒ FAILED fase4; reload=0
S="$TMP/rb3"; mkstate "$S"; setup_rb; printf '1\n' > "$S/nt_rc"; call_rb
{ [ "$RBRC" != 0 ] && has_failed && no_pass && [ "$(cnt reload_count)" = 0 ]; } \
  && ok "R3 nginx -t falla: FAILED fase4 (reload=0)" || { bad "R3 (nt=$(cnt nt_count) rl=$(cnt reload_count))"; cat "$TMP/rbout"; }

# R4: reload falla ⇒ FAILED fase5
S="$TMP/rb4"; mkstate "$S"; setup_rb; printf '1\n' > "$S/reload_rc"; call_rb
{ [ "$RBRC" != 0 ] && has_failed && no_pass; } && ok "R4 reload falla: FAILED fase5 (reload=$(cnt reload_count))" || { bad "R4"; cat "$TMP/rbout"; }

# R5: verificación posterior (fase6) — api/hls/timer ⇒ FAILED
for inj in "api=500" "hls=403" "timer_rc=1"; do
  S="$TMP/rb5"; mkstate "$S"; setup_rb
  case "$inj" in api=500) printf '500\n'>"$S/api";; hls=403) printf '403\n'>"$S/hls";; timer_rc=1) printf '1\n'>"$S/timer_rc";; esac
  call_rb
  { [ "$RBRC" != 0 ] && has_failed && no_pass; } && ok "R5[$inj]: FAILED fase6 (sin PASS)" || { bad "R5[$inj]"; cat "$TMP/rbout"; }
done

# R6: config activa rota tras reload ⇒ FAILED fase6 (wiring)
S="$TMP/rb6"; mkstate "$S"; setup_rb; printf '1\n' > "$S/force_bad_first"; call_rb
{ [ "$RBRC" != 0 ] && has_failed && no_pass; } && ok "R6 config activa rota: FAILED fase6" || { bad "R6"; cat "$TMP/rbout"; }

# R7: rollback sano ⇒ PASS; cp=1, nt=1, reload=1
S="$TMP/rb7"; mkstate "$S"; setup_rb; call_rb
{ [ "$RBRC" = 0 ] && grep -q 'AUTOMATIC_ROLLBACK=PASS' "$TMP/rbout" && ! has_failed \
  && [ "$(cnt cp_count)" = 1 ] && [ "$(cnt nt_count)" = 1 ] && [ "$(cnt reload_count)" = 1 ]; } \
  && ok "R7 sano: PASS (cp=1 nt=1 reload=1)" || { bad "R7 (cp=$(cnt cp_count) nt=$(cnt nt_count) rl=$(cnt reload_count))"; cat "$TMP/rbout"; }

echo ""
echo "== D) BOOTSTRAP desde checkout SIN los scripts (extracción del target Git inmóvil)"
run_bootstrap() {  # $1 = PRIVATE_BASE
  ( cd "$RROOT"
    PATH="$MB:$PATH" MOCK_STATE="$S" ALLOW_TEST_OVERRIDES=1 PRIVATE_BASE="$1" \
    DEPLOY_ROOT="$RROOT" NGINX_CTR=ngx NGINX_SVC=nginx \
    BACKUP_DIR="$TMP/bkdir" BACKUP_TIMER_UNIT=visioncore-backup.timer \
    API_HEALTH_URL="https://camaras.saa.com.py/api/health" \
    SITE_BASE="https://camaras.saa.com.py" \
    EXPECT_HEAD="$C1" EXPECT_TARGET_SHA="$CTARGET" EXPECT_MERGE_SHA="$CMERGE" \
    HLS_PROBE_PATH="/hls/nvr_abc123_ch01_sub/index.m3u8" \
    bash "$BOOT" ) > "$TMP/bout" 2>&1
  echo $?
}

# --- D1: éxito end-to-end (C1 no tiene scripts; se extraen del target y se ejecutan) ---
setup_repo; S="$TMP/d1"; mkstate "$S"; rm -rf "$TMP/bkdir" "$TMP/privD1"; mkdir -p "$TMP/privD1"
[ ! -f "$RROOT/scripts/deploy-hls-auth-parent-uri.sh" ] && [ ! -f "$RROOT/scripts/check-hls-auth-nginx.sh" ] \
  && ok "D1 precondición: el checkout C1 NO contiene los scripts" || bad "D1: el checkout ya tenía los scripts"
rc=$(run_bootstrap "$TMP/privD1")
if [ "$rc" = 0 ] && grep -q 'BOOTSTRAP_OK' "$TMP/bout" && grep -q '^GO:' "$TMP/bout"; then
  ok "D1: bootstrap extrae y el deploy delegado llega a GO (rc=0)"; else bad "D1: rc=$rc"; cat "$TMP/bout"; fi
priv="$(find "$TMP/privD1" -maxdepth 1 -type d -name 'hls-deploy.*' | head -1)"
{ [ -n "$priv" ] && [ -f "$priv/deploy-hls-auth-parent-uri.sh" ] && [ -f "$priv/check-hls-auth-nginx.sh" ]; } \
  && ok "D1: dir privado con AMBOS scripts extraídos (guard adyacente)" || bad "D1: faltan scripts en el dir privado"
{ [ -n "$priv" ] && [ -f "$priv/EVIDENCE.txt" ] && grep -q 'deploy-hls-auth-parent-uri.sh' "$priv/EVIDENCE.txt" \
  && grep -qE '^[0-9a-f]{64}  ' "$priv/EVIDENCE.txt"; } \
  && ok "D1: evidencia con sha256 de ambos scripts" || bad "D1: evidencia/sha256 ausente"
[ -n "$priv" ] && [ "$(stat -c '%a' "$priv")" = "700" ] && ok "D1: dir privado modo 700" || bad "D1: dir privado no es 700"
[ "$(cd "$RROOT" && git rev-parse HEAD)" = "$CTARGET" ] && ok "D1: el deploy avanzó HEAD al target" || bad "D1: HEAD != target"
grep -q ' -k' "$S/curl.log" && bad "D1: curl usó -k" || ok "D1: TLS estricto en el flujo bootstrap→deploy"

# --- D2: target avanzado/incorrecto ⇒ aborta ANTES de extraer/ejecutar ---
setup_repo; S="$TMP/d2"; mkstate "$S"; rm -rf "$TMP/bkdir" "$TMP/privD2"; mkdir -p "$TMP/privD2"
rm -rf "$TMP/adv2"
( git clone -q "$BARE" "$TMP/adv2"; cd "$TMP/adv2"; git config user.email t@t; git config user.name t
  git checkout -q main; echo "    # commit extra" >> infra/nginx/nginx.conf; git add -A; git commit -qm extra
  git push -q origin main ) 2>/dev/null
rc=$(run_bootstrap "$TMP/privD2")
[ "$rc" != 0 ] && grep -q 'NO_GO' "$TMP/bout" && grep -q 'target no inmovilizado' "$TMP/bout" \
  && ok "D2: origin avanzó ⇒ aborta con NO_GO (target no inmovilizado)" || { bad "D2: no abortó como se espera (rc=$rc)"; cat "$TMP/bout"; }
[ -z "$(find "$TMP/privD2" -maxdepth 1 -type d -name 'hls-deploy.*')" ] \
  && ok "D2: NO se creó dir privado (aborta antes de extraer)" || bad "D2: creó dir privado pese al abort"
[ ! -f "$S/reloaded" ] && ok "D2: sin reload (no ejecutó el deploy)" || bad "D2: hubo reload pese al target incorrecto"
grep -q 'BOOTSTRAP_OK' "$TMP/bout" && bad "D2: imprimió BOOTSTRAP_OK pese al abort" || ok "D2: no imprimió BOOTSTRAP_OK"

echo ""
echo "== Resultado: ${pass} ok, ${fail} fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ Runbook+bootstrap: compuertas, target inmóvil, rollback por fases (sin PASS falso), honestidad multi-archivo, extracción desde el target y TLS estricto verificados."
