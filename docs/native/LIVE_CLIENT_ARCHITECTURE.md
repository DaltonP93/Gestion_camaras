# Cliente nativo de LiveView — arquitectura objetivo

Estado: **diseño C21; el relay nativo todavía no está habilitado**.

## Objetivo y límite real

Una sola base de producto debe generar paquetes para Windows, Android e iOS y
reutilizar la interfaz de VisionCore. El módulo de video será específico de
cada plataforma para aprovechar decodificación HEVC por hardware.

Esto evita que una cámara HEVC consuma uno de los dos FFmpeg del servidor. No
significa «cámaras ilimitadas»: el máximo pasa a depender de decodificadores de
hardware, GPU, memoria, red, capacidad del NVR y MediaMTX. El cliente anunciará
`maxHardwareDecoders`; el servidor lo tratará como una capacidad declarada, no
como garantía.

| Cliente | HEVC principal | Usa FFmpeg del servidor | Límite dominante |
|---|---|---:|---|
| Navegador | HLS H.264 transcodificado | Sí | `MAX_TRANSCODE_SESSIONS=2` |
| Nativo sin HEVC HW | fallback HLS H.264 | Sí | servidor |
| Nativo con HEVC HW + relay seguro | HEVC directo | No | dispositivo/red/NVR |

## Base compartida y módulos de plataforma

- Shell recomendado: Tauri 2 y la UI React existente.
- Windows: Media Foundation/decoder HEVC del sistema, con backend de video
  intercambiable cuando el códec del host no esté instalado.
- Android: MediaCodec mediante un adaptador nativo.
- iOS: VideoToolbox mediante un adaptador nativo.
- Cada plataforma produce su propio paquete (`.msi/.exe`, `.aab/.apk`, `.ipa`);
  «una base» no significa un mismo binario para tres sistemas operativos.

El adaptador debe exponer la misma frontera:

```ts
interface NativeVideoAdapter {
  capabilities(): Promise<{
    codecs: Array<'h264' | 'hevc'>
    hardwareDecodedCodecs: Array<'h264' | 'hevc'>
    transports: Array<'rtsps' | 'whep'>
    maxHardwareDecoders: number
  }>
  open(grant: EphemeralMediaGrant): Promise<NativePlayerHandle>
  close(handle: NativePlayerHandle): Promise<void>
}
```

## Contrato ya incorporado en C21

`POST /api/live-view/client-capabilities` acepta el runtime, códecs,
transportes y cantidad de decodificadores del dispositivo. En C21 sólo negocia
y no abre streams. Devuelve:

- fallback web y límite real del servidor;
- si el dispositivo es candidato a HEVC local;
- `nativeDirect.available=false` hasta implementar el relay seguro;
- garantía `rawNvrCredentialsExposed=false`.

Este bloqueo explícito impide que una app futura interprete «el teléfono puede
decodificar HEVC» como autorización para conectarse directamente al NVR.

## Relay seguro obligatorio

La configuración actual de MediaMTX permite lectura sin credenciales y publica
puertos de medios. Eso puede ser aceptable únicamente detrás de firewall/red
confiable; **no es el contrato del cliente nativo**.

Antes de activar `nativeDirect`:

1. MediaMTX debe exigir autorización de lectura por path.
2. El API emite un grant opaco, de vida corta, ligado a usuario, `viewId`,
   cámara, path, acción `read` y vencimiento.
3. El dispositivo recibe RTSPS o WHEP autenticado del restream de MediaMTX,
   nunca la URL RTSP ni la contraseña del NVR.
4. El grant participa del mismo registro, heartbeat y cierre por identidad que
   el navegador.
5. Revocar/logout/cambiar permisos invalida grants nuevos y corta los activos
   según la política documentada.

RTSPS es el primer transporte candidato para HEVC nativo. WHEP queda disponible
cuando códec y plataforma lo soporten; no se debe prometer HEVC/WebRTC universal.

## Fases verificables

1. **C21 — contrato y observabilidad:** negociación, métricas de cupo/latencia,
   UX honesta. Sin acceso nativo directo.
2. **N1 — seguridad de medios:** auth por path, grants efímeros, firewall y
   pruebas de revocación/aislamiento entre usuarios.
3. **N2 — Windows MVP:** 1, 4 y 9 cámaras; HEVC hardware; reconexión; cierre;
   medición de CPU/GPU/red.
4. **N3 — Android/iOS:** mismos contratos e invariantes, adaptadores nativos.
5. **N4 — optimización:** selección automática de perfil, límites por
   dispositivo, telemetría y rollout gradual.

## IA sin duplicar conexiones al NVR

La analítica seguirá leyendo el restream compartido de MediaMTX. El cliente
nativo no abre una segunda fuente del NVR para IA. Fases posteriores pueden
agregar inferencia local opcional, pero los eventos vuelven al API con identidad
de cámara, tiempo y versión del modelo; no reemplazan la verdad del servidor.
