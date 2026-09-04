// src/pages/IntegrationsPage.tsx
//
// Página ADMIN de Integraciones. Hoy expone el panel ONVIF (descubrimiento,
// info, perfiles, stream URI, PTZ e imaging). El acceso ADMIN se refuerza tanto
// en el enrutado (App.tsx / ProtectedRoute) como en el backend (rutas ADMIN-only).
//
// SEGURIDAD:
//   - Con ONVIF_ENABLED=false el panel muestra "Deshabilitado" y NO llama a
//     ningún endpoint /api/onvif/* (fail-safe mediante deriveOnvifPanelState).
//   - Las credenciales del dispositivo viven SÓLO en el estado del componente y
//     viajan en el body de cada request; nunca se persisten ni se loguean.
//   - La URI RTSP de "Stream URI" se muestra transitoriamente para copiar; no se
//     persiste, no se loguea y se limpia al cambiar de dispositivo/perfil.
import { useEffect, useState } from 'react'
import {
  Globe, Radar, Info, Film, Link2, Move, Aperture, RefreshCw,
  Copy, Check, AlertTriangle, Loader2, Eye, EyeOff,
  Cloud, KeyRound, PlayCircle, Terminal,
} from 'lucide-react'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'
import { integrationsApi, onvifApi, hikConnectApi } from '@/lib/api'
import { deriveOnvifPanelState, deriveHikConnectPanelState, integrationErrorMessage } from '@/lib/integrations'
import type {
  IntegrationsStatus, OnvifCredentials, OnvifDiscoveredDevice, OnvifDeviceInformation,
  OnvifProfile, OnvifPtzConfiguration, OnvifImagingSettings, OnvifIrCutFilterMode,
  HikConnectTokenStatus, HikConnectHlsResponse, HikConnectIsapiMethod,
} from '@/types'

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 text-surface-100 text-sm font-semibold">
        <span className="text-brand-400">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  )
}

