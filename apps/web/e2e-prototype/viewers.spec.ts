// Selección y persistencia de visores personales y compartidos (datos simulados).
import { test, expect } from '@playwright/test'
import { USER, asUser, freshStart, openPanel, selectViewer } from './helpers'

test.beforeEach(async ({ page }) => { await freshStart(page) })

test('la selección de visor persiste al recargar y es por usuario', async ({ page }) => {
  await selectViewer(page, 'v-deposito')
  await expect(page.getByTestId('viewer-title')).toHaveText('Depósito')
  await page.reload()
  await expect(page.getByTestId('viewer-title')).toHaveText('Depósito')

  await asUser(page, USER.OPERATOR)
  await selectViewer(page, 'v-entrada')
  await asUser(page, USER.ADMIN)
  await expect(page.getByTestId('viewer-title')).toHaveText('Depósito')
  await asUser(page, USER.OPERATOR)
  await expect(page.getByTestId('viewer-title')).toHaveText('Entradas')
})

test('ADMIN ve los visores personales de otros aparte, no como compartidos', async ({ page }) => {
  await openPanel(page, 'viewer-panel')
  await expect(page.getByTestId('shared-viewers').getByTestId('viewer-v-sup-ronda')).toHaveCount(0)
  await expect(page.getByTestId('other-viewers').getByTestId('viewer-v-sup-ronda')).toBeVisible()
})

test('SUPERVISOR crea un visor personal, lo comparte y el operador lo ve sin cámaras no permitidas', async ({ page }) => {
  await asUser(page, USER.SUPERVISOR)
  await openPanel(page, 'viewer-panel')
  await page.getByTestId('new-viewer').click()
  await page.getByTestId('viewer-name').fill('Ronda mañana')
  await page.getByTestId('layout-2x2').click()
  await page.getByTestId('cell-select-0').selectOption('cam-a1')
  await page.getByTestId('cell-select-1').selectOption('cam-a4')
  await page.getByTestId('cell-select-2').selectOption('cam-b1')
  await page.getByTestId('save-viewer').click()

  await expect(page.getByTestId('viewer-title')).toHaveText('Ronda mañana')
  await expect(page.getByTestId('viewer-kind')).toHaveText('Personal')
  await expect(page.getByTestId('personal-viewers')).toContainText('Ronda mañana')

  await page.reload()
  await expect(page.getByTestId('viewer-title')).toHaveText('Ronda mañana')
  await expect(page.getByTestId('cell-3')).toContainText('Celda vacía')

  await page.getByTestId('share-viewer').click()
  await page.getByTestId('share-user-u-op').check()
  await page.getByTestId('share-save').click()
  await expect(page.getByTestId('viewer-kind')).toHaveText('Compartido')
  await expect(page.getByTestId('shared-viewers')).toContainText('Ronda mañana')

  await asUser(page, USER.OPERATOR)
  await openPanel(page, 'viewer-panel')
  await page.getByTestId('shared-viewers').getByRole('button', { name: /Ronda mañana/ }).click()
  await expect(page.getByTestId('cell-0')).toContainText('Acceso principal')
  // cam-a4 no está permitida para el operador: celda bloqueada, sin video.
  await expect(page.getByTestId('cell-1-forbidden')).toBeVisible()
  await expect(page.getByTestId('cell-2')).toContainText('Muelle de carga')
  await expect(page.getByTestId('edit-viewer')).toHaveCount(0)
  await expect(page.getByTestId('new-viewer')).toHaveCount(0)
})

test('SUPERVISOR no puede editar visores ajenos; ADMIN sí', async ({ page }) => {
  await asUser(page, USER.SUPERVISOR)
  await selectViewer(page, 'v-entrada')
  await expect(page.getByTestId('edit-viewer')).toBeVisible() // es el creador
  await expect(page.getByTestId('viewer-v-deposito')).toHaveCount(0) // ni lo ve: es de ADMIN y no está compartido con él
  await asUser(page, USER.ADMIN)
  await selectViewer(page, 'v-sup-ronda')
  await expect(page.getByTestId('edit-viewer')).toBeVisible()
})

test('nombre vacío ⇒ error visible y no se guarda', async ({ page }) => {
  await openPanel(page, 'viewer-panel')
  await page.getByTestId('new-viewer').click()
  await page.getByTestId('viewer-name').fill('   ')
  await page.getByTestId('save-viewer').click()
  await expect(page.getByTestId('viewer-error')).toHaveText('El visor necesita un nombre')
  await page.getByTestId('cancel-edit').click()
  await expect(page.getByTestId('personal-viewers')).toContainText('Sin visores personales')
})

test('ampliar una celda a 1×1 pide HD sólo con permiso de alta calidad', async ({ page }) => {
  await asUser(page, USER.OPERATOR)
  await selectViewer(page, 'v-deposito')
  // cam-b1 (celda 0): el operador tiene canHighQuality ⇒ HD al ampliar.
  await expect(page.getByTestId('cell-0-quality')).toHaveText('SD')
  await page.getByTestId('cell-0-expand').click()
  await expect(page.getByTestId('live-grid')).toHaveAttribute('data-cells', '1')
  await expect(page.getByTestId('cell-0-quality')).toHaveText('HD')
  await page.getByTestId('back-to-grid').click()
  // cam-a1 en "Entradas": sin canHighQuality ⇒ sigue en SD aunque se amplíe.
  await selectViewer(page, 'v-entrada')
  await page.getByTestId('cell-0-expand').click()
  await expect(page.getByTestId('cell-0-quality')).toHaveText('SD')
})

test('PTZ sólo donde la cámara es PTZ y el usuario tiene canPtz', async ({ page }) => {
  await asUser(page, USER.OPERATOR)
  await selectViewer(page, 'v-entrada')
  await expect(page.getByTestId('cell-0-ptz')).toBeVisible() // cam-a1: canPtz
  await expect(page.getByTestId('cell-1-ptz')).toHaveCount(0) // cam-a2: no PTZ
  await page.getByTestId('cell-0-ptz').click()
  await expect(page.getByTestId('ptz-pad')).toContainText('no se envían')
})
