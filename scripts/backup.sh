#!/usr/bin/env bash
# scripts/backup.sh — Backup comprobado de PostgreSQL para VisionCore.
#
# Hace un pg_dump en formato custom (-Fc), calcula un checksum SHA-256 del
# artefacto, opcionalmente lo cifra (gpg --symmetric por passphrase de entorno),
# verifica que el dump sea legible (pg_restore --list) y aplica retención por
# antigüedad. NO borra ni toca la base: sólo lee. Pensado para correr por cron
# y como paso previo a cada migración/deploy (la red de seguridad del rollback).
#
# Uso:
#   scripts/backup.sh                # backup con la config por env / defaults
#   BACKUP_ENCRYPT=1 BACKUP_PASSPHRASE=... scripts/backup.sh
#
# Configuración por entorno (sin secretos hardcodeados):
#   BACKUP_DIR         Directorio destino (default: ./backups)
#   PGHOST             Host de PostgreSQL (default: 127.0.0.1)
#   PGPORT             Puerto (default: 5432)
#   PGUSER             Usuario (default: visioncore)
#   PGDATABASE         Base (default: visioncore_db)
#   PGPASSWORD         Password (se toma del entorno; nunca se versiona)
#   RETENTION_DAYS     Retención en días (default: 14; 0 = no borrar nada)
#   BACKUP_ENCRYPT     "1" para cifrar el artefacto con gpg (default: 0)
#   BACKUP_PASSPHRASE  Passphrase para el cifrado simétrico (obligatoria si ENCRYPT=1)
#   DB_EXEC            Prefijo opcional para ejecutar los clientes de PG dentro de
#                      un contenedor, p.ej. DB_EXEC="docker compose exec -T postgres".
#                      Vacío = usar pg_dump/pg_restore del host.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-visioncore}"
PGDATABASE="${PGDATABASE:-visioncore_db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_ENCRYPT="${BACKUP_ENCRYPT:-0}"
DB_EXEC="${DB_EXEC:-}"
export PGHOST PGPORT PGUSER PGDATABASE

ts="$(date +%Y%m%d_%H%M%S)"
base="${BACKUP_DIR}/visioncore_db_${ts}.dump"
mkdir -p "$BACKUP_DIR"

log() { echo "[backup] $*"; }
die() { echo "[backup] ERROR: $*" >&2; exit 1; }

# sha256 portable (Linux: sha256sum, macOS: shasum -a 256)
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ── 1. Dump en formato custom (-Fc) ─────────────────────────────
log "pg_dump -Fc ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} → ${base}"
# El error NO se silencia: si el dump falla, `set -e` aborta y no queda un
# artefacto vacío/parcial que aparente ser un backup válido.
if ! ${DB_EXEC} pg_dump -Fc -U "$PGUSER" -d "$PGDATABASE" > "$base"; then
  rm -f "$base"
  die "pg_dump falló — no se generó backup. Revisá PostgreSQL antes de reintentar."
fi
[ -s "$base" ] || { rm -f "$base"; die "el dump quedó vacío — se aborta."; }

# ── 2. Verificación del dump (pg_restore --list) ────────────────
# Prueba que el artefacto es un archivo custom legible (no confía sólo en el exit
# de pg_dump). Con DB_EXEC el archivo vive en el host, así que la verificación se
# hace con el pg_restore del host si existe; si no, se hace dentro del contenedor.
log "verificando dump con pg_restore --list"
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$base" >/dev/null || { rm -f "$base"; die "pg_restore --list falló: dump ilegible."; }
elif [ -n "$DB_EXEC" ]; then
  ${DB_EXEC} pg_restore --list < "$base" >/dev/null || { rm -f "$base"; die "pg_restore --list falló: dump ilegible."; }
else
  log "WARN: pg_restore no disponible en el host — se omite verificación de legibilidad."
fi

# ── 3. Cifrado opcional (gpg simétrico por passphrase de entorno) ─
artifact="$base"
if [ "$BACKUP_ENCRYPT" = "1" ]; then
  [ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_ENCRYPT=1 pero BACKUP_PASSPHRASE está vacía."
  command -v gpg >/dev/null 2>&1 || die "BACKUP_ENCRYPT=1 pero gpg no está instalado."
  enc="${base}.gpg"
  log "cifrando artefacto (gpg --symmetric AES-256) → ${enc}"
  # --batch + --passphrase-fd 0 evita prompts y no expone la passphrase en argv.
  printf '%s' "$BACKUP_PASSPHRASE" \
    | gpg --batch --yes --symmetric --cipher-algo AES256 \
          --passphrase-fd 0 --pinentry-mode loopback \
          -o "$enc" "$base" \
    || { rm -f "$enc"; die "gpg falló al cifrar."; }
  rm -f "$base"          # no dejar el dump en claro
  artifact="$enc"
fi

# ── 4. Checksum SHA-256 del artefacto final ─────────────────────
sum="$(sha256_of "$artifact")"
echo "${sum}  $(basename "$artifact")" > "${artifact}.sha256"
log "sha256 = ${sum}"
log "checksum guardado en ${artifact}.sha256"

# ── 5. Retención (borrar backups > RETENTION_DAYS) ──────────────
if [ "$RETENTION_DAYS" -gt 0 ]; then
  log "aplicando retención: borrando backups con más de ${RETENTION_DAYS} días"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'visioncore_db_*.dump' -o -name 'visioncore_db_*.dump.gpg' -o -name 'visioncore_db_*.sha256' \) \
    -mtime "+${RETENTION_DAYS}" -print -delete || true
fi

log "OK: backup verificado en ${artifact}"
echo "$artifact"
