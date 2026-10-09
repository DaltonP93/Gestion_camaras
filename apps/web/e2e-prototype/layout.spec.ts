// Diseño para PC y tablet: sin desborde horizontal, navegación adecuada a cada
// ancho y objetivos táctiles de al menos 44 px en tablet.
import { test, expect, type Page } from '@playwright/test'
import { USER, asUser, freshStart, navTo } from './helpers'

const ROUTES = ['/vivo', '/grabaciones', '/eventos', '/configuracion/seguridad', '/configuracion/permisos', '/configuracion/zonas']

async function noHorizontalOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth, 'desborde horizontal de la página').toBeLessThanOrEqual(innerWidth)
}

test.beforeEach(async ({ page }) => { await freshStart(page) })

test('ninguna pantalla desborda horizontalmente', async ({ page }) => {
  for (const r of ROUTES) {
    await page.goto(`/#${r}`)
    await expect(page.getByTestId('main')).toBeVisible()
    await noHorizontalOverflow(page)
  }
})

test('navegación: barra lateral en PC y tablet horizontal; cajón en tablet vertical', async ({ page }, info) => {
  if (info.project.name === 'tablet-vertical') {
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await expect(page.getByTestId('menu-button')).toBeVisible()
    await navTo(page, 'Grabaciones')
    await expect(page.getByTestId('playback-grid')).toBeVisible()
  } else {
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('menu-button')).toBeHidden()
  }
})

test('controles táctiles ≥ 44 px en tablet', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('tablet'), 'sólo aplica a tablet')
  const check = async () => {
    const small = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('main button, main select, main input[type=text], main input[type=number], main input[type=password], main a, header button, header select'))
      return els
        .filter(el => el.offsetParent !== null)
        .map(el => ({ el: el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 30), h: el.getBoundingClientRect().height }))
        .filter(x => x.h < 44)
    })
    expect(small, 'controles por debajo de 44 px').toEqual([])
  }
  for (const r of ['/vivo', '/grabaciones', '/configuracion/seguridad']) {
    await page.goto(`/#${r}`)
    await expect(page.getByTestId('main')).toBeVisible()
    await check()
  }
})

test('la grilla 2×2 de vivo entra completa en la ventana en PC y tablet horizontal', async ({ page }, info) => {
  test.skip(info.project.name === 'tablet-vertical', 'en vertical la grilla se desplaza')
  await asUser(page, USER.ADMIN)
  const grid = page.getByTestId('live-grid')
  await expect(grid).toHaveAttribute('data-cells', '4')
  const box = await grid.boundingBox()
  const vh = page.viewportSize()!.height
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1)
})

test('controles multicámara accesibles sin desplazamiento horizontal en tablet vertical', async ({ page }, info) => {
  test.skip(info.project.name !== 'tablet-vertical', 'caso de tablet vertical')
  await navTo(page, 'Grabaciones')
  const controls = page.getByTestId('playback-controls')
  await expect(controls.getByTestId('play-pause')).toBeInViewport()
  await expect(controls.getByTestId('speed-4')).toBeInViewport()
  await noHorizontalOverflow(page)
})
