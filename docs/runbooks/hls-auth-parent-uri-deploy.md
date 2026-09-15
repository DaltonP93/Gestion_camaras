# Runbook — Deploy del fix HLS auth_request (URI del request padre)

> **NO EJECUTAR TODAVÍA.** Este runbook es para cuando el PR #177 esté **fusionado**
> a `origin/main`. Sólo recarga nginx; no recrea contenedores, no toca datos, no
> migra, no reinicia servicios. Fail-closed: ante cualquier duda o fallo, se restaura
> el backup operativo y se recarga.
>
> **Contexto importante:** producción tiene un cambio local **no versionado**
> (`M infra/nginx/nginx.conf`) que es el **hotfix operativo ya validado** (contiene
> `set $hls_original_uri $uri;` + `X-Original-URI $hls_original_uri;`). Por eso NO se
> puede hacer `git pull` a ciegas: el archivo local modificado detendría el pull.

Reemplazá `HOST_ESPERADO` y el commit del checkout productivo por los valores reales.

## 0. Precondición
- PR #177 fusionado a `origin/main`.
- Ventana de bajo impacto.

## 1. Confirmar host, rama, HEAD y origin/main (solo lectura)
```bash
cd /home/sistemas/Gestion_camaras
hostname
git rev-parse --abbrev-ref HEAD          # esperado: main
git rev-parse HEAD                        # commit del checkout productivo
git fetch origin main
git rev-parse origin/main                 # debe incluir el merge de #177
git log --oneline -1 origin/main
```

## 2. Confirmar que el ÚNICO cambio local es infra/nginx/nginx.conf
```bash
git status --porcelain
# ESPERADO exactamente una línea:
#   M infra/nginx/nginx.conf
# Si aparece CUALQUIER otro archivo modificado/staged/untracked relevante ⇒ DETENERSE.
test "$(git status --porcelain | grep -vc '^[ ?]*$')" = "1" || echo 'ABORTAR: hay más de un cambio local'
git status --porcelain | grep -q '^ M infra/nginx/nginx.conf$' || echo 'ABORTAR: el cambio local no es (solo) infra/nginx/nginx.conf'
```

## 3. Respaldar el archivo operativo local + registrar SHA-256
```bash
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BK="/var/backups/visioncore/nginx.conf.operativo.${TS}"
install -D -m 600 infra/nginx/nginx.conf "$BK"
sha256sum "$BK" | tee "${BK}.sha256"
echo "Backup operativo: $BK"
```

## 4. Verificar que origin/main fusionado contiene EXACTAMENTE las 3 directivas
```bash
git show origin/main:infra/nginx/nginx.conf > /tmp/nginx.origin-main.conf
grep -nF 'set $hls_original_uri $uri;'                          /tmp/nginx.origin-main.conf
grep -nF 'proxy_set_header X-Original-URI $hls_original_uri;'   /tmp/nginx.origin-main.conf
grep -nF 'auth_request /internal/hls-auth;'                     /tmp/nginx.origin-main.conf
# Las 3 deben aparecer (exit 0). Si falta alguna ⇒ DETENERSE.
```

## 5. Confirmar que origin/main NO contiene la variante rota
```bash
if grep -nF 'proxy_set_header X-Original-URI $uri;' /tmp/nginx.origin-main.conf; then
  echo 'ABORTAR: origin/main aún tiene X-Original-URI $uri (roto)'; 
fi
# Debe NO imprimir coincidencias (exit 1 del grep = correcto).
```

## 6. Comparar semánticamente el hotfix local con la versión fusionada
```bash
# Diferencia acotada al cableado de auth_request. Lo esperado es que el hotfix local
# y origin/main coincidan en las 3 directivas; otras diferencias (comentarios, linaje
# de cert) son las ya fusionadas por PRs previos. Revisar a ojo:
diff -u <(grep -nE 'hls_original_uri|auth_request /internal/hls-auth;|X-Original-URI' infra/nginx/nginx.conf) \
        <(grep -nE 'hls_original_uri|auth_request /internal/hls-auth;|X-Original-URI' /tmp/nginx.origin-main.conf) \
  && echo 'Cableado auth_request IDÉNTICO entre hotfix local y origin/main'
# Si el cableado difiere semánticamente ⇒ DETENERSE y revisar manualmente.
```

## 7. Sólo tras las verificaciones: retirar el cambio local y fast-forward
```bash
# El backup del paso 3 preserva el archivo operativo. Como origin/main ya contiene el
# mismo cableado (verificado), se descarta el cambio local y se hace ff.
git checkout -- infra/nginx/nginx.conf     # descarta la M local (respaldada en $BK)
git pull --ff-only origin main             # debe ser fast-forward limpio
git rev-parse HEAD                          # == origin/main
git status --porcelain                      # árbol limpio
```

## 8. Validar la configuración ANTES de recargar
```bash
docker compose exec nginx nginx -t
# Debe decir "syntax is ok" y "test is successful". Si falla ⇒ ir al paso 11.
```

## 9. Recargar SOLO nginx (sin recrear contenedores)
```bash
docker compose exec nginx nginx -s reload
# NO usar `up -d --force-recreate`, NO reiniciar otros servicios.
```

## 10. Verificación post-reload
```bash
# API arriba
curl -fsS https://camaras.saa.com.py/api/health | jq -r .status     # ok

# HLS sin sesión ⇒ 401 (fail-closed)
curl -k -s -o /dev/null -w '%{http_code}\n' \
  https://camaras.saa.com.py/hls/nvr_<algún>_ch01_sub/index.m3u8     # 401
```
Además, en el navegador con un usuario autorizado:
- La cámara reproduce (frames reales, no sólo el manifiesto).
- Heartbeats: `active=N errors=0`.
- En logs de nginx/API: **sin** `BAD_PATH`/403 nuevos para usuarios autorizados.
```bash
docker compose logs --since 10m --no-color nginx api | grep -iE 'BAD_PATH|hls-auth|403' | tail
```

## 11. Rollback ante CUALQUIER fallo (fail-closed)
```bash
# Restaurar el archivo operativo respaldado (que YA tiene el hotfix correcto),
# validar y recargar. NUNCA desactivar auth_request ni volver a X-Original-URI $uri.
cp "$BK" infra/nginx/nginx.conf
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
# Verificar de nuevo el paso 10. Si el backup validado no existiera, DETENERSE
# (no dejar nginx sin autorización ni con la variante rota).
```

## 12. Estado
No ejecutar este runbook hasta tener autorización expresa y el PR #177 fusionado.
MERGE=NO · DEPLOY=NO · PRODUCTION=UNTOUCHED (al momento de redactar).
