// src/lib/integrations.ts
//
// Lógica PURA (sin React ni red) que consume la página de Integraciones para
// decidir cómo se ve el panel ONVIF. Al ser pura se puede testear sin DOM y es
// la ÚNICA fuente de verdad para "acciones habilitadas/deshabilitadas".
import type { IntegrationsStatus } from '@/types'

export interface OnvifPanelState {
  /** true ⇒ ONVIF_ENABLED=true en el servidor: se permiten acciones. */
  enabled: boolean
  /** true ⇒ deshabilitar todos los controles y NO llamar a /api/onvif/*. */
  actionsDisabled: boolean
  /** Aviso a mostrar cuando está deshabilitado (null si está habilitado). */
  notice: string | null
}

const DISABLED_NOTICE = 'Deshabilitado — definí ONVIF_ENABLED=true en el servidor'

/**
 * Deriva el estado del panel ONVIF a partir del status de integraciones.
 * Mientras el status no cargó (null) se trata como deshabilitado (fail-safe):
 * no se dispara ningún I/O ONVIF hasta confirmar que la flag está activa.
 */
export function deriveOnvifPanelState(status: IntegrationsStatus | null): OnvifPanelState {
  const enabled = status?.onvif.enabled === true
  return {
    enabled,
    actionsDisabled: !enabled,
    notice: enabled ? null : DISABLED_NOTICE,
  }
}

export interface HikConnectPanelState {
  /** true ⇒ HIK_CONNECT_ENABLED=true en el servidor: se permiten acciones. */
  enabled: boolean
  /** true ⇒ deshabilitar todos los controles y NO llamar a /api/hik-connect/*. */
  actionsDisabled: boolean
  /** Aviso a mostrar cuando está deshabilitado (null si está habilitado). */
  notice: string | null
}

const HIK_DISABLED_NOTICE =
  'Deshabilitado — definí HIK_CONNECT_ENABLED=true (y HIK_CONNECT_APP_KEY/SECRET_KEY) en el servidor'

/**
 * Deriva el estado del panel Hik-Connect a partir del status de integraciones.
 * Igual criterio fail-safe que ONVIF: mientras el status no cargó (null) se trata
 * como deshabilitado, de modo que no se dispara ningún I/O a /api/hik-connect/*
 * hasta confirmar que la flag está activa.
 */
export function deriveHikConnectPanelState(status: IntegrationsStatus | null): HikConnectPanelState {
  const enabled = status?.hikConnect.enabled === true
  return {
    enabled,
    actionsDisabled: !enabled,
    notice: enabled ? null : HIK_DISABLED_NOTICE,
  }
}

/** Extrae un mensaje de error legible de un error de axios/fetch, sin filtrar cuerpos. */
export function integrationErrorMessage(err: unknown, fallback = 'Error al comunicarse con el dispositivo'): string {
  const anyErr = err as { response?: { data?: { message?: string; code?: string } }; message?: string }
  return (
    anyErr?.response?.data?.message ||
    anyErr?.response?.data?.code ||
    anyErr?.message ||
    fallback
  )
}
