#!/usr/bin/env bash
# scripts/restore.sh — Restore comprobado de un backup de PostgreSQL de VisionCore.
#
# Verifica el checksum SHA-256 (si hay .sha256 junto al artefacto), descifra si el
# artefacto es .gpg (passphrase por entorno), valida el dump (pg_restore --list) y
# lo restaura con pg_restore. OPERACIÓN DESTRUCTIVA sobre la base destino: por eso
# exige confirmación explícita salvo que se pase --force / RESTORE_FORCE=1.
#
# Uso:
#   scripts/restore.sh <artefacto.dump[.gpg]> [--force]
#
# Configuración por entorno (mismos defaults que backup.sh):
#   PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
#   BACKUP_PASSPHRASE  Passphrase si el artefacto está cifrado (.gpg)
#   DB_EXEC            Prefijo para correr pg_restore dentro de un contenedor
#   RESTORE_FORCE=1    Omitir la confirmación interactiva
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-visioncore}"
PGDATABASE="${PGDATABASE:-visioncore_db}"
DB_EXEC="${DB_EXEC:-}"
export PGHOST PGPORT PGUSER PGDATABASE

FORCE="${RESTORE_FORCE:-0}"
ARTIFACT=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) ARTIFACT="$arg" ;;
  esac
done

log() { echo "[restore] $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

[ -n "$ARTIFACT" ] || die "uso: restore.sh <artefacto.dump[.gpg]> [--force]"
[ -f "$ARTIFACT" ] || die "no existe el artefacto: $ARTIFACT"

# ── 1. Verificación de checksum (si existe el .sha256) ──────────
if [ -f "${ARTIFACT}.sha256" ]; then
  want="$(awk '{print $1}' "${ARTIFACT}.sha256")"
  have="$(sha256_of "$ARTIFACT")"
  [ "$want" = "$have" ] || die "checksum NO coincide (esperado ${want}, obtenido ${have}). Backup corrupto."
  log "checksum verificado (${have})"
else
  log "WARN: no hay ${ARTIFACT}.sha256 — se omite verificación de checksum."
fi

# ── 2. Descifrado si es .gpg ────────────────────────────────────
DUMP="$ARTIFACT"
TMP_DUMP=""
cleanup() { [ -n "$TMP_DUMP" ] && rm -f "$TMP_DUMP" || true; }
trap cleanup EXIT
case "$ARTIFACT" in
  *.gpg)
    [ -n "${BACKUP_PASSPHRASE:-}" ] || die "artefacto cifrado (.gpg) pero BACKUP_PASSPHRASE está vacía."
    command -v gpg >/dev/null 2>&1 || die "artefacto .gpg pero gpg no está instalado."
    TMP_DUMP="$(mktemp)"
    log "descifrando artefacto → ${TMP_DUMP}"
    printf '%s' "$BACKUP_PASSPHRASE" \
      | gpg --batch --yes --decrypt --passphrase-fd 0 --pinentry-mode loopback \
            -o "$TMP_DUMP" "$ARTIFACT" \
      || die "gpg falló al descifrar (passphrase incorrecta?)."
    DUMP="$TMP_DUMP"
    ;;
esac

# ── 3. Verificar que el dump es legible ─────────────────────────
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$DUMP" >/dev/null || die "pg_restore --list falló: dump ilegible."
  log "dump legible (pg_restore --list OK)"
fi

# ── 4. Confirmación (operación destructiva) ─────────────────────
if [ "$FORCE" != "1" ]; then
  echo "[restore] ATENCIÓN: se va a RESTAURAR sobre ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
  echo "[restore] Esto ejecuta pg_restore --clean --if-exists (sobrescribe objetos)."
  read -r -p "[restore] Escribí 'RESTORE' para continuar: " ans
  [ "$ans" = "RESTORE" ] || die "cancelado por el usuario."
fi

# ── 5. Restore ──────────────────────────────────────────────────
# --clean --if-exists: recrea objetos existentes sin fallar si no existían.
# --no-owner / --no-privileges: portable entre hosts/roles.
# --exit-on-error: NO tragar fallos parciales de restore.
log "restaurando con pg_restore…"
if ! ${DB_EXEC} pg_restore --clean --if-exists --no-owner --no-privileges \
        --exit-on-error -U "$PGUSER" -d "$PGDATABASE" < "$DUMP"; then
  die "pg_restore falló — la base puede haber quedado a medias. Revisá manualmente."
fi
log "OK: restore completado en ${PGDATABASE}"
