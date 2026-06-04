// src/pages/AppearancePage.tsx
import { useEffect, useState } from 'react'
import {
  Palette, Save, RotateCcw, Shield, Monitor, Sun, Moon,
  SidebarOpen, Eye, Code2, Check
} from 'lucide-react'
import { apiGet, apiPut } from '@/lib/api'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'
import type { AppearanceSettings } from '@/types'
import { invalidateAppearanceCache, applyAppearanceToDocument } from '@/hooks/useAppearance'

const THEMES = [
  { value: 'dark',     label: 'Oscuro',     description: 'Fondo gris oscuro clásico',  bg: '#1e2130', accent: '#2a2e42' },
  { value: 'darker',   label: 'Más oscuro', description: 'Fondo casi negro',            bg: '#111318', accent: '#1a1d26' },
  { value: 'midnight', label: 'Medianoche', description: 'Negro puro con bordes sutiles', bg: '#090a0e', accent: '#12141c' },
] as const

const SIDEBAR_WIDTHS = [
  { value: 'compact', label: 'Compacto', description: '224px — más espacio para contenido' },
  { value: 'normal',  label: 'Normal',   description: '256px — equilibrado' },
] as const

const COLOR_PRESETS = [
  { label: 'Rojo', primary: '#e51d1d', accent: '#c41616' },
  { label: 'Azul', primary: '#2563eb', accent: '#1d4ed8' },
  { label: 'Verde', primary: '#16a34a', accent: '#15803d' },
  { label: 'Violeta', primary: '#7c3aed', accent: '#6d28d9' },
  { label: 'Naranja', primary: '#ea580c', accent: '#c2410c' },
  { label: 'Cian', primary: '#0891b2', accent: '#0e7490' },
]

const DEFAULTS: AppearanceSettings = {
  id: 'singleton',
  siteName: 'VisionCore',
  logoText: 'VisionCore',
  primaryColor: '#e51d1d',
  accentColor: '#c41616',
  theme: 'dark',
  sidebarWidth: 'normal',
  showNVRsInSidebar: true,
  customCss: '',
  updatedAt: '',
}

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

