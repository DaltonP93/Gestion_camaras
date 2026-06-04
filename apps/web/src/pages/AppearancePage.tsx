// src/pages/AppearancePage.tsx
import { useEffect, useRef, useState } from 'react'
import {
  Save, RotateCcw, Shield, Moon, Sun,
  SidebarOpen, Eye, Code2, Check, Image, AlertTriangle, Upload,
} from 'lucide-react'
import { apiGet, apiPut, apiUpload, resolveAssetUrl } from '@/lib/api'
import { useAppearanceStore } from '@/stores/appearanceStore'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'
import type { AppearanceSettings } from '@/types'
import { invalidateAppearanceCache, applyAppearanceToDocument } from '@/hooks/useAppearance'

// ─── Constants ───────────────────────────────────────────────
const THEMES = [
  { value: 'dark',     label: 'Oscuro',      description: 'Fondo gris oscuro clásico',       bg: '#1e2130', surface: '#2a2e42' },
  { value: 'darker',   label: 'Más oscuro',  description: 'Fondo casi negro',                 bg: '#111318', surface: '#1a1d26' },
  { value: 'midnight', label: 'Medianoche',  description: 'Negro puro con bordes sutiles',    bg: '#090a0e', surface: '#12141c' },
] as const

const COLOR_PRESETS = [
  { label: 'Rojo',    primary: '#e51d1d', accent: '#c41616' },
  { label: 'Azul',    primary: '#2563eb', accent: '#1d4ed8' },
  { label: 'Verde',   primary: '#16a34a', accent: '#15803d' },
  { label: 'Violeta', primary: '#7c3aed', accent: '#6d28d9' },
  { label: 'Naranja', primary: '#ea580c', accent: '#c2410c' },
  { label: 'Cian',    primary: '#0891b2', accent: '#0e7490' },
]

const DEFAULTS: AppearanceSettings = {
  id:               'singleton',
  siteName:         'VisionCore',
  logoText:         'VisionCore',
  primaryColor:     '#e51d1d',
  accentColor:      '#c41616',
  theme:            'dark',
  sidebarWidth:     'normal',
  showNVRsInSidebar: true,
  customCss:        '',
  logoUrl:          '',
  sidebarLogoUrl:   '',
  faviconUrl:       '',
  updatedAt:        '',
}

// ─── Sub-components ───────────────────────────────────────────

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2 mt-1">
        <div
          className="w-8 h-8 rounded-lg border border-surface-600 cursor-pointer flex-shrink-0 overflow-hidden"
          style={{ backgroundColor: value }}
        >
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="opacity-0 w-full h-full cursor-pointer"
          />
        </div>
        <input
          type="text"
          className="input flex-1 font-mono text-xs uppercase"
          value={value.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v)
          }}
          maxLength={7}
        />
      </div>
    </div>
  )
}

