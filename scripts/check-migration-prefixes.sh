#!/usr/bin/env bash
# scripts/check-migration-prefixes.sh
# Guard de CI: falla si se agrega un NUEVO prefijo numérico de migración duplicado.
#
# Prisma aplica las migraciones en orden lexicográfico por nombre de carpeta. Dos
# carpetas con el mismo prefijo (p.ej. 0009_a y 0009_b) son ambiguas y frágiles.
# Renombrar una migración ya aplicada rompería la tabla _prisma_migrations, así
# que NO se renombran las históricas: se toleran vía allowlist explícita y se
# impide que aparezca cualquier prefijo duplicado nuevo (o una tercera colisión
# sobre un prefijo histórico).
#
# Uso: scripts/check-migration-prefixes.sh [ruta_migraciones]
# Sale ≠0 si detecta un duplicado no permitido.
set -euo pipefail

MIGRATIONS_DIR="${1:-prisma/migrations}"

# ── Allowlist de duplicados históricos (prefijo → cantidad permitida) ──────────
# Documentado en docs/BACKUP_RESTORE.md / AUDIT_DEVOPS.md: tocan tablas distintas
# y el orden lexicográfico por nombre completo es determinista. NO renombrar (romp-
# ería _prisma_migrations). Cualquier ocurrencia por encima de esta cuenta = fallo.
declare -A ALLOW=(
  ["0009"]=2   # 0009_appearance_logo_fields + 0009_nvr_recording_provider_channel_config_backup
  ["0031"]=2   # 0031_appearance_token_engine_v2 + 0031_recordings_audio_mode
)

[ -d "$MIGRATIONS_DIR" ] || { echo "ERROR: no existe $MIGRATIONS_DIR" >&2; exit 1; }

# Contar ocurrencias por prefijo (prefijo = texto antes del primer '_').
declare -A COUNT=()
for path in "$MIGRATIONS_DIR"/*/; do
  [ -d "$path" ] || continue
  name="$(basename "$path")"
  prefix="${name%%_*}"
  COUNT["$prefix"]=$(( ${COUNT["$prefix"]:-0} + 1 ))
done

fail=0
for prefix in "${!COUNT[@]}"; do
  n=${COUNT[$prefix]}
  allowed=${ALLOW[$prefix]:-1}
  if [ "$n" -gt "$allowed" ]; then
    fail=1
    echo "❌ Prefijo de migración duplicado no permitido: '${prefix}' aparece ${n} veces (permitido ${allowed})." >&2
    for path in "$MIGRATIONS_DIR/${prefix}_"*/; do
      [ -d "$path" ] && echo "     - $(basename "$path")" >&2
    done
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Usá el siguiente número de prefijo libre. NO renombres migraciones ya aplicadas." >&2
  echo "Duplicados históricos tolerados (allowlist): ${!ALLOW[*]}" >&2
  exit 1
fi

echo "✅ Prefijos de migración OK (allowlist histórica: ${!ALLOW[*]})"
