// Permisos por rol en navegación y configuración (mismas reglas que la API).
import { test, expect } from '@playwright/test'
import { USER, asUser, freshStart } from './helpers'

test.beforeEach(async ({ page }) => { await freshStart(page) })

const ALL_SECTIONS = ['general', 'apariencia', 'sistema', 'nvr', 'camaras', 'usuarios', 'permisos', 'seguridad', 'auditoria',
  'alertas', 'notificaciones', 'visores', 'deteccion', 'zonas', 'eventos-almacenamiento']

test('módulos visibles por rol', async ({ page }) => {
  const expected: Record<string, string[]> = {
    [USER.ADMIN]: ['Vivo', 'Grabaciones', 'Eventos', 'Configuración'],
    [USER.SUPERVISOR]: ['Vivo', 'Grabaciones', 'Eventos', 'Configuración'],
    [USER.OPERATOR]: ['Vivo', 'Configuración'],
    [USER.AUDITOR]: ['Vivo', 'Grabaciones', 'Eventos', 'Configuración'],
  }
  for (const [user, labels] of Object.entries(expected)) {
    await asUser(page, user)
    const menu = page.getByTestId('menu-button')
    const nav = (await menu.isVisible()) ? (await menu.click(), page.getByTestId('drawer')) : page.getByTestId('sidebar')
    await expect(nav.getByRole('link')).toHaveText(labels)
    if (await page.getByTestId('drawer').isVisible()) await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
  }
})

test('ADMIN: todas las secciones de configuración, editables salvo la auditoría', async ({ page }) => {
  await page.goto('/#/configuracion/general')
  for (const id of ALL_SECTIONS) await expect(page.getByTestId(`settings-link-${id}`)).toBeVisible()
  await page.getByTestId('settings-link-auditoria').click()
  await expect(page.getByTestId('settings-section-auditoria')).toHaveAttribute('data-access', 'read')
  await page.getByTestId('settings-link-nvr').click()
  await expect(page.getByTestId('action-add-nvr')).toBeVisible()
})

test('SUPERVISOR: NVR en sólo lectura (con sync/salud), cámaras y detección editables, sin seguridad ni usuarios', async ({ page }) => {
  await asUser(page, USER.SUPERVISOR)
  await page.goto('/#/configuracion/nvr')
  await expect(page.getByTestId('settings-section-nvr')).toHaveAttribute('data-access', 'read')
  await expect(page.getByTestId('read-only')).toBeVisible()
  await expect(page.getByTestId('action-add-nvr')).toHaveCount(0)
  await expect(page.getByTestId('action-sync-nvr')).toBeVisible()
  for (const id of ['seguridad', 'usuarios', 'permisos', 'auditoria', 'notificaciones', 'general']) {
    await expect(page.getByTestId(`settings-link-${id}`)).toHaveCount(0)
  }
  await page.getByTestId('settings-link-camaras').click()
  await expect(page.getByTestId('settings-section-camaras')).toHaveAttribute('data-access', 'edit')
  await page.getByTestId('settings-link-deteccion').click()
  await expect(page.getByTestId('settings-section-deteccion')).toHaveAttribute('data-access', 'edit')
  await expect(page.getByTestId('f-minScore')).toBeEnabled()
})

test('OPERATOR y AUDITOR: sólo consultan visores; una URL directa a otra sección redirige', async ({ page }) => {
  for (const user of [USER.OPERATOR, USER.AUDITOR]) {
    await asUser(page, user)
    await page.goto('/#/configuracion/seguridad')
    await expect(page).toHaveURL(/#\/configuracion\/visores$/)
    await expect(page.getByTestId('settings-section-visores')).toHaveAttribute('data-access', 'read')
    await expect(page.getByTestId('settings-nav').getByRole('link')).toHaveText(['Visores'])
  }
})

test('formulario con cambios sin guardar: Guardar y Deshacer (patrón de secciones)', async ({ page }) => {
  await page.goto('/#/configuracion/seguridad')
  await expect(page.getByTestId('dirty-state')).toHaveText('Sin cambios')
  await expect(page.getByTestId('save')).toBeDisabled()
  await page.getByTestId('f-maxSessions').fill('3')
  await expect(page.getByTestId('dirty-state')).toHaveText('Cambios sin guardar')
  await page.getByTestId('undo').click()
  await expect(page.getByTestId('f-maxSessions')).toHaveValue('5')
  await page.getByTestId('f-maxSessions').fill('3')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('save-notice')).toContainText('Guardado')
  await expect(page.getByTestId('dirty-state')).toHaveText('Sin cambios')
  // La contraseña SMTP nunca se muestra precargada.
  await page.getByTestId('settings-link-notificaciones').click()
  await expect(page.getByTestId('f-smtpPassword')).toHaveValue('')
})

test('eventos: OPERATOR sin módulo; SUPERVISOR filtrado por canView explícito', async ({ page }) => {
  await asUser(page, USER.SUPERVISOR)
  await page.goto('/#/eventos')
  await expect(page.getByTestId('events-scope-note')).toBeVisible()
  await expect(page.getByTestId('event-e1')).toBeVisible() // cam-a1
  await expect(page.getByTestId('event-e4')).toHaveCount(0) // cam-a3 sin canView
  await asUser(page, USER.OPERATOR)
  await expect(page.getByTestId('no-access')).toBeVisible()
})
