# Backup y restauración — VisionCore (estado real)

> Actualizado: 2026-09-06. Base: `main` = `0f9d1f5`. Fuente: AGENTE 2 (DevOps) verificado contra código.
> **Honestidad radical:** NO hay backup programado ni copia offsite. Este documento describe lo que existe
> hoy, el procedimiento manual, y qué falta (marcado como pendiente/decisión). Toca la evidencia de
> grabaciones (invariante de negocio #1): tratar con máxima cautela.

---

## 1. Estado real

| Aspecto | Estado | Evidencia |
|---|---|---|
| Backup programado (cron) | NOT_PRESENT | No hay job en `apps/api/src/jobs/`; sin cron de backup |
| Backup pre-deploy (manual) | PRESENTE | `scripts/deploy.sh:58-67` — `pg_dump -U visioncore visioncore_db` a `backups/*.sql`; **aborta el deploy si el dump falla** |
| Copia offsite | NOT_PRESENT | `docker-compose.yml` no monta `backups/` como volumen externo; viven en el filesystem del host (mismo SPOF) |
| Retención | NOT_PRESENT | Sin política de retención/rotación |
| WAL / réplica / captura continua | NOT_PRESENT | Postgres es contenedor + volumen único (SPOF) |
| Restauración | PRESENTE (manual, nunca ejercitada aquí) | `psql ... < backup.sql` (`DEPLOY.md:124-126`) |
| Prueba de restauración | NOT_TESTED | Nunca ejercitada en CI/local en este entorno |
| Backup de grabaciones (media) | Fuera del dump SQL | El dump cubre solo Postgres; la evidencia de video no está en este backup |

> ⚠ El `deploy.sh` de la **raíz** (distinto de `scripts/deploy.sh`) NO hace backup. Usar siempre
> `scripts/deploy.sh` (ver `docs/DEPLOYMENT.md §3`).

## 2. RPO / RTO actuales

- **RPO (Recovery Point Objective): INDEFINIDO.** El único backup ocurre al desplegar; entre despliegues
  (días/semanas) no hay captura. La pérdida potencial = tiempo desde el último deploy.
- **RTO (Recovery Time Objective): NO MEDIDO.** Restauración manual (rebuild + `up` + restore psql +
  re-seed si aplica), sin runbook cronometrado.

## 3. Procedimiento manual documentado

### Backup manual (bajo demanda)
```bash
docker compose exec -T postgres pg_dump -U visioncore visioncore_db \
  > backups/db_backup_$(date +%Y%m%d_%H%M%S).sql
```
(Es lo que `scripts/deploy.sh` hace automáticamente antes de cada deploy.)

### Restauración
```bash
# 1) detener api para evitar escrituras concurrentes (según necesidad)
docker compose stop api
# 2) restaurar el dump elegido
docker compose exec -T postgres psql -U visioncore visioncore_db \
  < backups/db_backup_YYYYMMDD_HHMMSS.sql
# 3) reanudar
docker compose start api
```

> Schema: migraciones **solo-hacia-adelante** (sin `down`); un rollback de código NO revierte la DB.
> Si se restaura un dump más viejo que las migraciones aplicadas, validar consistencia antes de operar.

## 4. Qué falta (pendiente / decisión del propietario)

| Ítem | Prioridad | Naturaleza |
|---|---|---|
| Script de backup+restore probado localmente | P1 | Seguro/reproducible (Dev) |
| Documentar y cronometrar RTO (prueba de restauración real) | P1 | Verificación |
| Cron de backup programado | P1/P2 | **Decisión de infra** (frecuencia) |
| Copia offsite (destino externo) | P1/P2 | **Decisión de infra/costo** |
| Retención/rotación de backups | P2 | Configuración |
| WAL / réplica (RPO continuo) | P2/P3 | **Decisión de arquitectura** |
| Estrategia de backup de la evidencia de video (no solo SQL) | P2 | **Decisión** (invariante #1) |
| Quitar el silenciado de migración del `deploy.sh` raíz | P1 | Seguro (Dev) |

## 5. Referencias

- `scripts/deploy.sh` (backup pre-deploy correcto), `deploy.sh` raíz (footgun).
- `scripts/rollback.sh` (reconoce que la DB requiere restauración manual).
- `docs/DEPLOYMENT.md` (§5 migraciones, §9 rollback, §10 advertencias).
