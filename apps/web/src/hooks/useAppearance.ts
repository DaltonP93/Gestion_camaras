// src/hooks/useAppearance.ts
//
// Antes este hook tenía su PROPIO cálculo de color y su PROPIO efecto sobre
// documentElement, divergente del store. Ahora es una fina capa sobre el store
// y el motor único (lib/appearanceTokens): no existe un segundo aplicador.
import { useEffect } from 'react'
import { resolveAssetUrl } from '@/lib/api'
import type { AppearanceSettings } from '@/types'
import { useAppearanceStore } from '@/stores/appearanceStore'
import { applyAppearance } from '@/lib/appearanceTokens'

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Aplica una configuración al documento a través del motor único.
 * Se mantiene como export por compatibilidad con AppearancePage.
 */
export function applyAppearanceToDocument(settings: AppearanceSettings): void {
  applyAppearance(settings, { prefersDark: prefersDark(), resolveAsset: resolveAssetUrl })
}

/**
 * Carga y aplica la apariencia una sola vez (usado por Layout). Delega en el
 * store, que es idempotente: si ya se cargó no vuelve a pedir/parpadear.
 */
export function useAppearance(): void {
  const loaded = useAppearanceStore((s) => s.loaded)
  const load = useAppearanceStore((s) => s.load)
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
}

/** Fuerza una recarga de la apariencia desde el backend. */
export function invalidateAppearanceCache(): void {
  void useAppearanceStore.getState().load()
}
