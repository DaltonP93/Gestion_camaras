#!/usr/bin/env bash
# scripts/check-public-secrets.sh — verificación PREVIA al despliegue (sólo lectura).
#
# ¿JWT_SECRET permite arrancar el API nuevo? ¿Algún secreto coincide con un valor
# PÚBLICO conocido (default o ejemplo publicado en este repositorio, o placeholder
# genérico difundido)? Con un JWT_SECRET público cualquiera firma un access ADMIN
# válido; desde este cambio el API además NO arranca con él
# (apps/api/src/lib/jwt-secret-policy.ts).
#
# Sólo JWT_SECRET BLOQUEA (exit 1): ausente, público, no apto o no verificable. Las
# demás variables se INFORMAN con la remediación de cada una: rotarlas a ciegas en
# .env corta el servicio (POSTGRES_PASSWORD deja al API sin base; NVR_CREDENTIAL_KEY
# deja ilegibles las contraseñas de NVR). Con --strict también bloquean.
#
# NUNCA imprime valores (ni los del entorno ni los públicos): compara el SHA-256 del
# valor normalizado (sin espacios en los extremos, ASCII en minúsculas) contra la
# lista embebida, la MISMA del API (una prueba de CI exige que coincidan). Los valores
# viajan por pipes de builtins (printf), nunca como argumentos de un proceso.
# No ejecuta el .env (no lo hace `source`) ni contacta nada. Autocontenido: se
# puede copiar solo al servidor para verificar ANTES de actualizar el código.
#
# Lectura del .env, como docker compose (compose-go): `export` opcional, `=` o `:`;
# sin comillas, el comentario empieza en " #"; entre comillas, el valor termina en la
# comilla de cierre y después sólo puede haber un comentario. Lo que este script no
# lee IGUAL que compose (interpolación `$`, escapes `\`, valores multilínea, texto
# tras la comilla de cierre, tabulación antes de `#`) se informa "no verificable" y,
# para JWT_SECRET, bloquea (fail-closed). Se espera JWT_SECRET ASCII (como produce
# openssl rand -hex): el API cuenta caracteres y este script bytes, así que un valor
# no ASCII también es "no verificable".
#
# Uso:
#   bash scripts/check-public-secrets.sh --env-file /ruta/.env
#   bash scripts/check-public-secrets.sh --process-env
#   bash scripts/check-public-secrets.sh --env-file .env --process-env
#       (el entorno del proceso pisa al archivo, como la interpolación de docker compose)
#   --strict   además bloquea si otra variable coincide con un valor público o no es verificable
#
# Salida, por variable vigilada:
#   <VAR>: coincide con un valor público: sí|no  |  <VAR>: no definida  |  <VAR>: no verificable (<motivo>)
#   <VAR>: qué hacer: <remediación>               (otra variable que coincide o no es verificable)
# y para JWT_SECRET además:
#   JWT_SECRET: apto para el arranque del API (largo ≥ 32, variedad, sin bloque repetido): sí|no|no verificable (<motivo>)
#
# Exit: 0 = JWT_SECRET definido, verificable, no público y apto (puede haber avisos de otras variables)
#       1 = JWT_SECRET ausente, público, no apto o no verificable (el API no arrancaría o no
#           se puede asegurar); con --strict, también los avisos de otras variables
#       2 = uso inválido o archivo ilegible
set -uo pipefail
export LC_ALL=C

