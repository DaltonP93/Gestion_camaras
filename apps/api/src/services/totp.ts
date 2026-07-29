// services/totp.ts — TOTP / 2FA helpers
import speakeasy from 'speakeasy'
import QRCode from 'qrcode'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'

// ─── Secret ──────────────────────────────────────────────────

export function generateTotpSecret(): string {
  return speakeasy.generateSecret({ length: 20 }).base32
}

export function verifyTotpToken(secret: string, token: string): boolean {
  return speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 })
}

export async function getTotpQrCodeUri(
  secret: string, username: string, issuer = 'VisionCore'
): Promise<string> {
  const otpAuthUrl = speakeasy.otpauthURL({ secret, label: username, issuer, encoding: 'base32' })
  return QRCode.toDataURL(otpAuthUrl)
}

// ─── Backup codes ─────────────────────────────────────────────

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()  // 8 hex chars like A3F21B9C
  )
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => bcrypt.hash(c, 8)))
}

export async function verifyBackupCode(
  code: string, hashedCodes: string[]
): Promise<number> {
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(code.toUpperCase(), hashedCodes[i])) return i
  }
  return -1
}

// ─── Password policy ──────────────────────────────────────────

// La política de contraseña vive ahora en security-policy.ts (configurable, mín. 12
// por defecto). Se re-exporta aquí para no romper importadores existentes; acepta
// opciones { minLength, requireStrong } cargadas desde SecuritySettings.
export {
  evaluatePasswordPolicy as checkPasswordPolicy,
  type PasswordPolicyResult,
  type PasswordPolicyOptions,
} from './security-policy'

export async function checkPasswordHistory(
  newPassword: string, historyJson: string | null
): Promise<boolean> {
  if (!historyJson) return false
  try {
    const hashes: string[] = JSON.parse(historyJson)
    for (const h of hashes) {
      if (await bcrypt.compare(newPassword, h)) return true
    }
  } catch {}
  return false
}

export async function addToPasswordHistory(
  newHash: string, historyJson: string | null, keep = 5
): Promise<string> {
  let hashes: string[] = []
  try { if (historyJson) hashes = JSON.parse(historyJson) } catch {}
  hashes.unshift(newHash)
  return JSON.stringify(hashes.slice(0, keep))
}

// ─── Device name from User-Agent ──────────────────────────────

export function parseDeviceName(userAgent?: string | null): string {
  if (!userAgent) return 'Dispositivo desconocido'
  if (/iPhone/.test(userAgent))             return 'iPhone'
  if (/iPad/.test(userAgent))               return 'iPad'
  if (/Android/.test(userAgent))            return 'Android'
  if (/Mobile/.test(userAgent))             return 'Móvil'
  if (/Windows/.test(userAgent))            return 'Windows'
  if (/Macintosh|Mac OS/.test(userAgent))   return 'Mac'
  if (/Linux/.test(userAgent))              return 'Linux'
  return 'Navegador'
}

// ─── Feature permission defaults por rol ──────────────────────

export const FEATURE_DEFAULTS: Record<string, Record<string, boolean>> = {
  ADMIN: {
    canViewDashboard: true, canViewLive: true, canViewRecordings: true,
    canViewAlerts: true, canViewDiagnostics: true,
    canManageNVRs: true, canManageCameras: true, canManageUsers: true,
    canManageAppearance: true, canResolveAlerts: true,
    canRestartStreams: true, canTranscode: true,
    canDownloadRecordings: true, canManageViews: true, canManageSettings: true,
  },
  SUPERVISOR: {
    canViewDashboard: true, canViewLive: true, canViewRecordings: true,
    canViewAlerts: true, canViewDiagnostics: true,
    canManageNVRs: false, canManageCameras: false, canManageUsers: false,
    canManageAppearance: false, canResolveAlerts: true,
    canRestartStreams: false, canTranscode: false,
    canDownloadRecordings: false, canManageViews: false, canManageSettings: false,
  },
  OPERATOR: {
    canViewDashboard: true, canViewLive: true, canViewRecordings: false,
    canViewAlerts: true, canViewDiagnostics: false,
    canManageNVRs: false, canManageCameras: false, canManageUsers: false,
    canManageAppearance: false, canResolveAlerts: false,
    canRestartStreams: false, canTranscode: false,
    canDownloadRecordings: false, canManageViews: false, canManageSettings: false,
  },
  AUDITOR: {
    canViewDashboard: true, canViewLive: false, canViewRecordings: true,
    canViewAlerts: true, canViewDiagnostics: false,
    canManageNVRs: false, canManageCameras: false, canManageUsers: false,
    canManageAppearance: false, canResolveAlerts: false,
    canRestartStreams: false, canTranscode: false,
    canDownloadRecordings: false, canManageViews: false, canManageSettings: false,
  },
}

export function resolveFeaturePermissions(
  role: string,
  fp: Record<string, boolean> | null | undefined
): Record<string, boolean> {
  const defaults = FEATURE_DEFAULTS[role] ?? FEATURE_DEFAULTS.OPERATOR
  if (!fp) return { ...defaults }
  // Explicit DB overrides only for non-ADMIN roles
  if (role === 'ADMIN') return { ...defaults }
  return { ...defaults, ...fp }
}
