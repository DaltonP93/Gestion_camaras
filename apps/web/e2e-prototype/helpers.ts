import { expect, type Page } from '@playwright/test'

export const USER = { ADMIN: 'u-admin', SUPERVISOR: 'u-sup', OPERATOR: 'u-op', AUDITOR: 'u-aud' } as const

/** Arranca limpio: sin visores ni selección persistidos. */
export async function freshStart(page: Page, path = '/vivo') {
  await page.goto(`/#${path}`)
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`/#${path}`)
  await page.reload()
  await expect(page.getByTestId('sim-banner')).toBeVisible()
}

export async function asUser(page: Page, userId: string) {
  await page.getByTestId('role-switch').selectOption(userId)
}

/** Navega por el menú principal (barra lateral en PC/tablet horizontal, cajón en vertical). */
export async function navTo(page: Page, label: string) {
  const menu = page.getByTestId('menu-button')
  if (await menu.isVisible()) {
    await menu.click()
    await page.getByTestId('drawer').getByRole('link', { name: label }).click()
    await expect(page.getByTestId('drawer')).toBeHidden()
  } else {
    await page.getByTestId('sidebar').getByRole('link', { name: label }).click()
  }
}

export async function clockSeconds(page: Page): Promise<number> {
  return Number(await page.getByTestId('clock').getAttribute('data-t'))
}

/** Fija el reloj común por el control deslizante (lo que hace el usuario al arrastrar). */
export async function seekTo(page: Page, seconds: number) {
  await page.getByTestId('seek-range').evaluate((el, v) => {
    const input = el as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, String(v))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, seconds)
}

export const H = 3600

/**
 * Selector lateral (visores, cámaras, secciones): en tablet vertical está plegado
 * detrás de un botón; en PC y tablet horizontal siempre visible. Lo abre si hace falta.
 */
export async function openPanel(page: Page, testId: 'viewer-panel' | 'camera-picker' | 'settings-nav') {
  // Esperar a que la pantalla lo haya montado antes de decidir (el botón sólo existe visible en vertical).
  await expect(page.getByTestId(testId)).toBeAttached()
  const toggle = page.getByTestId(`${testId}-toggle`)
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(page.getByTestId(`${testId}-content`)).toBeVisible()
}

export async function selectViewer(page: Page, viewerId: string) {
  await openPanel(page, 'viewer-panel')
  await page.getByTestId(`viewer-${viewerId}`).click()
}

export async function pickCamera(page: Page, cameraId: string, checked = true) {
  await openPanel(page, 'camera-picker')
  await page.getByTestId(`pick-${cameraId}`).setChecked(checked)
}

export async function goSection(page: Page, sectionId: string) {
  await openPanel(page, 'settings-nav')
  await page.getByTestId(`settings-link-${sectionId}`).click()
  await expect(page.getByTestId(`settings-section-${sectionId}`)).toBeVisible()
}

/** Errores y advertencias de consola de la página (deben quedar vacíos). */
export function trackConsole(page: Page): string[] {
  const problems: string[] = []
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  return problems
}