# ── Lista embebida: SHA-256 del valor normalizado (nunca el valor) ──────────────
# Igual a VALORES_PUBLICOS_SHA256 de apps/api/src/lib/jwt-secret-policy.ts.
HASHES_PUBLICOS="
81ad539721bdd169e7b2014bb14b4a566b7eb36d5249becd7ca7f8c6f6e0633f
d48b2ecaad4a6cee65f4e797b44062aa51f9fab958ada261342d5b10cab6310e
6f6d5f7844d0760753f77e25a2ce548daf261dca5c85a087ffa0c7652604a892
35e88ff857167e480396bf91314f4c6560c447897e0f760a3b30f1aa2763d040
f8e08116a2d738c30170416054635fe1a865bb49fdc0a7fbad01a326280ac044
1a428d83c1cf283ec3f705cede27410fc869ade1f5d88820eddd414a5ac4b6fa
156da39eb9b650474b01d9836ea8af3fc0121c6274755840eceb9768ea7c108a
057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86
fb86fb757d1241d512865070e05ccb5d17dfaa11a4b2ca04b89bacad17530ad4
e2186dbdb1bb4193608605e84f33208765b5693b55edd4f730a719a100eeea6f
2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b
5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8
e88040e7d0052eeb5dcf0fd834e4835ff329b275e6a9889058e8d16c38da9514
f7d838701b86c5dfb57bf95fbc5ce6df204cfc9f15ad6cdb39fd22f8776e47b6
5906f93b26ee80461424a3efe65f89731e50c3228035db85a81439f9ba00a572
048af2438891a89a3536ac09cc96ccbd34a1714e88cf8fdb63e6186dcc3ff89d
f75778f7425be4db0369d09af37a6c2b9a83dea0e53e7bd57412e4b060e607f7
1453cea2dc3799e9026e42b3e465e455256d5a149582e4c5b92d4c8d604731a2
"

# Secretos vigilados (docker-compose.yml / .env.example).
VIGILADAS="JWT_SECRET JWT_REFRESH_SECRET NVR_CREDENTIAL_KEY POSTGRES_PASSWORD ANALYTICS_SECRET MEDIA_RELAY_SECRET METRICS_TOKEN SMTP_PASS FRIGATE_RTSP_PASSWORD HIK_CONNECT_SECRET_KEY SEED_ADMIN_PASSWORD"

# Mismos umbrales que el API (MIN_LARGO_JWT_SECRET / MIN_CARACTERES_DISTINTOS).
MIN_LARGO_JWT=32
MIN_DISTINTOS=6

uso() {
  echo "Uso: $0 [--env-file <archivo>] [--process-env] [--strict]   (al menos uno de los dos primeros)" >&2
  exit 2
}

ENV_FILE=""
PROCESS_ENV=0
STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || uso; ENV_FILE="$2"; shift 2 ;;
    --process-env) PROCESS_ENV=1; shift ;;
    --strict) STRICT=1; shift ;;
    -h|--help) uso ;;
    *) uso ;;
  esac
done
[ -n "$ENV_FILE" ] || [ "$PROCESS_ENV" = 1 ] || uso

if command -v sha256sum >/dev/null 2>&1; then
  sha256_stdin() { sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_stdin() { shasum -a 256 | cut -d' ' -f1; }
else
  echo "check-public-secrets: falta sha256sum/shasum" >&2
  exit 2
fi

es_vigilada() {
  case " $VIGILADAS " in *" $1 "*) return 0 ;; esac
  return 1
}

# Qué hacer cuando OTRA variable (no JWT_SECRET) coincide con un valor público. NO
# es "reemplazala en .env": en varias eso corta el servicio.
remediacion() {
  case "$1" in
    JWT_REFRESH_SECRET) echo "el API no la usa (los refresh se firman con JWT_SECRET): eliminá la línea del .env." ;;
    POSTGRES_PASSWORD) echo "NO la cambies sólo en .env: Postgres la toma únicamente al crear el volumen (initdb) y el API quedaría sin base (DATABASE_URL). Rotarla exige ALTER USER coordinado con .env: cambio operativo que requiere autorización." ;;
    NVR_CREDENTIAL_KEY) echo "NO la cambies sólo en .env: las contraseñas de NVR cifradas con ella quedarían ilegibles (las cámaras dejan de verse). Rotarla exige re-cifrarlas antes: cambio operativo que requiere autorización." ;;
    SEED_ADMIN_PASSWORD) echo "sólo la usa el seed inicial: cambiá la contraseña del admin desde la UI y vaciá la variable." ;;
    SMTP_PASS|FRIGATE_RTSP_PASSWORD|HIK_CONNECT_SECRET_KEY) echo "credencial de un servicio externo (SMTP, cámara/NVR, Hik-Connect): rotala primero allí y después en .env." ;;
    ANALYTICS_SECRET|MEDIA_RELAY_SECRET|METRICS_TOKEN) echo "secreto compartido: generá otro (openssl rand -hex 32) y actualizalo a la vez en el API y en el otro extremo." ;;
    *) echo "rotala coordinando con quien la use." ;;
  esac
}

