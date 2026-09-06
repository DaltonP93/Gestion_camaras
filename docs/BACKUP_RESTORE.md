# Backup y restore de PostgreSQL — VisionCore

> Alcance: procedimiento comprobado de respaldo/restauración de la base
> `visioncore_db` (metadatos de cámaras, NVR, usuarios, roles y **evidencia de
> grabaciones**). No autoriza acciones sobre producción: leer
> `docs/AI_HANDOFF.md` (invariante 1: nunca perder evidencia sin respaldo).

La base es un único contenedor con un único volumen (`postgres_data`) — punto
único de fallo. Este procedimiento es la red de seguridad para migraciones,
deploys y recuperación ante desastre.

## Scripts

- `scripts/backup.sh` — `pg_dump -Fc` + checksum SHA-256 + cifrado opcional +
  verificación (`pg_restore --list`) + retención.
- `scripts/restore.sh` — verifica checksum, descifra si aplica, valida el dump y
  restaura con `pg_restore --clean --if-exists` (idempotente).

Ambos leen la configuración del entorno; **no hay secretos hardcodeados**.

### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `BACKUP_DIR` | `backups` | Directorio destino de los artefactos. |
| `PGHOST` / `PGPORT` | `127.0.0.1` / `5432` | Host y puerto de PostgreSQL. |
| `PGUSER` / `PGDATABASE` | `visioncore` / `visioncore_db` | Usuario y base. |
| `PGPASSWORD` | — | Password (del entorno; nunca versionar). |
| `RETENTION_DAYS` | `14` | Borra backups con más de N días (`0` = no borrar). |
| `BACKUP_ENCRYPT` | `0` | `1` cifra el artefacto con `gpg --symmetric` (AES-256). |
| `BACKUP_PASSPHRASE` | — | Passphrase del cifrado (obligatoria si `ENCRYPT=1`). |
| `DB_EXEC` | — | Prefijo para correr los clientes de PG dentro de un contenedor, p.ej. `DB_EXEC="docker compose exec -T postgres"`. Vacío = binarios del host. |
| `RESTORE_FORCE` | `0` | `1` omite la confirmación interactiva de `restore.sh`. |

## Uso

### Backup

```bash
# Contra el stack compose (postgres en el contenedor):
DB_EXEC="docker compose exec -T postgres" PGPASSWORD="$POSTGRES_PASSWORD" \
  bash scripts/backup.sh

# Backup cifrado:
BACKUP_ENCRYPT=1 BACKUP_PASSPHRASE="$BK_PASS" \
DB_EXEC="docker compose exec -T postgres" PGPASSWORD="$POSTGRES_PASSWORD" \
  bash scripts/backup.sh
```

Genera `backups/visioncore_db_<ts>.dump` (o `.dump.gpg`) y su `.sha256`. El
script imprime la ruta del artefacto en la última línea (útil para cron/scripts).

> **Nota de granularidad**: el nombre usa timestamp a segundos. Dos backups en el
> **mismo segundo** colisionan de nombre; para cron horario/diario no ocurre.

### Restore

```bash
# Restaura (pide confirmación 'RESTORE' salvo --force):
BACKUP_PASSPHRASE="$BK_PASS" \
DB_EXEC="docker compose exec -T postgres" PGPASSWORD="$POSTGRES_PASSWORD" \
  bash scripts/restore.sh backups/visioncore_db_<ts>.dump.gpg
```

`restore.sh` **aborta** si el checksum no coincide, si el `.gpg` no se puede
descifrar o si `pg_restore` falla (`--exit-on-error`).

### Cron sugerido (offsite recomendado aparte)

```cron
# Backup diario 03:15, cifrado, retención 14 días.
15 3 * * * cd /opt/visioncore && BACKUP_ENCRYPT=1 BACKUP_PASSPHRASE="$(cat /root/.bk_pass)" \
  DB_EXEC="docker compose exec -T postgres" PGPASSWORD="$POSTGRES_PASSWORD" \
  bash scripts/backup.sh >> /var/log/visioncore-backup.log 2>&1
```

Copiar los artefactos a almacenamiento **fuera del host** (S3/rsync) es
responsabilidad de un paso adicional: un backup en el mismo disco no protege ante
fallo de disco.

## Simulacro comprobado (drill)

Ejecutado el 2026-09-06 contra un **PostgreSQL 16.4 efímero en Docker**
(`postgres:16.4-alpine`, base `visioncore_db`, usuario `visioncore`), replicable:

```bash
docker run --rm -d --name vc_backup_test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=visioncore_db -e POSTGRES_USER=visioncore \
  -p 55432:5432 postgres:16.4-alpine

export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=visioncore \
       PGDATABASE=visioncore_db PGPASSWORD=test
# 1) tabla + 3 filas → 2) backup plano y cifrado → 3) DROP TABLE →
# 4) restore desde el .gpg → 5) verificar 3 filas idénticas
```

Resultado real:

1. Backup plano y **cifrado** (AES-256) generados, cada uno con su `.sha256`.
2. `pg_restore --list` valida ambos dumps.
3. Tras `DROP TABLE evidencia` y `restore.sh <artefacto>.gpg --force`, las **3
   filas volvieron idénticas**.
4. Un artefacto con **checksum alterado** hace **abortar** el restore (exit ≠0).
5. Un **segundo** restore sobre la tabla ya existente es idempotente
   (`--clean --if-exists`), sin filas duplicadas.

Contenedor efímero **apagado y removido** al terminar (`--rm`).

## RPO / RTO propuestos

| Métrica | Propuesta | Justificación |
|---|---|---|
| **RPO** (pérdida máx. de datos) | **24 h** con backup diario; **≤1 h** si se pasa a backup horario o se activa WAL archiving / réplica. | El dump es puntual; entre dos dumps se pierde lo escrito. Para evidencia crítica se recomienda WAL archiving (PITR) como mejora futura. |
| **RTO** (tiempo de recuperación) | **≤30 min** para la base (descifrar + `pg_restore`); el dump de este esquema restaura en segundos a pocos minutos. El RTO total del servicio suma el redeploy del stack. | Restore probado en segundos sobre dataset chico; escala con el tamaño real de la base. |

Limitaciones conocidas: (a) sin offsite/WAL archiving no hay PITR — sólo puntos
diarios; (b) las migraciones son sólo-hacia-adelante (no hay `down`), así que un
rollback de esquema requiere restaurar un backup previo a la migración; correr
`scripts/backup.sh` **antes** de cada `migrate deploy` es la mitigación.
