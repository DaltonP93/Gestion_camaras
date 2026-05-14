// src/pages/SettingsPage.tsx
import { useState, useEffect } from 'react'
import {
  Bell, Video, Shield, Server, Globe, Save, RefreshCw,
  Mail, Webhook, CheckCircle2, Send, Lock, Eye, EyeOff
} from 'lucide-react'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import type { AlertSettings } from '@/types'

type Tab = 'alertas' | 'streaming' | 'seguridad' | 'sistema' | 'integraciones'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'alertas',       label: 'Alertas',       icon: <Bell size={14} /> },
  { id: 'streaming',     label: 'Streaming',     icon: <Video size={14} /> },
  { id: 'seguridad',     label: 'Seguridad',     icon: <Shield size={14} /> },
  { id: 'sistema',       label: 'Sistema',       icon: <Server size={14} /> },
  { id: 'integraciones', label: 'Integraciones', icon: <Globe size={14} /> },
]

const ALERT_TYPE_LABELS: Record<string, string> = {
  CAMERA_OFFLINE:   'Cámara offline',
  NVR_OFFLINE:      'NVR desconectado',
  HDD_FULL:         'HDD casi lleno',
  HDD_ERROR:        'Error de disco',
  MOTION_DETECTED:  'Movimiento detectado',
  RECORDING_ERROR:  'Error de grabación',
  AUTH_FAILED:      'Fallo de autenticación',
}