# Sin espacios [:space:] en los extremos (como el API).
recortar() {
  local v=$1
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

coincide_publico() {
  local h
  h=$(recortar "$1" | tr 'A-Z' 'a-z' | sha256_stdin)
  case "$HASHES_PUBLICOS" in *"$h"*) return 0 ;; esac
  return 1
}

# ¿Tiene bytes ≥ 0x80? (con LC_ALL=C el rango es por byte)
no_ascii() {
  case "$1" in *[$'\x80'-$'\xff']*) return 0 ;; esac
  return 1
}

# Mismas heurísticas que evaluarJwtSecret (largo, variedad, bloque repetido). Sólo
# para valores ASCII: con LC_ALL=C se cuentan bytes (el API cuenta caracteres).
jwt_apto() {
  local v=$1 n p distintos
  [ -n "$(recortar "$v")" ] || return 1
  n=${#v}
  [ "$n" -ge "$MIN_LARGO_JWT" ] || return 1
  distintos=$(printf '%s' "$v" | fold -w1 | sort -u | wc -l | tr -d ' ')
  [ "$distintos" -ge "$MIN_DISTINTOS" ] || return 1
  for ((p = 1; p <= n / 2; p++)); do
    [ "${v:p}" = "${v:0:n-p}" ] && return 1
  done
  return 0
}

# Valor de una línea .env (lo que sigue al primer `=` o `:`) como lo deja docker
# compose. Deja el valor en VALOR y, si no se puede leer igual que compose, el
# motivo en NO_VERIF (y VALOR vacío).
RE_TRAS_COMILLA='^[[:space:]]*(#.*)?$'
MOTIVO_MULTILINEA="comilla sin cerrar: valor multilínea"
interpretar_valor() {
  local v q resto
  VALOR=""; NO_VERIF=""
  v=$(recortar "$1")
  case "$v" in
    \"*|\'*)
      q=${v:0:1}; v=${v:1}
      case "$v" in *"$q"*) ;; *) NO_VERIF=$MOTIVO_MULTILINEA; return ;; esac
      resto=${v#*"$q"}; v=${v%%"$q"*}
      [[ $resto =~ $RE_TRAS_COMILLA ]] || { NO_VERIF="texto después de la comilla de cierre"; return; }
      case "$v" in *\\*) NO_VERIF="barra invertida entre comillas: docker compose interpreta escapes"; return ;; esac
      if [ "$q" = '"' ]; then
        case "$v" in *\$*) NO_VERIF="\$ entre comillas dobles: docker compose interpola variables"; return ;; esac
      fi
      ;;
    *)
      v=${v%% #*}
      v=$(recortar "$v")
      case "$v" in *\$*) NO_VERIF="\$ sin comillas: docker compose interpola variables"; return ;; esac
      case "$v" in *[[:space:]]\#*) NO_VERIF="tabulación u otro espacio antes de #: docker compose no lo toma como comentario"; return ;; esac
      ;;
  esac
  VALOR=$v
}

# Valores: V_<VAR> (definida si DEF_<VAR>=1; NV_<VAR> = motivo si no es verificable).
# Sin arrays asociativos (bash 3 ok).
MULTILINEA=""
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || { echo "check-public-secrets: no se puede leer el archivo indicado" >&2; exit 2; }
  re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*[=:](.*)$'
  nlinea=0
  while IFS= read -r linea || [ -n "$linea" ]; do
    nlinea=$((nlinea + 1))
    linea=${linea%$'\r'}
    [[ $linea =~ $re ]] || continue
    clave=${BASH_REMATCH[2]}
    interpretar_valor "${BASH_REMATCH[3]}"
    # Una comilla sin cerrar (de CUALQUIER variable) abre un valor multilínea: desde
    # ahí compose no lee las líneas como este script.
    if [ -z "$MULTILINEA" ] && [ "$NO_VERIF" = "$MOTIVO_MULTILINEA" ]; then MULTILINEA=$nlinea; fi
    es_vigilada "$clave" || continue
    printf -v "V_$clave" '%s' "$VALOR"
    printf -v "NV_$clave" '%s' "$NO_VERIF"
    printf -v "DEF_$clave" '%s' 1
  done < "$ENV_FILE"
  if [ -n "$MULTILINEA" ]; then
    for clave in $VIGILADAS; do
      def="DEF_$clave"
      if [ "${!def:-0}" = 1 ]; then
        printf -v "NV_$clave" '%s' "el .env tiene un valor multilínea (línea $MULTILINEA): no se puede asegurar qué valor toma docker compose"
      fi
    done
  fi