function PreviewCard({ settings }: { settings: AppearanceSettings }) {
  const theme = THEMES.find((t) => t.value === settings.theme) || THEMES[0]

  return (
    <div
      className="rounded-xl overflow-hidden border border-surface-600 flex"
      style={{ backgroundColor: theme.bg, minHeight: 180 }}
    >
      {/* Sidebar preview */}
      <div
        className="flex flex-col py-3 px-2 gap-2 border-r"
        style={{
          width: settings.sidebarWidth === 'compact' ? 48 : 56,
          borderColor: theme.accent,
          backgroundColor: theme.accent,
        }}
      >
        <div
          className="w-6 h-6 rounded-md mx-auto flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: settings.primaryColor }}
        >
          <Shield size={10} className="text-white" />
        </div>
        {[1, 2, 3, 4].map((i) => (
          <div key={i}
            className="h-2 rounded mx-1"
            style={{
              backgroundColor: i === 1 ? settings.primaryColor + '60' : theme.bg + 'aa',
              opacity: i === 1 ? 1 : 0.5,
            }}
          />
        ))}
      </div>
      {/* Content area */}
      <div className="flex-1 p-3 space-y-2">
        <div className="text-xs font-medium" style={{ color: '#e5e7eb' }}>
          {settings.siteName}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i}
              className="h-10 rounded-lg"
              style={{ backgroundColor: theme.accent }}
            >
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

export function AppearancePage() {
  const [settings, setSettings] = useState<AppearanceSettings>(DEFAULTS)
  const [saved, setSaved] = useState<AppearanceSettings>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'branding' | 'theme' | 'sidebar' | 'advanced'>('branding')

  useEffect(() => {
    apiGet<AppearanceSettings>('/appearance')
      .then((data) => {
        setSettings(data)
        setSaved(data)
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
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setSettings(saved)
    toast('Cambios descartados', { icon: 'ℹ️' })
  }

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(saved)

  const set = <K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  if (isLoading) {
    return <div className="p-5 text-sm text-surface-500">Cargando configuración de apariencia...</div>
  }

  const tabs = [
    { key: 'branding', label: 'Marca', icon: <Shield size={13} /> },
    { key: 'theme',    label: 'Tema',  icon: <Moon size={13} /> },
    { key: 'sidebar',  label: 'Barra lateral', icon: <SidebarOpen size={13} /> },
    { key: 'advanced', label: 'Avanzado', icon: <Code2 size={13} /> },
  ] as const

  return (
    <div className="p-5 space-y-5 animate-fade-in max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Apariencia</h2>
          <p className="text-xs text-surface-400 mt-0.5">Personaliza el aspecto visual de la plataforma</p>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button onClick={handleReset} className="btn-secondary">
              <RotateCcw size={13} /> Descartar
            </button>
          )}
          <button onClick={handleSave} disabled={isSaving || !hasChanges} className="btn-primary">
            <Save size={13} /> {isSaving ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Left: Config */}
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
                    : 'text-surface-400 hover:text-surface-200'
                )}
              >
                {t.icon}
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="card p-5 space-y-5">
            {/* ── Branding ── */}
            {activeTab === 'branding' && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Nombre del sitio</label>
                    <input
                      className="input"
                      value={settings.siteName}
                      onChange={(e) => set('siteName', e.target.value)}
                      maxLength={50}
                    />
                    <p className="text-xs text-surface-500 mt-1">Aparece en el título de la pestaña</p>
                  </div>
                  <div>
                    <label className="label">Texto del logo</label>
                    <input
                      className="input"
                      value={settings.logoText}
                      onChange={(e) => set('logoText', e.target.value)}
                      maxLength={50}
                    />
                    <p className="text-xs text-surface-500 mt-1">Texto en la barra lateral superior</p>
                  </div>
                </div>

                <div>
                  <label className="label mb-2">Presets de color</label>
                  <div className="flex flex-wrap gap-2">
                    {COLOR_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          set('primaryColor', preset.primary)
                          set('accentColor', preset.accent)
                        }}
                        className={clsx(
                          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all',
                          settings.primaryColor === preset.primary
                            ? 'border-surface-300 text-surface-100'
                            : 'border-surface-600 text-surface-400 hover:border-surface-400'
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
              </>
            )}

            {/* ── Theme ── */}
            {activeTab === 'theme' && (
              <div className="space-y-4">
                <label className="label">Tema de color</label>
                <div className="space-y-2">
                  {THEMES.map((t) => (
                    <label
                      key={t.value}
                      className={clsx(
                        'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                        settings.theme === t.value
                          ? 'border-brand-500 bg-brand-600/10'
                          : 'border-surface-600 hover:border-surface-500'
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
                        className="w-8 h-8 rounded-lg border border-surface-600 flex items-center justify-center"
                        style={{ backgroundColor: t.bg }}
                      >
                        {t.value === 'midnight' ? <Moon size={14} className="text-surface-300" /> : <Sun size={14} className="text-surface-300" />}
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
            )}

            {/* ── Sidebar ── */}
            {activeTab === 'sidebar' && (
              <div className="space-y-5">
                <div>
                  <label className="label">Ancho de barra lateral</label>
                  <div className="space-y-2 mt-1.5">
                    {SIDEBAR_WIDTHS.map((w) => (
                      <label
                        key={w.value}
                        className={clsx(
                          'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                          settings.sidebarWidth === w.value
                            ? 'border-brand-500 bg-brand-600/10'
                            : 'border-surface-600 hover:border-surface-500'
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

                <div className="flex items-center justify-between p-3 rounded-lg bg-surface-750">
                  <div>
                    <div className="text-xs font-medium text-surface-200">Mostrar NVRs en sidebar</div>
                    <div className="text-xs text-surface-500 mt-0.5">Lista cada NVR como acceso directo</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => set('showNVRsInSidebar', !settings.showNVRsInSidebar)}
                    className={clsx(
                      'w-9 h-5 rounded-full transition-colors relative flex-shrink-0',
                      settings.showNVRsInSidebar ? 'bg-brand-600' : 'bg-surface-600'
                    )}
                  >
                    <span className={clsx(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                      settings.showNVRsInSidebar ? 'translate-x-4' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>
              </div>
            )}

            {/* ── Advanced ── */}
            {activeTab === 'advanced' && (
              <div className="space-y-3">
                <div>
                  <label className="label">CSS personalizado</label>
                  <p className="text-xs text-surface-500 mb-2">
                    CSS adicional que se inyecta en la aplicación. Úsalo para ajustes finos.
                  </p>
                  <textarea
                    className="input font-mono text-xs resize-none"
                    rows={12}
                    placeholder={`/* Ejemplo: cambiar el color del logo */\n.sidebar-logo { color: #ff6b35 !important; }`}
                    value={settings.customCss ?? ''}
                    onChange={(e) => set('customCss', e.target.value)}
                    maxLength={10000}
                  />
                  <div className="flex justify-between mt-1">
                    <span className="text-xs text-surface-500">Ten cuidado: el CSS puede romper el layout</span>
                    <span className="text-xs text-surface-500">{(settings.customCss ?? '').length}/10000</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Live preview */}
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
                <span className="text-surface-200 font-medium">{settings.siteName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Tema</span>
                <span className="text-surface-200">{THEMES.find(t=>t.value===settings.theme)?.label}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Color</span>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full border border-surface-600" style={{ backgroundColor: settings.primaryColor }} />
                  <span className="font-mono text-surface-200">{settings.primaryColor.toUpperCase()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