function ImageUrlInput({
  label,
  hint,
  value,
  onChange,
  previewClass = 'h-8',
  fieldName,
  onUpload,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  previewClass?: string
  fieldName?: string
  onUpload?: (url: string) => void
}) {
  const [imgError, setImgError] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resolvedValue = resolveAssetUrl(value) || value
  const showPreview = !!value && !imgError

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !fieldName || !onUpload) return

    const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon']
    if (!ALLOWED.includes(file.type)) {
      toast.error('Formato no permitido. Use PNG, JPG, WebP, SVG o ICO.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('El archivo no puede superar 2 MB')
      return
    }

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append(fieldName, file)
      const result = await apiUpload<AppearanceSettings>('/appearance/upload', fd)
      const url = fieldName === 'favicon' ? result.faviconUrl :
                  fieldName === 'sidebarLogo' ? result.sidebarLogoUrl : result.logoUrl
      if (url) {
        onUpload(url)
        setImgError(false)
        toast.success('Imagen subida')
      }
    } catch {
      toast.error('Error al subir la imagen')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div>
      <label className="label">{label}</label>
      {hint && <p className="text-xs text-surface-500 mb-1">{hint}</p>}
      <div className="flex items-center gap-2">
        {showPreview ? (
          <img
            src={resolvedValue}
            alt="preview"
            className={clsx('object-contain flex-shrink-0 rounded', previewClass)}
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-8 h-8 rounded border border-surface-600 bg-surface-700 flex items-center justify-center flex-shrink-0">
            <Image size={14} className="text-surface-500" />
          </div>
        )}
        <input
          type="url"
          className="input flex-1 text-xs"
          placeholder="https://ejemplo.com/logo.png"
          value={value}
          onChange={(e) => {
            setImgError(false)
            onChange(e.target.value)
          }}
        />
        {fieldName && onUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex-shrink-0 px-2 py-1.5 rounded-lg bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600 transition-colors text-xs disabled:opacity-50"
              title="Subir archivo"
            >
              {uploading ? '…' : <Upload size={12} />}
            </button>
          </>
        )}
        {value && (
          <button
            type="button"
            onClick={() => { onChange(''); setImgError(false) }}
            className="text-surface-400 hover:text-surface-200 text-xs px-1 flex-shrink-0"
            title="Limpiar"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

function PreviewCard({ settings }: { settings: AppearanceSettings }) {
  const theme = THEMES.find((t) => t.value === settings.theme) ?? THEMES[0]

  return (
    <div
      className="rounded-xl overflow-hidden border border-surface-600 flex"
      style={{ backgroundColor: theme.bg, minHeight: 200 }}
    >
      {/* Sidebar */}
      <div
        className="flex flex-col py-3 px-2 gap-2 border-r flex-shrink-0"
        style={{
          width: settings.sidebarWidth === 'compact' ? 48 : 56,
          borderColor: theme.surface,
          backgroundColor: theme.surface,
        }}
      >
        <div className="mx-auto flex-shrink-0">
          {settings.sidebarLogoUrl ? (
            <img
              src={resolveAssetUrl(settings.sidebarLogoUrl) || settings.sidebarLogoUrl}
              alt="logo"
              className="w-7 h-7 object-contain rounded"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div
              className="w-6 h-6 rounded-md flex items-center justify-center"
              style={{ backgroundColor: settings.primaryColor }}
            >
              <Shield size={10} className="text-white" />
            </div>
          )}
        </div>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-2 rounded mx-1"
            style={{
              backgroundColor: i === 1 ? settings.primaryColor + '80' : theme.bg + 'cc',
              opacity: i === 1 ? 1 : 0.5,
            }}
          />
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          {settings.logoUrl && (
            <img
              src={resolveAssetUrl(settings.logoUrl) || settings.logoUrl}
              alt="logo"
              className="h-4 object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          )}
          <span className="text-xs font-medium" style={{ color: '#e5e7eb' }}>
            {settings.siteName}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-10 rounded-lg" style={{ backgroundColor: theme.surface }}>
              {i === 1 && (
                <div
                  className="h-full rounded-lg border-l-2"
                  style={{ borderColor: settings.primaryColor }}
                />
              )}
            </div>
          ))}
        </div>
        <div className="h-1.5 rounded-full w-2/3" style={{ backgroundColor: settings.primaryColor, opacity: 0.8 }} />
      </div>
    </div>
  )
}

// ─── Apply appearance settings to the live document ──────────
function applyAppearance(s: AppearanceSettings) {
  // Page title
  if (s.siteName) document.title = s.siteName

  // Favicon
  const resolvedFavicon = resolveAssetUrl(s.faviconUrl)
  if (resolvedFavicon) {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
    link.href = resolvedFavicon
  }

  // Custom CSS injection
  const styleId = 'visioncore-custom-css'
  let style = document.getElementById(styleId) as HTMLStyleElement | null
  if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style) }
  style.textContent = s.customCss || ''

  // CSS variables for primary/accent colors (override Tailwind brand palette)
  const root = document.documentElement
  if (s.primaryColor) {
    root.style.setProperty('--brand-500', s.primaryColor)
    root.style.setProperty('--brand-600', s.accentColor || s.primaryColor)
  }
}