fi
if [ "$PROCESS_ENV" = 1 ]; then
  for clave in $VIGILADAS; do
    if [ -n "${!clave+x}" ]; then
      printf -v "V_$clave" '%s' "${!clave}"
      printf -v "NV_$clave" '%s' ""
      printf -v "DEF_$clave" '%s' 1
    fi
  done
fi

bloqueante=0
avisos=0
for clave in $VIGILADAS; do
  def="DEF_$clave"; val="V_$clave"; nv="NV_$clave"
  if [ "${!def:-0}" = 1 ] && [ -n "${!nv:-}" ]; then
    echo "$clave: no verificable (${!nv})"
    if [ "$clave" = JWT_SECRET ]; then
      bloqueante=1
    else
      echo "$clave: qué hacer: no se comparó con la lista; para verificarla, escribila en una sola línea sin \$ ni \\ (o exportala y usá --process-env)."
      avisos=1
    fi
    continue
  fi
  if [ "${!def:-0}" != 1 ] || [ -z "$(recortar "${!val}")" ]; then
    if [ "$clave" = JWT_SECRET ]; then
      echo "JWT_SECRET: no definida (obligatoria: generala con openssl rand -hex 64)"
      bloqueante=1
    else
      echo "$clave: no definida"
    fi
    continue
  fi
  publico=0
  if coincide_publico "${!val}"; then
    echo "$clave: coincide con un valor público: sí"
    publico=1
  else
    echo "$clave: coincide con un valor público: no"
  fi
  if [ "$clave" != JWT_SECRET ]; then
    if [ "$publico" = 1 ]; then
      echo "$clave: qué hacer: $(remediacion "$clave")"
      avisos=1
    fi
    continue
  fi
  if [ "$publico" = 0 ] && no_ascii "${!val}"; then
    echo "JWT_SECRET: apto para el arranque del API (largo ≥ 32, variedad, sin bloque repetido): no verificable (caracteres no ASCII: el API cuenta caracteres y este script bytes)"
    bloqueante=1
  elif [ "$publico" = 0 ] && jwt_apto "${!val}"; then
    echo "JWT_SECRET: apto para el arranque del API (largo ≥ 32, variedad, sin bloque repetido): sí"
  else
    echo "JWT_SECRET: apto para el arranque del API (largo ≥ 32, variedad, sin bloque repetido): no"
    bloqueante=1
  fi
done

if [ "$bloqueante" = 1 ]; then
  echo "Resultado: BLOQUEANTE — JWT_SECRET: generá uno con openssl rand -hex 64 y escribilo en .env en una sola línea, sin comillas."
  echo "Cambiar JWT_SECRET invalida todas las sesiones (re-login). Si quedan contraseñas de NVR en formato legacy (sin prefijo gcm.v1.) cifradas con el JWT_SECRET anterior, re-guardalas ANTES de rotarlo."
  exit 1
fi
if [ "$avisos" = 1 ]; then
  if [ "$STRICT" = 1 ]; then
    echo "Resultado: BLOQUEANTE (--strict) — otras variables coinciden con un valor público o no son verificables (ver \"qué hacer\"; NO las reemplaces a ciegas en .env)."
    exit 1
  fi
  echo "Resultado: OK para el arranque del API, con avisos — otras variables coinciden con un valor público o no son verificables (ver \"qué hacer\"). No bloquean el despliegue: rotarlas es un cambio operativo aparte."
  exit 0
fi
echo "Resultado: OK — ningún secreto coincide con un valor público conocido."
exit 0
