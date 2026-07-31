# Orden de migraciones Prisma

Prisma aplica las migraciones ordenando por el **nombre completo del directorio**
(orden lexicográfico), no sólo por el prefijo numérico. El estado aplicado se
registra en la tabla `_prisma_migrations` por nombre de carpeta.

## Prefijos numéricos duplicados (conocidos y seguros)

Existen prefijos repetidos por merges concurrentes de ramas. **No** deben
renombrarse: hacerlo cambiaría el nombre registrado en `_prisma_migrations` en
cualquier entorno donde ya se aplicaron, y Prisma lo interpretaría como una
migración faltante/nueva (drift). Se conservan tal cual; el orden es
determinista por nombre completo.

| Prefijo | Carpetas (orden lexicográfico de aplicación) | Independientes |
|---|---|---|
| `0009` | `0009_appearance_logo_fields` → `0009_nvr_recording_provider_channel_config_backup` | Sí (tablas distintas) |
| `0031` | `0031_appearance_token_engine_v2` → `0031_recordings_audio_mode` | Sí (tablas distintas) |

En ambos casos las dos migraciones tocan tablas diferentes, por lo que el orden
relativo entre ellas no afecta el resultado.

## Verificación

Antes de desplegar, con `DATABASE_URL` apuntando al entorno destino:

```bash
npx prisma migrate status   # muestra aplicadas / pendientes
npx prisma migrate deploy   # aplica las pendientes en orden
```

> En entornos sin `DATABASE_URL` (p.ej. CI de sólo build/test) `migrate status`
> no puede ejecutarse; validar el schema con `prisma generate` / `tsc`.

## Convención para nuevas migraciones

Usar el **siguiente** número libre (hoy: `0032_...`) para evitar sumar más
prefijos duplicados.
