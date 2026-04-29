// src/pages/SettingsPage.tsx
import { useState } from 'react'
import {
  Bell, Video, Shield, Server, Globe, Save, RefreshCw,
  Mail, Webhook, CheckCircle2
} from 'lucide-react'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'

type Tab = 'alertas' | 'streaming' | 'seguridad' | 'sistema' | 'integraciones'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'alertas',       label: 'Alertas',       icon: <Bell size={14} /> },
  { id: 'streaming',     label: 'Streaming',     icon: <Video size={14} /> },
  { id: 'seguridad',     label: 'Seguridad',     icon: <Shield size={14} /> },
  { id: 'sistema',       label: 'Sistema',       icon: <Server size={14} /> },
  { id: 'integraciones', label: 'Integraciones', icon: <Globe size={14} /> },
]

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('alertas')
  const [saving, setSaving] = useState(false)

  // Estado de alertas
  const [alertEmail, setAlertEmail] = useState('')
  const [alertWebhook, setAlertWebhook] = useState('')
  const [alertNVROff, setAlertNVROff] = useState(true)
  const [alertCamOff, setAlertCamOff] = useState(true)
  const [alertHDDFull, setAlertHDDFull] = useState(true)
  const [hddThreshold, setHddThreshold] = useState(90)

  // Estado streaming
  const [hlsLatency, setHlsLatency] = useState('low')
  const [streamQuality, setStreamQuality] = useState('main')
  const [onDemandTimeout, setOnDemandTimeout] = useState(30)

  // Estado seguridad
  const [sessionTimeout, setSessionTimeout] = useState(15)
  const [maxSessions, setMaxSessions] = useState(5)
  const [requireStrongPassword, setRequireStrongPassword] = useState(true)

  // Estado sistema
  const [timezone, setTimezone] = useState('America/Asuncion')
  const [dateFormat, setDateFormat] = useState('dd/MM/yyyy')
  const [language, setLanguage] = useState('es')

  const handleSave = async () => {
    setSaving(true)
    await new Promise((r) => setTimeout(r, 800))
    setSaving(false)
    toast.success('Configuración guardada')
  }

  const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-surface-200">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={clsx(
          'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
          value ? 'bg-brand-600' : 'bg-surface-600'
        )}
      >
        <span className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          value ? 'translate-x-5' : 'translate-x-0.5'
        )} />
      </button>
    </div>
  )

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div>
        <h2 className="text-base font-semibold text-surface-100">Configuración del sistema</h2>
        <p className="text-xs text-surface-400 mt-0.5">Ajustes globales de VisionCore VMS</p>
      </div>

      <div className="flex gap-4">
        {/* Sidebar de tabs */}
        <div className="w-44 flex-shrink-0">
          <nav className="space-y-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
                  tab === t.id
                    ? 'bg-surface-700 text-surface-50'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/50'
                )}
              >
                <span className="w-4 h-4 flex-shrink-0">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Contenido */}
        <div className="flex-1 card p-5 space-y-5">
          {/* ── ALERTAS ── */}
          {tab === 'alertas' && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-surface-100 mb-4">Notificaciones de alertas</h3>
                <div className="space-y-4">
                  <div>
                    <label className="label">Email para notificaciones</label>
                    <div className="relative">
                      <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                      <input
                        className="input pl-9"
                        type="email"
                        placeholder="alertas@empresa.com"
                        value={alertEmail}
                        onChange={(e) => setAlertEmail(e.target.value)}
                      />
                    </div>
                    <p className="text-xs text-surface-500 mt-1">Las alertas críticas se enviarán a este email.</p>
                  </div>

                  <div>
                    <label className="label">Webhook URL</label>
                    <div className="relative">
                      <Webhook size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                      <input
                        className="input pl-9"
                        type="url"
                        placeholder="https://hooks.slack.com/..."
                        value={alertWebhook}
                        onChange={(e) => setAlertWebhook(e.target.value)}
                      />
                    </div>
                    <p className="text-xs text-surface-500 mt-1">Compatible con Slack, Teams, Discord, n8n, etc.</p>
                  </div>
                </div>
              </div>

              <div className="border-t border-surface-600 pt-4">
                <h4 className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-3">Tipos de alerta activos</h4>
                <div className="divide-y divide-surface-700">
                  <Toggle value={alertNVROff} onChange={setAlertNVROff} label="NVR desconectado" />
                  <Toggle value={alertCamOff} onChange={setAlertCamOff} label="Cámara offline" />
                  <Toggle value={alertHDDFull} onChange={setAlertHDDFull} label="HDD casi lleno" />
                </div>
              </div>

              <div className="border-t border-surface-600 pt-4">
                <label className="label">Umbral de HDD lleno (%)</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={50}
                    max={99}
                    value={hddThreshold}
                    onChange={(e) => setHddThreshold(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className={clsx(
                    'text-sm font-medium w-10 text-right',
                    hddThreshold >= 90 ? 'text-red-400' : hddThreshold >= 75 ? 'text-amber-400' : 'text-green-400'
                  )}>{hddThreshold}%</span>
                </div>
              </div>
            </>
          )}

          {/* ── STREAMING ── */}
          {tab === 'streaming' && (
            <>
              <h3 className="text-sm font-semibold text-surface-100 mb-4">Configuración de streaming</h3>
              <div className="space-y-4">
                <div>
                  <label className="label">Modo de latencia HLS</label>
                  <select
                    value={hlsLatency}
                    onChange={(e) => setHlsLatency(e.target.value)}
                    className="input"
                  >
                    <option value="low">Baja latencia (2-4 seg) — recomendado</option>
                    <option value="normal">Normal (6-10 seg)</option>
                    <option value="high">Alta (15-30 seg) — mejor estabilidad</option>
                  </select>
                </div>

                <div>
                  <label className="label">Calidad de stream por defecto</label>
                  <select
                    value={streamQuality}
                    onChange={(e) => setStreamQuality(e.target.value)}
                    className="input"
                  >
                    <option value="main">Principal (alta calidad)</option>
                    <option value="sub">Sub-stream (menor ancho de banda)</option>
                  </select>
                </div>

                <div>
                  <label className="label">Timeout sin viewers (segundos)</label>
                  <input
                    type="number"
                    min={10}
                    max={300}
                    value={onDemandTimeout}
                    onChange={(e) => setOnDemandTimeout(Number(e.target.value))}
                    className="input max-w-xs"
                  />
                  <p className="text-xs text-surface-500 mt-1">
                    Tiempo antes de cerrar un stream si nadie lo está viendo.
                  </p>
                </div>

                <div className="p-3 bg-surface-900 rounded-lg">
                  <p className="text-xs text-surface-400 mb-2 font-medium">Estado de MediaMTX</p>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-green-400" />
                    <span className="text-xs text-green-400">Proxy de video activo (puerto 8888/8889)</span>
                  </div>
                  <p className="text-xs text-surface-500 mt-1">
                    Los streams RTSP se convierten a HLS automáticamente bajo demanda.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ── SEGURIDAD ── */}
          {tab === 'seguridad' && (
            <>
              <h3 className="text-sm font-semibold text-surface-100 mb-4">Seguridad y sesiones</h3>
              <div className="space-y-4">
                <div>
                  <label className="label">Tiempo de expiración de token (minutos)</label>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    value={sessionTimeout}
                    onChange={(e) => setSessionTimeout(Number(e.target.value))}
                    className="input max-w-xs"
                  />
                  <p className="text-xs text-surface-500 mt-1">
                    El token de acceso expira pasado este tiempo. Requiere rebuild del API para aplicar.
                  </p>
                </div>

                <div>
                  <label className="label">Máximo de sesiones simultáneas por usuario</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={maxSessions}
                    onChange={(e) => setMaxSessions(Number(e.target.value))}
                    className="input max-w-xs"
                  />
                </div>

                <div className="border-t border-surface-600 pt-4">
                  <div className="divide-y divide-surface-700">
                    <Toggle
                      value={requireStrongPassword}
                      onChange={setRequireStrongPassword}
                      label="Exigir contraseñas seguras (8+ chars, mayúscula, número)"
                    />
                  </div>
                </div>

                <div className="p-3 bg-amber-900/20 border border-amber-800/40 rounded-lg">
                  <p className="text-xs text-amber-400 font-medium mb-1">Importante</p>
                  <p className="text-xs text-surface-400">
                    Las contraseñas de NVR se almacenan cifradas con AES usando el JWT_SECRET del servidor.
                    Si rotas el JWT_SECRET, deberás re-ingresar las contraseñas de cada NVR.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ── SISTEMA ── */}
          {tab === 'sistema' && (
            <>
              <h3 className="text-sm font-semibold text-surface-100 mb-4">Configuración del sistema</h3>
              <div className="space-y-4">
                <div>
                  <label className="label">Zona horaria</label>
                  <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="input">
                    <option value="America/Asuncion">America/Asuncion (Paraguay)</option>
                    <option value="America/Argentina/Buenos_Aires">America/Argentina/Buenos_Aires</option>
                    <option value="America/Sao_Paulo">America/Sao_Paulo</option>
                    <option value="America/Lima">America/Lima</option>
                    <option value="America/Bogota">America/Bogota</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>

                <div>
                  <label className="label">Formato de fecha</label>
                  <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} className="input">
                    <option value="dd/MM/yyyy">DD/MM/AAAA (29/04/2026)</option>
                    <option value="MM/dd/yyyy">MM/DD/AAAA (04/29/2026)</option>
                    <option value="yyyy-MM-dd">AAAA-MM-DD (2026-04-29)</option>
                  </select>
                </div>

                <div className="border-t border-surface-600 pt-4 space-y-2">
                  <p className="text-xs font-medium text-surface-400 uppercase tracking-wider">Información del sistema</p>
                  {[
                    { label: 'Versión VisionCore', value: 'VMS v1.0' },
                    { label: 'Base de datos', value: 'PostgreSQL 16' },
                    { label: 'Proxy de video', value: 'MediaMTX' },
                    { label: 'Protocolo NVR', value: 'Hikvision ISAPI' },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between items-center py-1.5 text-xs border-b border-surface-700">
                      <span className="text-surface-400">{label}</span>
                      <span className="text-surface-200 font-mono">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── INTEGRACIONES ── */}
          {tab === 'integraciones' && (
            <>
              <h3 className="text-sm font-semibold text-surface-100 mb-4">Integraciones externas</h3>
              <div className="space-y-4">
                <div className="p-4 border border-surface-600 rounded-lg space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-[#4A154B] rounded-lg flex items-center justify-center">
                      <span className="text-white text-xs font-bold">S</span>
                    </div>
                    <div>
                      <div className="text-sm font-medium text-surface-100">Slack</div>
                      <div className="text-xs text-surface-400">Enviar alertas a un canal de Slack</div>
                    </div>
                  </div>
                  <input className="input text-xs" placeholder="https://hooks.slack.com/services/..." />
                  <p className="text-xs text-surface-500">Crea un Incoming Webhook en tu workspace de Slack.</p>
                </div>

                <div className="p-4 border border-surface-600 rounded-lg space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-[#0078D4] rounded-lg flex items-center justify-center">
                      <span className="text-white text-xs font-bold">T</span>
                    </div>
                    <div>
                      <div className="text-sm font-medium text-surface-100">Microsoft Teams</div>
                      <div className="text-xs text-surface-400">Notificaciones en un canal de Teams</div>
                    </div>
                  </div>
                  <input className="input text-xs" placeholder="https://outlook.office.com/webhook/..." />
                </div>

                <div className="p-4 border border-surface-600 rounded-lg space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-surface-700 rounded-lg flex items-center justify-center">
                      <Globe size={14} className="text-surface-300" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-surface-100">Webhook genérico (HTTP POST)</div>
                      <div className="text-xs text-surface-400">Compatible con n8n, Zapier, IFTTT y cualquier sistema</div>
                    </div>
                  </div>
                  <input className="input text-xs" placeholder="https://tu-servidor.com/webhook/alertas" />
                  <p className="text-xs text-surface-500">
                    Recibirás un POST JSON con: type, severity, message, nvrId, cameraId, timestamp.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* Botón guardar */}
          <div className="border-t border-surface-600 pt-4 flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary"
            >
              {saving ? (
                <><RefreshCw size={13} className="animate-spin" /> Guardando...</>
              ) : (
                <><Save size={13} /> Guardar cambios</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
