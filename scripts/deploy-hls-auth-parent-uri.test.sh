#!/usr/bin/env bash
# scripts/deploy-hls-auth-parent-uri.test.sh
# Pruebas NEGATIVAS (y positivas) de las compuertas del runbook de deploy HLS.
# Demuestra que cada compuerta crítica DETIENE la ejecución (exit != 0). No toca
# producción: sólo ejercita la lógica de gates con fixtures y un repo git temporal.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/deploy-hls-auth-parent-uri.sh"

# Sourcear la librería de gates SIN ejecutar main().
RUNBOOK_LIB=1 source "$SCRIPT"
trap - EXIT   # neutralizar el trap de rollback del script en el shell de test

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
# Corre un gate en subshell; devuelve su código (fail()→exit1).
run() { ( "$@" ) >/dev/null 2>&1; }
expect_fail() { local d="$1"; shift; if run "$@"; then bad "$d — NO abortó (debía)"; else ok "$d — abortó"; fi; }
expect_pass() { local d="$1"; shift; if run "$@"; then ok "$d — pasó"; else bad "$d — abortó indebidamente"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── Fixtures de config ────────────────────────────────────────────────────────
GOOD="$TMP/good.conf"; BROKEN="$TMP/broken.conf"; MISSING="$TMP/missing.conf"
{ echo "location /hls/ {"; echo "    $D_SET"; echo "    $D_AUTH"; echo "}";
  echo "location = /internal/hls-auth {"; echo "    $D_HDR"; echo "}"; } > "$GOOD"
{ echo "location = /internal/hls-auth {"; echo "    $D_BROKEN"; echo "}"; } > "$BROKEN"
{ echo "location /hls/ {"; echo "    $D_AUTH"; echo "}"; } > "$MISSING"   # sin set ni header

echo "== gate_probe_path"
expect_pass "probe path real"            gate_probe_path "/hls/nvr_abc123_ch09_sub/index.m3u8"
expect_fail "probe path placeholder <>"  gate_probe_path "/hls/nvr_<algún>_ch01_sub/index.m3u8"
expect_fail "probe path forma inválida"  gate_probe_path "/hls/no-es-stream/index.m3u8"
expect_fail "probe path vacío"           gate_probe_path ""

echo "== gate_host"
EXPECT_HOST_RE='^camaras' expect_pass "host camaras01"        gate_host "camaras01"
EXPECT_HOST_RE='^camaras' expect_fail "host ajeno"            gate_host "web-prod-7"

echo "== gate_branch"
expect_pass "rama main"                  gate_branch "main"
expect_fail "rama feature"               gate_branch "fix/algo"

echo "== gate_head"
expect_pass "HEAD coincide"              gate_head "abc" "abc"
expect_fail "HEAD no coincide"           gate_head "abc" "def"

echo "== gate_single_local_change"
expect_pass "un solo cambio y es CONF"   gate_single_local_change ' M infra/nginx/nginx.conf'
expect_fail "más de un cambio"           gate_single_local_change $' M infra/nginx/nginx.conf\n M docker-compose.yml'
expect_fail "único cambio NO es CONF"    gate_single_local_change ' M apps/api/src/x.ts'
expect_fail "sin cambios"                gate_single_local_change ''

echo "== gate_conf_has_directives / gate_conf_no_broken"
expect_pass "conf buena: 3 directivas"   gate_conf_has_directives "$GOOD"
expect_fail "conf sin directivas"        gate_conf_has_directives "$MISSING"
expect_pass "conf buena: sin rota"       gate_conf_no_broken "$GOOD"
expect_fail "conf con variante rota"     gate_conf_no_broken "$BROKEN"

echo "== gate_semantic_equal"
cp "$GOOD" "$TMP/origin_ok.conf"
expect_pass "cableado idéntico"          gate_semantic_equal "$GOOD" "$TMP/origin_ok.conf"
expect_fail "cableado difiere (rota)"    gate_semantic_equal "$GOOD" "$BROKEN"

echo "== gate_backup_ok"
BK="$TMP/nginx.conf.operativo.T"; cp "$GOOD" "$BK"
( cd "$TMP" && sha256sum "$(basename "$BK")" > "${BK}.sha256" )
expect_pass "backup íntegro + directivas" gate_backup_ok "$BK" "${BK}.sha256"
echo "corrupto" >> "$BK"     # rompe el checksum
expect_fail "backup con checksum roto"    gate_backup_ok "$BK" "${BK}.sha256"
cp "$BROKEN" "$TMP/bk2"; ( cd "$TMP" && sha256sum bk2 > bk2.sha256 )
expect_fail "backup sin las 3 directivas" gate_backup_ok "$TMP/bk2" "$TMP/bk2.sha256"

echo "== gate_origin_has_merge (repo git temporal)"
GR="$TMP/repo"; mkdir -p "$GR"
(
  cd "$GR"; git init -q; git config user.email t@t; git config user.name t
  echo a > f; git add f; git commit -qm A          # commit A (merge aprobado)
  MERGE_SHA="$(git rev-parse HEAD)"
  echo b >> f; git commit -qam B                    # B contiene A (ancestro)
  ORIGIN_OK="$(git rev-parse HEAD)"
  git checkout -q --orphan otra; git rm -qf f 2>/dev/null || true
  echo z > g; git add g; git commit -qm Z           # Z NO contiene A
  ORIGIN_BAD="$(git rev-parse HEAD)"
  printf '%s %s %s\n' "$MERGE_SHA" "$ORIGIN_OK" "$ORIGIN_BAD" > "$TMP/shas"
)
read -r MERGE_SHA ORIGIN_OK ORIGIN_BAD < "$TMP/shas"
# gate usa `git` en el cwd actual → correrlo dentro del repo temporal.
expect_pass "origin contiene el merge"   bash -c "cd '$GR' && RUNBOOK_LIB=1 source '$SCRIPT' && trap - EXIT && gate_origin_has_merge '$ORIGIN_OK' '$MERGE_SHA'"
expect_fail "origin NO contiene el merge" bash -c "cd '$GR' && RUNBOOK_LIB=1 source '$SCRIPT' && trap - EXIT && gate_origin_has_merge '$ORIGIN_BAD' '$MERGE_SHA'"

echo ""
echo "== Resultado: ${pass} ok, ${fail} fail"
[ "$fail" -eq 0 ] || exit 1
echo "✅ Todas las compuertas críticas detienen la ejecución como se espera."