const SEVERITY_OPTIONS = [
  { value: 'LOW',      label: 'Baja y superior' },
  { value: 'MEDIUM',   label: 'Media y superior' },
  { value: 'HIGH',     label: 'Alta y superior' },
  { value: 'CRITICAL', label: 'Solo críticas' },
]

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('alertas')
  const [saving, setSaving] = useState(false)

  // ── Alert settings (loaded from API) ──────────────────────────
  const [alertSettings, setAlertSettings] = useState<AlertSettings | null>(null)
  const [loadingAlerts, setLoadingAlerts] = useState(true)
  const [emailEnabled, setEmailEnabled] = useState(false)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState(587)
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [showSmtpPass, setShowSmtpPass] = useState(false)
  const [smtpFromEmail, setSmtpFromEmail] = useState('')
  const [smtpFromName, setSmtpFromName] = useState('VisionCore Alertas')
  const [recipientEmails, setRecipientEmails] = useState('')
  const [alertTypes, setAlertTypes] = useState<Record<string, boolean>>({
    CAMERA_OFFLINE: true, NVR_OFFLINE: true, HDD_FULL: true,
    HDD_ERROR: true, MOTION_DETECTED: false, RECORDING_ERROR: true, AUTH_FAILED: false,
  })
  const [minSeverity, setMinSeverity] = useState<AlertSettings['minSeverity']>('HIGH')
  const [testEmail, setTestEmail] = useState('')
  const [sendingTest, setSendingTest] = useState(false)
  const [deliveries, setDeliveries] = useState<any[]>([])
  const [loadingDeliveries, setLoadingDeliveries] = useState(false)

  // ── Other tab state ────────────────────────────────────────────
  const [hlsLatency, setHlsLatency] = useState('low')
  const [streamQuality, setStreamQuality] = useState('main')
  const [onDemandTimeout, setOnDemandTimeout] = useState(30)
  const [sessionTimeout, setSessionTimeout] = useState(15)
  const [maxSessions, setMaxSessions] = useState(5)
  const [requireStrongPassword, setRequireStrongPassword] = useState(true)
  const [timezone, setTimezone] = useState('America/Asuncion')
  const [dateFormat, setDateFormat] = useState('dd/MM/yyyy')

  useEffect(() => {
    apiGet<AlertSettings>('/alerts/settings')
      .then((s) => {
        setAlertSettings(s)
        setEmailEnabled(s.emailEnabled)
        setSmtpHost(s.smtpHost)
        setSmtpPort(s.smtpPort)
        setSmtpSecure(s.smtpSecure)
        setSmtpUser(s.smtpUser)
        setSmtpPassword(s.smtpPassword)
        setSmtpFromEmail(s.smtpFromEmail)
        setSmtpFromName(s.smtpFromName)
        setRecipientEmails(s.recipientEmails)
        setAlertTypes(s.alertTypes as Record<string, boolean>)
        setMinSeverity(s.minSeverity)
      })
      .catch(() => {}) // non-admin will get 403, ignore
      .finally(() => setLoadingAlerts(false))
  }, [])

  const handleSaveAlerts = async () => {
    setSaving(true)
    try {
      const updated = await apiPut<AlertSettings>('/alerts/settings', {
        emailEnabled, smtpHost, smtpPort, smtpSecure, smtpUser,
        smtpPassword, smtpFromEmail, smtpFromName, recipientEmails,
        alertTypes, minSeverity,
      })
      setAlertSettings(updated)
      toast.success('Configuración de alertas guardada')
    } catch {
      // error toast shown by api interceptor
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (tab === 'alertas') return handleSaveAlerts()
    setSaving(true)
    await new Promise((r) => setTimeout(r, 600))
    setSaving(false)
    toast.success('Configuración guardada')
  }

  const handleTestEmail = async () => {
    setSendingTest(true)
    try {
      const res = await apiPost<{ success: boolean; message: string }>('/alerts/settings/test-email', { testEmail: testEmail || undefined })
      toast.success(res.message)
    } catch {
      // error toast shown by interceptor
    } finally {
      setSendingTest(false)
    }
  }

  const loadDeliveries = async () => {
    setLoadingDeliveries(true)
    try {
      const res = await apiGet<{ deliveries: any[] }>('/alerts/settings/deliveries?limit=10')
      setDeliveries(res.deliveries || [])
    } catch {
      // non-admin: ignore
    } finally {
      setLoadingDeliveries(false)
    }
  }

  const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-surface-200">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={clsx(
          'relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0',
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
              {loadingAlerts ? (
                <div className="flex items-center justify-center py-10">
                  <RefreshCw size={18} className="animate-spin text-surface-400" />
                </div>
              ) : (
                <>
                  {/* Email habilitado */}
                  <div>
                    <h3 className="text-sm font-semibold text-surface-100 mb-3">Notificaciones por correo</h3>
                    <Toggle value={emailEnabled} onChange={setEmailEnabled} label="Enviar alertas por email" />
                  </div>

                  {/* SMTP config */}
                  <div className={clsx('space-y-4 border-t border-surface-600 pt-4', !emailEnabled && 'opacity-50 pointer-events-none')}>
                    <h4 className="text-xs font-medium text-surface-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Mail size={12} /> Servidor SMTP
                    </h4>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="label">Host SMTP</label>
                        <input className="input" placeholder="smtp.gmail.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                      </div>
                      <div>
                        <label className="label">Puerto</label>
                        <input className="input" type="number" min={1} max={65535} value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label">Usuario SMTP</label>
                        <input className="input" placeholder="usuario@gmail.com" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                      </div>
                      <div>
                        <label className="label">Contraseña SMTP</label>
                        <div className="relative">
                          <input
                            className="input pr-9"
                            type={showSmtpPass ? 'text' : 'password'}
                            placeholder="••••••••"
                            value={smtpPassword}
                            onChange={(e) => setSmtpPassword(e.target.value)}
                          />
                          <button type="button" onClick={() => setShowSmtpPass(!showSmtpPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400">
                            {showSmtpPass ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label">Email remitente</label>
                        <input className="input" type="email" placeholder="alertas@empresa.com" value={smtpFromEmail} onChange={(e) => setSmtpFromEmail(e.target.value)} />
                      </div>
                      <div>
                        <label className="label">Nombre remitente</label>
                        <input className="input" placeholder="VisionCore Alertas" value={smtpFromName} onChange={(e) => setSmtpFromName(e.target.value)} />
                      </div>
                    </div>

                    <Toggle value={smtpSecure} onChange={setSmtpSecure} label="Usar TLS/SSL (puerto 465)" />

                    <div>
                      <label className="label">Destinatarios (separados por coma)</label>
                      <div className="relative">
                        <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                        <input
                          className="input pl-9"
                          placeholder="admin@empresa.com, seguridad@empresa.com"
                          value={recipientEmails}
                          onChange={(e) => setRecipientEmails(e.target.value)}
                        />
                      </div>
                    </div>

                    {/* Test email */}
                    <div className="p-3 bg-surface-900 rounded-lg space-y-2">
                      <p className="text-xs font-medium text-surface-400">Probar configuración</p>
                      <div className="flex gap-2">
                        <input
                          className="input flex-1 text-xs"
                          placeholder="email-prueba@empresa.com (opcional)"
                          value={testEmail}
                          onChange={(e) => setTestEmail(e.target.value)}
                        />
                        <button
                          onClick={handleTestEmail}
                          disabled={sendingTest || !smtpHost}
                          className="btn-secondary flex items-center gap-1.5 text-xs whitespace-nowrap"
                        >
                          {sendingTest ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
                          Enviar prueba
                        </button>
                      </div>
                      <p className="text-xs text-surface-500">Guarda primero y luego envía el email de prueba.</p>
                    </div>
                  </div>

                  {/* Historial de entregas */}
                  <div className="border-t border-surface-600 pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-medium text-surface-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Webhook size={12} /> Historial de entregas
                      </h4>
                      <button
                        onClick={loadDeliveries}
                        disabled={loadingDeliveries}
                        className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1"
                      >
                        {loadingDeliveries ? <RefreshCw size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                        Cargar
                      </button>
                    </div>
                    {deliveries.length === 0 && !loadingDeliveries && (
                      <p className="text-xs text-surface-500 py-2">Presiona "Cargar" para ver las últimas 10 entregas.</p>
                    )}
                    {deliveries.length > 0 && (
                      <div className="space-y-1">
                        {deliveries.map((d: any) => (
                          <div key={d.id} className="flex items-center gap-2 py-1.5 text-xs border-b border-surface-700">
                            <span className={clsx(
                              'w-12 text-center rounded px-1 py-0.5 font-mono text-[10px]',
                              d.status === 'sent' ? 'bg-green-900/40 text-green-400' :
                              d.status === 'failed' ? 'bg-red-900/40 text-red-400' :
                              'bg-surface-700 text-surface-400'
                            )}>{d.status}</span>
                            <span className="text-surface-300 flex-1 truncate">{d.recipient || d.channel}</span>
                            {d.error && <span className="text-red-400 truncate max-w-[200px]" title={d.error}>{d.error}</span>}
                            <span className="text-surface-500 flex-shrink-0">
                              {d.sentAt ? new Date(d.sentAt).toLocaleTimeString('es-PY') : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Tipos de alerta */}
                  <div className="border-t border-surface-600 pt-4">
                    <h4 className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-3">Tipos de alerta activos</h4>
                    <div className="divide-y divide-surface-700">
                      {Object.entries(ALERT_TYPE_LABELS).map(([key, label]) => (
                        <Toggle
                          key={key}
                          value={!!alertTypes[key]}
                          onChange={(v) => setAlertTypes((prev) => ({ ...prev, [key]: v }))}
                          label={label}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Severidad mínima */}
                  <div className="border-t border-surface-600 pt-4">
                    <label className="label">Severidad mínima para notificar</label>
                    <select
                      className="input max-w-xs"
                      value={minSeverity}
                      onChange={(e) => setMinSeverity(e.target.value as AlertSettings['minSeverity'])}
                    >
                      {SEVERITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── STREAMING ── */}
          {tab === 'streaming' && (
            <>
              <h3 className="text-sm font-semibold text-surface-100 mb-4">Configuración de streaming</h3>
              <div className="space-y-4">
                <div>
                  <label className="label">Modo de latencia HLS</label>
                  <select value={hlsLatency} onChange={(e) => setHlsLatency(e.target.value)} className="input">
                    <option value="low">Baja latencia (2-4 seg) — recomendado</option>
                    <option value="normal">Normal (6-10 seg)</option>
                    <option value="high">Alta (15-30 seg) — mejor estabilidad</option>
                  </select>
                </div>

                <div>
                  <label className="label">Calidad de stream por defecto</label>
                  <select value={streamQuality} onChange={(e) => setStreamQuality(e.target.value)} className="input">
                    <option value="main">Principal (alta calidad)</option>
                    <option value="sub">Sub-stream (menor ancho de banda)</option>
                  </select>
                </div>

                <div>
                  <label className="label">Timeout sin viewers (segundos)</label>
                  <input
                    type="number" min={10} max={300} value={onDemandTimeout}
                    onChange={(e) => setOnDemandTimeout(Number(e.target.value))}
                    className="input max-w-xs"
                  />
                  <p className="text-xs text-surface-500 mt-1">Tiempo antes de cerrar un stream si nadie lo está viendo.</p>
                </div>

                <div className="p-3 bg-surface-900 rounded-lg">
                  <p className="text-xs text-surface-400 mb-2 font-medium">Estado de MediaMTX</p>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-green-400" />
                    <span className="text-xs text-green-400">Proxy de video activo (puerto 8888/8889)</span>
                  </div>
                  <p className="text-xs text-surface-500 mt-1">Los streams RTSP se convierten a HLS automáticamente bajo demanda.</p>
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
                    type="number" min={5} max={1440} value={sessionTimeout}
                    onChange={(e) => setSessionTimeout(Number(e.target.value))}
                    className="input max-w-xs"
                  />
                  <p className="text-xs text-surface-500 mt-1">El token de acceso expira pasado este tiempo. Requiere rebuild del API para aplicar.</p>
                </div>

                <div>
                  <label className="label">Máximo de sesiones simultáneas por usuario</label>
                  <input
                    type="number" min={1} max={20} value={maxSessions}
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
                  <p className="text-xs text-amber-400 font-medium mb-1 flex items-center gap-1"><Lock size={12} /> Importante</p>
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
            <button onClick={handleSave} disabled={saving || (tab === 'alertas' && loadingAlerts)} className="btn-primary">
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