export function IntegrationsPage() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)

  // Datos del dispositivo (credenciales SÓLO en memoria del componente).
  const [deviceUrl, setDeviceUrl] = useState('')
  const [creds, setCreds] = useState<OnvifCredentials>({ username: '', password: '' })
  const [showPass, setShowPass] = useState(false)

  const [busy, setBusy] = useState<string | null>(null)
  const [devices, setDevices] = useState<OnvifDiscoveredDevice[] | null>(null)
  const [info, setInfo] = useState<OnvifDeviceInformation | null>(null)
  const [profiles, setProfiles] = useState<OnvifProfile[] | null>(null)
  const [profileToken, setProfileToken] = useState('')
  const [videoSourceToken, setVideoSourceToken] = useState('')
  const [streamUri, setStreamUri] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [ptzConfigs, setPtzConfigs] = useState<OnvifPtzConfiguration[] | null>(null)
  const [ptz, setPtz] = useState({ x: 0, y: 0, zoom: 0 })
  const [imaging, setImaging] = useState<OnvifImagingSettings | null>(null)
  const [irCut, setIrCut] = useState<OnvifIrCutFilterMode>('AUTO')

  const panel = deriveOnvifPanelState(status)
  const hikPanel = deriveHikConnectPanelState(status)

  // ── Estado Hik-Connect (todo transitorio; nada se persiste ni loguea) ──
  const [busyHik, setBusyHik] = useState<string | null>(null)
  const [hikToken, setHikToken] = useState<HikConnectTokenStatus | null>(null)
  const [hikSerial, setHikSerial] = useState('')
  const [hikChannel, setHikChannel] = useState('1')
  const [hikHls, setHikHls] = useState<HikConnectHlsResponse | null>(null)
  const [hikHlsCopied, setHikHlsCopied] = useState(false)
  const [isapiMethod, setIsapiMethod] = useState<HikConnectIsapiMethod>('GET')
  const [isapiPath, setIsapiPath] = useState('')
  const [isapiBody, setIsapiBody] = useState('')
  const [isapiResult, setIsapiResult] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    integrationsApi.getStatus()
      .then((s) => { if (alive) setStatus(s) })
      .catch((e) => { if (alive) toast.error(integrationErrorMessage(e, 'No se pudo leer el estado de integraciones')) })
      .finally(() => { if (alive) setLoadingStatus(false) })
    return () => { alive = false }
  }, [])

  // Guard: nunca llamar a /api/onvif/* si el panel está deshabilitado.
  async function run<T>(key: string, fn: () => Promise<T>, onOk: (r: T) => void) {
    if (panel.actionsDisabled) return
    setBusy(key)
    try {
      onOk(await fn())
    } catch (e) {
      toast.error(integrationErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const hasDevice = deviceUrl.trim() !== '' && creds.username !== '' && creds.password !== ''

  // Al cambiar de dispositivo/perfil, olvidar la URI transitoria.
  function resetTransient() {
    setStreamUri(null)
    setCopied(false)
  }

  async function copyUri() {
    if (!streamUri) return
    try {
      await navigator.clipboard.writeText(streamUri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('No se pudo copiar')
    }
  }

  // Guard Hik-Connect: nunca llamar a /api/hik-connect/* si el panel está off.
  async function runHik<T>(key: string, fn: () => Promise<T>, onOk: (r: T) => void) {
    if (hikPanel.actionsDisabled) return
    setBusyHik(key)
    try {
      onOk(await fn())
    } catch (e) {
      toast.error(integrationErrorMessage(e))
    } finally {
      setBusyHik(null)
    }
  }

  async function copyHikHls() {
    if (!hikHls) return
    try {
      await navigator.clipboard.writeText(hikHls.url)
      setHikHlsCopied(true)
      setTimeout(() => setHikHlsCopied(false), 1500)
    } catch {
      toast.error('No se pudo copiar')
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-2">
        <Globe size={20} className="text-brand-400" />
        <h1 className="text-lg font-semibold text-surface-50">Integraciones</h1>
      </div>
      <p className="text-sm text-surface-400">
        Conectividad con dispositivos y proveedores externos. Estas acciones son sólo para administradores.
      </p>

      {/* ── Panel ONVIF ─────────────────────────────────────── */}
      <div className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-surface-100 font-semibold">
            <Radar size={18} className="text-brand-400" />
            ONVIF
          </div>
          {loadingStatus ? (
            <span className="text-xs text-surface-400 flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Comprobando…
            </span>
          ) : panel.enabled ? (
            <span className="badge-online">Habilitado</span>
          ) : (
            <span className="badge-offline">Deshabilitado</span>
          )}
        </div>

        {!loadingStatus && panel.actionsDisabled && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-900/20 border border-amber-800/40 p-3 text-sm text-amber-300">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{panel.notice}</span>
          </div>
        )}

        <fieldset disabled={panel.actionsDisabled} className={clsx('space-y-4', panel.actionsDisabled && 'opacity-50')}>
          {/* Descubrimiento */}
          <Section icon={<Radar size={15} />} title="Descubrir dispositivos (WS-Discovery)">
            <button
              className="btn-secondary text-xs"
              onClick={() => run('discover', () => onvifApi.discover(), (r) => setDevices(r.devices))}
              disabled={busy === 'discover'}
            >
              {busy === 'discover' ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
              Descubrir
            </button>
            {devices && (
              devices.length === 0 ? (
                <p className="text-xs text-surface-400">No se encontraron dispositivos en la red local.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-surface-400 text-left">
                      <tr><th className="py-1 pr-3">Dirección</th><th className="py-1 pr-3">XAddrs</th><th className="py-1">Usar</th></tr>
                    </thead>
                    <tbody>
                      {devices.map((d, i) => (
                        <tr key={i} className="border-t border-surface-700/50">
                          <td className="py-1 pr-3 text-surface-200 font-mono">{d.remoteAddress}</td>
                          <td className="py-1 pr-3 text-surface-400 font-mono truncate max-w-[240px]">{d.xaddrs[0] ?? '—'}</td>
                          <td className="py-1">
                            <button
                              className="btn-ghost text-xs px-2 py-1"
                              onClick={() => { if (d.xaddrs[0]) { setDeviceUrl(d.xaddrs[0]); resetTransient() } }}
                            >
                              Cargar URL
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </Section>

          {/* Conexión al dispositivo */}
          <Section icon={<Link2 size={15} />} title="Dispositivo y credenciales">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-3">
                <label className="label">Device URL (XAddr ONVIF)</label>
                <input
                  className="input font-mono"
                  placeholder="http://192.168.x.x/onvif/device_service"
                  value={deviceUrl}
                  onChange={(e) => { setDeviceUrl(e.target.value); resetTransient() }}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="label">Usuario del dispositivo</label>
                <input
                  className="input"
                  value={creds.username}
                  onChange={(e) => setCreds((c) => ({ ...c, username: e.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">Contraseña del dispositivo</label>
                <div className="relative">
                  <input
                    className="input pr-10"
                    type={showPass ? 'text' : 'password'}
                    value={creds.password}
                    onChange={(e) => setCreds((c) => ({ ...c, password: e.target.value }))}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-200"
                    tabIndex={-1}
                  >
                    {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            </div>
            <p className="text-xs text-surface-500">
              Las credenciales sólo se usan para esta sesión de administración; no se guardan en el navegador ni en el servidor.
            </p>
          </Section>

          {/* Info + perfiles */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Section icon={<Info size={15} />} title="Información del dispositivo">
              <button
                className="btn-secondary text-xs"
                disabled={!hasDevice || busy === 'info'}
                onClick={() => run('info', () => onvifApi.deviceInformation(deviceUrl, creds), setInfo)}
              >
                {busy === 'info' ? <Loader2 size={13} className="animate-spin" /> : <Info size={13} />}
                Obtener info
              </button>
              {info && (
                <dl className="text-xs space-y-1">
                  {(['manufacturer', 'model', 'firmwareVersion', 'serialNumber', 'hardwareId'] as const).map((k) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-surface-400">{k}</dt>
                      <dd className="text-surface-200 font-mono truncate">{info[k] ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Section>

            <Section icon={<Film size={15} />} title="Perfiles">
              <button
                className="btn-secondary text-xs"
                disabled={!hasDevice || busy === 'profiles'}
                onClick={() => run('profiles', () => onvifApi.profiles(deviceUrl, creds), (r) => {
                  setProfiles(r.profiles)
                  const first = r.profiles[0]
                  if (first) { setProfileToken(first.token); if (first.videoSourceToken) setVideoSourceToken(first.videoSourceToken) }
                })}
              >
                {busy === 'profiles' ? <Loader2 size={13} className="animate-spin" /> : <Film size={13} />}
                Listar perfiles
              </button>
              {profiles && profiles.length > 0 && (
                <select
                  className="input text-xs"
                  value={profileToken}
                  onChange={(e) => {
                    setProfileToken(e.target.value)
                    const p = profiles.find((x) => x.token === e.target.value)
                    if (p?.videoSourceToken) setVideoSourceToken(p.videoSourceToken)
                    resetTransient()
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.token} value={p.token}>
                      {(p.name ?? p.token)}{p.width && p.height ? ` — ${p.width}x${p.height}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {profiles && profiles.length === 0 && <p className="text-xs text-surface-400">Sin perfiles.</p>}
            </Section>
          </div>

          {/* Stream URI (transitorio) */}
          <Section icon={<Link2 size={15} />} title="Stream URI (RTSP)">
            <button
              className="btn-secondary text-xs"
              disabled={!hasDevice || !profileToken || busy === 'stream'}
              onClick={() => run('stream', () => onvifApi.streamUri(deviceUrl, creds, profileToken), (r) => setStreamUri(r.uri))}
            >
              {busy === 'stream' ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Obtener URI
            </button>
            {streamUri && (
              <div className="flex items-center gap-2 rounded-lg bg-surface-900 border border-surface-600 p-2">
                <code className="flex-1 text-xs text-surface-200 break-all font-mono">{streamUri}</code>
                <button className="btn-ghost p-1.5" onClick={copyUri} title="Copiar">
                  {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>
              </div>
            )}
            {streamUri && (
              <p className="text-xs text-surface-500">
                La URI se muestra sólo para copiarla; no se almacena. Se limpia al cambiar de dispositivo o perfil.
              </p>
            )}
          </Section>

          {/* PTZ */}
          <Section icon={<Move size={15} />} title="PTZ">
            <button
              className="btn-secondary text-xs"
              disabled={!hasDevice || busy === 'ptzcfg'}
              onClick={() => run('ptzcfg', () => onvifApi.ptzConfigurations(deviceUrl, creds), (r) => setPtzConfigs(r.configurations))}
            >
              {busy === 'ptzcfg' ? <Loader2 size={13} className="animate-spin" /> : <Move size={13} />}
              Ver configuraciones PTZ
            </button>
            {ptzConfigs && (
              <p className="text-xs text-surface-400">{ptzConfigs.length} configuración(es) PTZ.</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              {(['x', 'y', 'zoom'] as const).map((axis) => (
                <div key={axis}>
                  <label className="label capitalize">{axis} ({ptz[axis].toFixed(1)})</label>
                  <input
                    type="range" min={-1} max={1} step={0.1}
                    value={ptz[axis]}
                    onChange={(e) => setPtz((p) => ({ ...p, [axis]: Number(e.target.value) }))}
                    className="w-full accent-brand-500"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                className="btn-primary text-xs"
                disabled={!hasDevice || !profileToken || busy === 'move'}
                onClick={() => run('move', () => onvifApi.ptzMove(deviceUrl, creds, profileToken, ptz), () => toast.success('Movimiento enviado'))}
              >
                {busy === 'move' ? <Loader2 size={13} className="animate-spin" /> : <Move size={13} />}
                Mover
              </button>
              <button
                className="btn-secondary text-xs"
                disabled={!hasDevice || !profileToken || busy === 'stop'}
                onClick={() => run('stop', () => onvifApi.ptzStop(deviceUrl, creds, profileToken), () => toast.success('PTZ detenido'))}
              >
                Detener
              </button>
            </div>
          </Section>

          {/* Imaging */}
          <Section icon={<Aperture size={15} />} title="Imaging (filtro IR-Cut)">
            <div className="flex flex-wrap items-end gap-3">
              <button
                className="btn-secondary text-xs"
                disabled={!hasDevice || !videoSourceToken || busy === 'imgget'}
                onClick={() => run('imgget', () => onvifApi.imagingGet(deviceUrl, creds, videoSourceToken), (r) => {
                  setImaging(r.settings)
                  const v = r.settings.irCutFilter
                  if (v === 'ON' || v === 'OFF' || v === 'AUTO') setIrCut(v)
                })}
              >
                {busy === 'imgget' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                Leer ajustes
              </button>
              <div>
                <label className="label">IrCutFilter</label>
                <select className="input text-xs" value={irCut} onChange={(e) => setIrCut(e.target.value as OnvifIrCutFilterMode)}>
                  <option value="ON">ON</option>
                  <option value="OFF">OFF</option>
                  <option value="AUTO">AUTO</option>
                </select>
              </div>
              <button
                className="btn-primary text-xs"
                disabled={!hasDevice || !videoSourceToken || busy === 'imgset'}
                onClick={() => run('imgset', () => onvifApi.imagingSet(deviceUrl, creds, videoSourceToken, { irCutFilter: irCut }), () => toast.success('Ajustes aplicados'))}
              >
                {busy === 'imgset' ? <Loader2 size={13} className="animate-spin" /> : <Aperture size={13} />}
                Aplicar
              </button>
            </div>
            {imaging && (
              <p className="text-xs text-surface-400">
                IR-Cut actual: <span className="text-surface-200 font-mono">{imaging.irCutFilter ?? '—'}</span>
              </p>
            )}
          </Section>
        </fieldset>
      </div>

      {/* ── Panel Hik-Connect ───────────────────────────────── */}
      <div className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-surface-100 font-semibold">
            <Cloud size={18} className="text-brand-400" />
            Hik-Connect
          </div>
          {loadingStatus ? (
            <span className="text-xs text-surface-400 flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Comprobando…
            </span>
          ) : hikPanel.enabled ? (
            <span className="badge-online">Habilitado</span>
          ) : (
            <span className="badge-offline">Deshabilitado</span>
          )}
        </div>

        <p className="text-xs text-surface-500">
          Proveedor cloud de Hikvision. El AppKey/SecretKey se configuran SÓLO en el servidor (variables de
          entorno) y nunca se piden ni muestran acá. Hik-Connect entrega H.264 (sin HEVC/transcode).
        </p>

        {!loadingStatus && hikPanel.actionsDisabled && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-900/20 border border-amber-800/40 p-3 text-sm text-amber-300">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{hikPanel.notice}</span>
          </div>
        )}

        <fieldset disabled={hikPanel.actionsDisabled} className={clsx('space-y-4', hikPanel.actionsDisabled && 'opacity-50')}>
          {/* Probar token (sólo metadatos, NUNCA el accessToken) */}
          <Section icon={<KeyRound size={15} />} title="Probar token (metadatos)">
            <button
              className="btn-secondary text-xs"
              disabled={busyHik === 'token'}
              onClick={() => runHik('token', () => hikConnectApi.tokenStatus(), setHikToken)}
            >
              {busyHik === 'token' ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
              Probar token
            </button>
            {hikToken && (
              <dl className="text-xs space-y-1">
                <div className="flex justify-between gap-3">
                  <dt className="text-surface-400">areaDomain</dt>
                  <dd className="text-surface-200 font-mono truncate">{hikToken.areaDomain}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-surface-400">Expira</dt>
                  <dd className="text-surface-200 font-mono">
                    {hikToken.expireTimeMs ? new Date(hikToken.expireTimeMs).toLocaleString() : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-surface-400">Activo</dt>
                  <dd className="text-surface-200 font-mono">{hikToken.active ? 'sí' : 'no'}</dd>
                </div>
              </dl>
            )}
            <p className="text-xs text-surface-500">
              Sólo se muestran metadatos del token; el accessToken nunca sale del servidor.
            </p>
          </Section>

          {/* HLS temporal (URL transitoria) */}
          <Section icon={<PlayCircle size={15} />} title="HLS temporal">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="label">Device serial</label>
                <input
                  className="input font-mono"
                  placeholder="p.ej. DS-XXXXXXXXX"
                  value={hikSerial}
                  onChange={(e) => { setHikSerial(e.target.value); setHikHls(null); setHikHlsCopied(false) }}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="label">Canal</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={999}
                  value={hikChannel}
                  onChange={(e) => { setHikChannel(e.target.value); setHikHls(null); setHikHlsCopied(false) }}
                />
              </div>
            </div>
            <button
              className="btn-secondary text-xs"
              disabled={hikSerial.trim() === '' || busyHik === 'hls'}
              onClick={() => runHik(
                'hls',
                () => hikConnectApi.getHls({
                  deviceSerial: hikSerial.trim(),
                  ...(hikChannel.trim() !== '' ? { channelNo: Number(hikChannel) } : {}),
                }),
                setHikHls,
              )}
            >
              {busyHik === 'hls' ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
              Obtener URL HLS
            </button>
            {hikHls && (
              <>
                <div className="flex items-center gap-2 rounded-lg bg-surface-900 border border-surface-600 p-2">
                  <code className="flex-1 text-xs text-surface-200 break-all font-mono">{hikHls.url}</code>
                  <button className="btn-ghost p-1.5" onClick={copyHikHls} title="Copiar">
                    {hikHlsCopied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                  </button>
                </div>
                <p className="text-xs text-surface-500">
                  URL efímera (TTL {hikHls.ttlSec}s). Se muestra sólo para copiarla; no se almacena. Se limpia al
                  cambiar de serial o canal.
                </p>
              </>
            )}
          </Section>

          {/* Tester ISAPI-proxy avanzado */}
          <Section icon={<Terminal size={15} />} title="ISAPI-proxy (avanzado)">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label className="label">Método</label>
                <select
                  className="input text-xs"
                  value={isapiMethod}
                  onChange={(e) => setIsapiMethod(e.target.value as HikConnectIsapiMethod)}
                >
                  {(['GET', 'POST', 'PUT', 'DELETE'] as const).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="label">isapiPath</label>
                <input
                  className="input font-mono"
                  placeholder="/ISAPI/System/deviceInfo"
                  value={isapiPath}
                  onChange={(e) => { setIsapiPath(e.target.value); setIsapiResult(null) }}
                  autoComplete="off"
                />
              </div>
            </div>
            <div>
              <label className="label">Body (opcional)</label>
              <textarea
                className="input font-mono text-xs min-h-[72px]"
                placeholder="Cuerpo crudo (XML/JSON) para POST/PUT"
                value={isapiBody}
                onChange={(e) => setIsapiBody(e.target.value)}
                autoComplete="off"
              />
            </div>
            <button
              className="btn-secondary text-xs"
              disabled={hikSerial.trim() === '' || isapiPath.trim() === '' || busyHik === 'isapi'}
              onClick={() => runHik(
                'isapi',
                () => hikConnectApi.proxyIsapi({
                  deviceSerial: hikSerial.trim(),
                  method: isapiMethod,
                  isapiPath: isapiPath.trim(),
                  ...(isapiBody.trim() !== '' ? { body: isapiBody } : {}),
                }),
                (r) => setIsapiResult(
                  typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2),
                ),
              )}
            >
              {busyHik === 'isapi' ? <Loader2 size={13} className="animate-spin" /> : <Terminal size={13} />}
              Enviar
            </button>
            <p className="text-xs text-surface-500">
              El path debe comenzar por <code className="font-mono text-surface-300">/ISAPI/</code>. Usa el serial
              del bloque HLS. El destino se fija al areaDomain validado en el servidor (anti-SSRF).
            </p>
            {isapiResult !== null && (
              <>
                <pre className="rounded-lg bg-surface-900 border border-surface-600 p-2 text-xs text-surface-200 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                  {isapiResult}
                </pre>
                <p className="text-xs text-surface-500">Respuesta transitoria; no se almacena ni loguea.</p>
              </>
            )}
          </Section>
        </fieldset>
      </div>
    </div>
  )
}

export default IntegrationsPage