// ─── Main component ───────────────────────────────────────────
type Tab = 'branding' | 'apariencia' | 'sidebar' | 'advanced'

export function AppearancePage() {
  const { apply: applyGlobal } = useAppearanceStore()
  const [settings, setSettings]   = useState<AppearanceSettings>(DEFAULTS)
  const [saved, setSaved]         = useState<AppearanceSettings>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving]   = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('branding')
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    apiGet<AppearanceSettings>('/appearance')
      .then((data) => {
        const clean: AppearanceSettings = {
          ...DEFAULTS,
          ...data,
          customCss:      data.customCss      ?? '',
          logoUrl:        data.logoUrl        ?? '',
          sidebarLogoUrl: data.sidebarLogoUrl ?? '',
          faviconUrl:     data.faviconUrl     ?? '',
        }
        setSettings(clean)
        setSaved(clean)
        applyAppearance(clean)
      })
      .finally(() => setIsLoading(false))
  }, [])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const updated = await apiPut<AppearanceSettings>('/appearance', settings)
      setSaved(updated)
      setSettings(updated)
      invalidateAppearanceCache()
      applyAppearanceToDocument(updated)
      toast.success('Apariencia guardada')
    } catch {
      toast.error('Error al guardar apariencia')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDiscard = () => {
    setSettings(saved)
    setConfirmReset(false)
    toast('Cambios descartados', { icon: 'ℹ️' })
  }

  const handleRestoreDefaults = async () => {
    setIsSaving(true)
    setConfirmReset(false)
    try {
      const updated = await apiPut<AppearanceSettings>('/appearance', {
        siteName:          DEFAULTS.siteName,
        logoText:          DEFAULTS.logoText,
        primaryColor:      DEFAULTS.primaryColor,
        accentColor:       DEFAULTS.accentColor,
        theme:             DEFAULTS.theme,
        sidebarWidth:      DEFAULTS.sidebarWidth,
        showNVRsInSidebar: DEFAULTS.showNVRsInSidebar,
        customCss:         '',
        logoUrl:           '',
        sidebarLogoUrl:    '',
        faviconUrl:        '',
      })
      const clean: AppearanceSettings = { ...DEFAULTS, ...updated, customCss: '', logoUrl: '', sidebarLogoUrl: '', faviconUrl: '' }
      setSaved(clean)
      setSettings(clean)
      toast.success('Valores restaurados a predeterminados')
    } catch {
      toast.error('Error al restaurar valores')
    } finally {
      setIsSaving(false)
    }
  }

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(saved)
  const set = <K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  // Basic CSS safety check — warn about expression() / javascript: patterns
  const cssWarning = settings.customCss
    ? /expression\s*\(|javascript\s*:/i.test(settings.customCss)
    : false

  if (isLoading) {
    return <div className="p-5 text-sm text-surface-500">Cargando configuración de apariencia...</div>
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'branding',    label: 'Marca',         icon: <Image size={13} /> },
    { key: 'apariencia',  label: 'Apariencia',    icon: <Moon size={13} /> },
    { key: 'sidebar',     label: 'Barra lateral', icon: <SidebarOpen size={13} /> },
    { key: 'advanced',    label: 'Avanzado',       icon: <Code2 size={13} /> },
  ]

  return (
    <div className="p-5 space-y-5 animate-fade-in max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Apariencia</h2>
          <p className="text-xs text-surface-400 mt-0.5">Personaliza el aspecto visual de la plataforma</p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {/* Restore defaults */}
          {confirmReset ? (
            <>
              <span className="text-xs text-amber-400">¿Restaurar predeterminados?</span>
              <button onClick={handleRestoreDefaults} disabled={isSaving}
                className="px-2 py-1 rounded-lg text-xs bg-amber-600/20 text-amber-400 border border-amber-600/40 hover:bg-amber-600/30 transition-colors">
                Sí, restaurar
              </button>
              <button onClick={() => setConfirmReset(false)}
                className="btn-ghost text-xs">
                Cancelar
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmReset(true)} className="btn-ghost text-xs gap-1">
              <RotateCcw size={11} /> Predeterminados
            </button>
          )}

          {hasChanges && (
            <button onClick={handleDiscard} className="btn-secondary">
              <RotateCcw size={13} /> Descartar
            </button>
          )}
          <button onClick={handleSave} disabled={isSaving || !hasChanges} className="btn-primary">
            <Save size={13} /> {isSaving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Left: Config panels */}
        <div className="col-span-2 space-y-4">
          {/* Tabs */}
          <div className="flex gap-0.5 bg-surface-700 p-1 rounded-lg">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-colors',
                  activeTab === t.key
                    ? 'bg-surface-600 text-surface-100 shadow-sm'
                    : 'text-surface-400 hover:text-surface-200',
                )}
              >
                {t.icon}
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="card p-5 space-y-5">

            {/* ── Marca ── */}
            {activeTab === 'branding' && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Nombre del sistema</label>
                    <input
                      className="input"
                      value={settings.siteName}
                      onChange={(e) => set('siteName', e.target.value)}
                      maxLength={50}
                      placeholder="VisionCore"
                    />
                    <p className="text-xs text-surface-500 mt-1">Aparece en el título del navegador</p>
                  </div>
                  <div>
                    <label className="label">Texto del logo</label>
                    <input
                      className="input"
                      value={settings.logoText}
                      onChange={(e) => set('logoText', e.target.value)}
                      maxLength={50}
                      placeholder="VisionCore"
                    />
                    <p className="text-xs text-surface-500 mt-1">Texto visible en la barra lateral</p>
                  </div>
                </div>

                <div className="space-y-4 pt-1 border-t border-surface-700">
                  <p className="text-xs text-surface-400 pt-1">
                    URLs de imágenes externas o rutas relativas al servidor.
                    Deja en blanco para usar el icono por defecto.
                  </p>
                  <ImageUrlInput
                    label="Logo principal"
                    hint="Se muestra en la cabecera y pantalla de inicio de sesión."
                    value={settings.logoUrl ?? ''}
                    onChange={(v) => set('logoUrl', v)}
                    previewClass="h-10 max-w-[120px]"
                    fieldName="headerLogo"
                    onUpload={(url) => { set('logoUrl', url); setSaved(prev => ({ ...prev, logoUrl: url })) }}
                  />
                  <ImageUrlInput
                    label="Logo barra lateral"
                    hint="Ícono pequeño en la parte superior de la barra lateral. Idealmente cuadrado (32×32 px o más)."
                    value={settings.sidebarLogoUrl ?? ''}
                    onChange={(v) => set('sidebarLogoUrl', v)}
                    previewClass="h-8 w-8"
                    fieldName="sidebarLogo"
                    onUpload={(url) => { set('sidebarLogoUrl', url); setSaved(prev => ({ ...prev, sidebarLogoUrl: url })) }}
                  />
                  <ImageUrlInput
                    label="Favicon"
                    hint="Ícono de la pestaña del navegador. Formatos recomendados: .ico, .png, .svg."
                    value={settings.faviconUrl ?? ''}
                    onChange={(v) => set('faviconUrl', v)}
                    previewClass="h-6 w-6"
                    fieldName="favicon"
                    onUpload={(url) => { set('faviconUrl', url); setSaved(prev => ({ ...prev, faviconUrl: url })) }}
                  />
                </div>
              </>
            )}

            {/* ── Apariencia ── */}
            {activeTab === 'apariencia' && (
              <div className="space-y-5">
                <div>
                  <label className="label mb-2">Tema</label>
                  <div className="space-y-2">
                    {THEMES.map((t) => (
                      <label
                        key={t.value}
                        className={clsx(
                          'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                          settings.theme === t.value
                            ? 'border-brand-500 bg-brand-600/10'
                            : 'border-surface-600 hover:border-surface-500',
                        )}
                      >
                        <input
                          type="radio"
                          name="theme"
                          value={t.value}
                          checked={settings.theme === t.value}
                          onChange={() => set('theme', t.value)}
                          className="accent-brand-500"
                        />
                        <div
                          className="w-8 h-8 rounded-lg border border-surface-600 flex items-center justify-center flex-shrink-0"
                          style={{ backgroundColor: t.bg }}
                        >
                          {t.value === 'midnight'
                            ? <Moon size={14} className="text-surface-300" />
                            : <Sun size={14} className="text-surface-300" />}
                        </div>
                        <div className="flex-1">
                          <div className="text-xs font-medium text-surface-200">{t.label}</div>
                          <div className="text-xs text-surface-500">{t.description}</div>
                        </div>
                        {settings.theme === t.value && <Check size={14} className="text-brand-400" />}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="pt-1 border-t border-surface-700 space-y-4">
                  <div>
                    <label className="label mb-2">Presets de color</label>
                    <div className="flex flex-wrap gap-2">
                      {COLOR_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => { set('primaryColor', preset.primary); set('accentColor', preset.accent) }}
                          className={clsx(
                            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all',
                            settings.primaryColor === preset.primary
                              ? 'border-surface-300 text-surface-100'
                              : 'border-surface-600 text-surface-400 hover:border-surface-400',
                          )}
                        >
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: preset.primary }} />
                          {preset.label}
                          {settings.primaryColor === preset.primary && (
                            <Check size={10} className="text-green-400" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <ColorInput
                      label="Color primario"
                      value={settings.primaryColor}
                      onChange={(v) => set('primaryColor', v)}
                    />
                    <ColorInput
                      label="Color de acento"
                      value={settings.accentColor}
                      onChange={(v) => set('accentColor', v)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ── Barra lateral ── */}
            {activeTab === 'sidebar' && (
              <div className="space-y-5">
                <div>
                  <label className="label">Ancho</label>
                  <div className="space-y-2 mt-1.5">
                    {([
                      { value: 'compact', label: 'Compacto', description: '224 px — más espacio para contenido' },
                      { value: 'normal',  label: 'Normal',   description: '256 px — equilibrado' },
                    ] as const).map((w) => (
                      <label
                        key={w.value}
                        className={clsx(
                          'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                          settings.sidebarWidth === w.value
                            ? 'border-brand-500 bg-brand-600/10'
                            : 'border-surface-600 hover:border-surface-500',
                        )}
                      >
                        <input
                          type="radio"
                          name="sidebarWidth"
                          value={w.value}
                          checked={settings.sidebarWidth === w.value}
                          onChange={() => set('sidebarWidth', w.value)}
                          className="accent-brand-500"
                        />
                        <div className="flex-1">
                          <div className="text-xs font-medium text-surface-200">{w.label}</div>
                          <div className="text-xs text-surface-500">{w.description}</div>
                        </div>
                        {settings.sidebarWidth === w.value && <Check size={14} className="text-brand-400" />}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-surface-750 border border-surface-700">
                  <div>
                    <div className="text-xs font-medium text-surface-200">Mostrar NVRs en sidebar</div>
                    <div className="text-xs text-surface-500 mt-0.5">Lista cada NVR como acceso directo</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => set('showNVRsInSidebar', !settings.showNVRsInSidebar)}
                    className={clsx(
                      'w-9 h-5 rounded-full transition-colors relative flex-shrink-0',
                      settings.showNVRsInSidebar ? 'bg-brand-600' : 'bg-surface-600',
                    )}
                  >
                    <span className={clsx(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                      settings.showNVRsInSidebar ? 'translate-x-4' : 'translate-x-0.5',
                    )} />
                  </button>
                </div>
              </div>
            )}

            {/* ── Avanzado ── */}
            {activeTab === 'advanced' && (
              <div className="space-y-3">
                <div>
                  <label className="label">CSS personalizado</label>
                  <p className="text-xs text-surface-500 mb-2">
                    CSS adicional inyectado globalmente en la aplicación. Úsalo solo para ajustes finos.
                  </p>

                  {cssWarning && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-950/40 border border-amber-600/30 mb-2">
                      <AlertTriangle size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-300">
                        El CSS contiene patrones potencialmente inseguros (<code className="font-mono">expression()</code> o <code className="font-mono">javascript:</code>).
                        Estos serán ignorados por el navegador en contextos seguros.
                      </p>
                    </div>
                  )}

                  <div className="relative">
                    <textarea
                      className="input font-mono text-xs resize-none w-full leading-relaxed"
                      rows={14}
                      placeholder={`/* Ejemplo: ajustar el color del logo */\n.sidebar-logo { color: #ff6b35 !important; }\n\n/* Ejemplo: ocultar el botón de diagnóstico */\n.btn-diagnostic { display: none !important; }`}
                      value={settings.customCss}
                      onChange={(e) => set('customCss', e.target.value)}
                      maxLength={10000}
                      spellCheck={false}
                    />
                  </div>

                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-surface-500">
                      Ten cuidado: el CSS puede romper el layout si no es correcto
                    </span>
                    <div className="flex items-center gap-2">
                      {(settings.customCss ?? '').length > 0 && (
                        <button
                          type="button"
                          onClick={() => set('customCss', '')}
                          className="text-xs text-surface-500 hover:text-surface-300"
                        >
                          Limpiar
                        </button>
                      )}
                      <span className={clsx(
                        'text-xs tabular-nums',
                        (settings.customCss ?? '').length > 9000 ? 'text-amber-400' : 'text-surface-500',
                      )}>
                        {(settings.customCss ?? '').length.toLocaleString()}/10 000
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Preview */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs text-surface-400">
            <Eye size={12} />
            <span>Vista previa</span>
            {hasChanges && <span className="text-brand-400 font-medium">(sin guardar)</span>}
          </div>

          <PreviewCard settings={settings} />

          <div className="card p-3 space-y-2">
            <div className="text-xs font-medium text-surface-200">Resumen</div>
            <div className="space-y-1.5 text-xs text-surface-400">
              <div className="flex items-center justify-between">
                <span>Sitio</span>
                <span className="text-surface-200 font-medium truncate max-w-[100px]">{settings.siteName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Tema</span>
                <span className="text-surface-200">{THEMES.find((t) => t.value === settings.theme)?.label}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Color</span>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full border border-surface-600" style={{ backgroundColor: settings.primaryColor }} />
                  <span className="font-mono text-surface-200">{settings.primaryColor.toUpperCase()}</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span>Barra lateral</span>
                <span className="text-surface-200">{settings.sidebarWidth === 'compact' ? 'Compacta' : 'Normal'}</span>
              </div>
              {settings.logoUrl && (
                <div className="flex items-center justify-between">
                  <span>Logo</span>
                  <span className="text-green-400 text-[10px]">✓ Configurado</span>
                </div>
              )}
              {settings.faviconUrl && (
                <div className="flex items-center justify-between">
                  <span>Favicon</span>
                  <span className="text-green-400 text-[10px]">✓ Configurado</span>
                </div>
              )}
              {(settings.customCss ?? '').length > 0 && (
                <div className="flex items-center justify-between">
                  <span>CSS custom</span>
                  <span className="text-surface-300 text-[10px]">{(settings.customCss ?? '').length} chars</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
