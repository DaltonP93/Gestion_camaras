// tools/mutation-run.mjs — runner de mutaciones (C22 → C22.2), endurecido.
//
// Garantías:
//  - EXIGE árbol limpio (git status --porcelain vacío) y, si MUT_EXPECTED_HEAD
//    está definido, que HEAD coincida. Aborta si no.
//  - Corre la prueba BASELINE (sin mutar) primero: distingue "mutación detectada"
//    de "test ya roto".
//  - Restaura cada archivo por CONTENIDO CAPTURADO (no `git checkout`), en un
//    finally + handlers de señal, de modo que no queden cambios aunque se
//    interrumpa. No toca el árbol del usuario con `git checkout --`.
//  - NOTA: el parche acumulado debe estar committeado ANTES de usar este runner.
//
// Uso: `node tools/mutation-run.mjs`  (requiere npm install + prisma generate en apps/api).

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const REPO = process.cwd().replace(/\\/g, '/')
const API = `${REPO}/apps/api`, NATIVE = `${REPO}/apps/native`

function git(args) { return execSync(`git -C ${REPO} ${args}`, { encoding: 'utf8' }).trim() }

// ── guardas de seguridad ──
if (git('status --porcelain')) {
  console.error('ABORT: el árbol de trabajo NO está limpio. Confirmá/limpiá antes de correr mutaciones.')
  process.exit(2)
}
if (process.env.MUT_EXPECTED_HEAD && git('rev-parse HEAD') !== process.env.MUT_EXPECTED_HEAD) {
  console.error(`ABORT: HEAD (${git('rev-parse HEAD')}) != MUT_EXPECTED_HEAD (${process.env.MUT_EXPECTED_HEAD}).`)
  process.exit(2)
}

const M = [
  { id: 'M1', desc: 'reducer: quitar check REVOKED (P0-1A)', cwd: API, rel: 'apps/api/src/services/media/grant-store.ts', test: 'src/services/media/media-grants.test.ts',
    old: `if (g.revokedAt !== null) return { result: { ok: false, reason: 'REVOKED' }, claim: false }`, neu: `if (false) return { result: { ok: false, reason: 'REVOKED' }, claim: false }` },
  { id: 'M2', desc: 'reducer: quitar check EXPIRED (P0-1B)', cwd: API, rel: 'apps/api/src/services/media/grant-store.ts', test: 'src/services/media/media-grants.test.ts',
    old: `if (input.nowMs >= g.expiresAt) return { result: { ok: false, reason: 'EXPIRED' }, claim: false }`, neu: `if (false) return { result: { ok: false, reason: 'EXPIRED' }, claim: false }` },
  { id: 'M3', desc: 'reducer: quitar check EPOCH (P0-2)', cwd: API, rel: 'apps/api/src/services/media/grant-store.ts', test: 'src/services/media/media-grants.test.ts',
    old: `if (g.authorizationEpoch !== state.userEpoch) return { result: { ok: false, reason: 'EPOCH_MISMATCH' }, claim: false }`, neu: `if (false) return { result: { ok: false, reason: 'EPOCH_MISMATCH' }, claim: false }` },
  { id: 'M4', desc: 'reducer: quitar check INSTANCE (P0-4)', cwd: API, rel: 'apps/api/src/services/media/grant-store.ts', test: 'src/services/media/media-grants.test.ts',
    old: `if (g.mediaInstanceId !== state.currentInstance) return { result: { ok: false, reason: 'INSTANCE_MISMATCH' }, claim: false }`, neu: `if (false) return { result: { ok: false, reason: 'INSTANCE_MISMATCH' }, claim: false }` },
  { id: 'M5', desc: 'reducer: quitar uso único REPLAYED (P0-1)', cwd: API, rel: 'apps/api/src/services/media/grant-store.ts', test: 'src/services/media/media-grants.test.ts',
    old: `if (state.alreadyClaimed) return { result: { ok: false, reason: 'REPLAYED' }, claim: false }`, neu: `if (false) return { result: { ok: false, reason: 'REPLAYED' }, claim: false }` },
  { id: 'M6', desc: 'issue: inventar instancia en vez de negar (P0-4)', cwd: API, rel: 'apps/api/src/services/media/media-grants.ts', test: 'src/services/media/media-grants.test.ts',
    old: `if (instance === null) return { ok: false, code: 'NO_MEDIA_INSTANCE' }`, neu: `if (instance === null) instance = 'mi-fake'` },
  { id: 'M7', desc: 'revocación server-side se traga el fallo (P0-3)', cwd: API, rel: 'apps/api/src/services/media/grant-service.ts', test: 'src/services/media/grant-service.test.ts',
    old: `  return 'pending'`, neu: `  return 'applied'` },
  { id: 'M8', desc: 'readiness ignora salud del backend (P0-5)', cwd: API, rel: 'apps/api/src/services/media/native-readiness.ts', test: 'src/routes/liveView.route.test.ts',
    old: `      backendHealthy: healthy,`, neu: `      backendHealthy: true,` },
  { id: 'M9', desc: 'RBAC HD siempre permite (P0-5)', cwd: API, rel: 'apps/api/src/services/media/native-readiness.ts', test: 'src/routes/mediaGrants.route.test.ts',
    old: `  if (i.effectiveType === 'main') return i.perm.canHighQuality === true`, neu: `  if (i.effectiveType === 'main') return true` },
  { id: 'M10', desc: 'session: quitar re-check tras dispose(prev) (P0-6)', cwd: NATIVE, rel: 'apps/native/shared/session-controller.ts', test: 'shared/session-controller.test.ts',
    old: `sobrescribir lo que C dejó montado.\n    if (gen !== this.generation || this.disposed) {`, neu: `sobrescribir lo que C dejó montado.\n    if (false) {` },
  { id: 'M11', desc: 'pipeline: quitar gate de concurrencia real (P0-7)', cwd: API, rel: 'apps/api/src/services/ai/pipeline.ts', test: 'src/services/ai/pipeline.test.ts',
    old: `if (this.realInFlight >= this.maxConcurrent) return 'busy'`, neu: `if (false) return 'busy'` },
  { id: 'M12', desc: 'coordinator: A tardía reemplaza B (P0-4 nativo)', cwd: NATIVE, rel: 'apps/native/shared/coordinator.ts', test: 'shared/coordinator.test.ts',
    old: `if (rid !== this.active) { // superado durante la adquisición`, neu: `if (false) { // superado durante la adquisición` },
  // ── N1/N2 (cableado de lifecycle) ──
  { id: 'M13', desc: 'source-lifecycle: ready duplicado ROTA la instancia (N1)', cwd: API, rel: 'apps/api/src/services/media/source-lifecycle.ts', test: 'src/services/media/source-lifecycle.test.ts',
    old: `if (this.known.has(streamPath)) { await this.safeRefresh(streamPath); return }`, neu: `if (false) { await this.safeRefresh(streamPath); return }` },
  { id: 'M14', desc: 'source-lifecycle: reconcile(null) retira todo (N1)', cwd: API, rel: 'apps/api/src/services/media/source-lifecycle.ts', test: 'src/services/media/source-lifecycle.test.ts',
    old: `if (readyPaths === null) { this.log('reconcile_skipped reason=lister_unavailable'); return }`, neu: `if (readyPaths === null) readyPaths = []` },
  { id: 'M15', desc: 'lifecycle-binder: onHidden no revoca (N2a)', cwd: NATIVE, rel: 'apps/native/shared/lifecycle-binder.ts', test: 'shared/lifecycle-binder.test.ts',
    old: `await this.ctrl.invalidate()`, neu: `await Promise.resolve()` },
  { id: 'M16', desc: 'apply-decision: fallback no suelta el nativo (N2c)', cwd: NATIVE, rel: 'apps/native/shared/apply-decision.ts', test: 'shared/apply-decision.test.ts',
    old: `  // Fallback servidor/substream o inviable ⇒ soltar cualquier nativo activo.\n  await coordinator.invalidate()`, neu: `  // Fallback servidor/substream o inviable ⇒ soltar cualquier nativo activo.\n  await Promise.resolve()` },
  { id: 'M17', desc: 'admission-wait: no detecta el cupo libre (N2b)', cwd: API, rel: 'apps/api/src/services/media/admission-wait.ts', test: 'src/services/media/admission-wait.test.ts',
    old: `if (probeAvailable() >= 1) return 'acquired'`, neu: `if (probeAvailable() >= 1) return 'timeout'` },
  { id: 'M18', desc: 'session-policy: no revoca la sesión previa (N2d)', cwd: API, rel: 'apps/api/src/services/media/session-policy.ts', test: 'src/services/media/session-policy.test.ts',
    old: `if (prior && prior !== sessionId) {`, neu: `if (false) {` },
  // ── Track 2 (capstone nativo) ──
  { id: 'M19', desc: 'native-controller: resume no re-aplica la última decisión (Track 2)', cwd: NATIVE, rel: 'apps/native/shared/native-controller.ts', test: 'shared/native-controller.test.ts',
    old: `if (this.disposed || !this.last) return`, neu: `if (true) return` },
]

// Captura de originales para restaurar aunque se interrumpa.
const originals = new Map()
for (const m of M) { const abs = `${REPO}/${m.rel}`; if (!originals.has(abs)) originals.set(abs, readFileSync(abs, 'utf8')) }
function restoreAll() { for (const [abs, content] of originals) writeFileSync(abs, content, 'utf8') }
process.on('SIGINT', () => { restoreAll(); process.exit(130) })
process.on('SIGTERM', () => { restoreAll(); process.exit(143) })

function runTest(cwd, test) {
  try { execSync(`npx vitest run ${test}`, { cwd, stdio: 'pipe', encoding: 'utf8' }); return true } catch { return false }
}

// Baseline por test (deduplicado): debe PASAR antes de mutar.
const baseline = new Map()
for (const m of M) {
  const key = `${m.cwd}::${m.test}`
  if (!baseline.has(key)) baseline.set(key, runTest(m.cwd, m.test))
}

const results = []
try {
  for (const m of M) {
    const abs = `${REPO}/${m.rel}`
    const base = baseline.get(`${m.cwd}::${m.test}`)
    if (!base) { results.push({ ...m, status: 'BASELINE_BROKEN' }); console.log(`${m.id} BASELINE_BROKEN`); continue }
    const src = originals.get(abs)
    const idx = src.indexOf(m.old)
    if (idx === -1) { results.push({ ...m, status: 'ANCHOR_NOT_FOUND' }); console.log(`${m.id} ANCHOR_NOT_FOUND`); continue }
    writeFileSync(abs, src.slice(0, idx) + m.neu + src.slice(idx + m.old.length), 'utf8')
    const passedMutated = runTest(m.cwd, m.test)
    writeFileSync(abs, src, 'utf8') // restaurar de inmediato
    const caught = !passedMutated
    results.push({ ...m, status: caught ? 'CAUGHT' : 'ESCAPED' })
    console.log(`${m.id} ${caught ? 'CAUGHT ' : 'ESCAPED'} ${m.desc}`)
  }
} finally {
  restoreAll()
}

const caughtN = results.filter(r => r.status === 'CAUGHT').length
console.log(`\nCAUGHT ${caughtN}/${M.length}`)
console.log(`git status tras revertir: ${git('status --porcelain') ? 'SUCIO' : 'LIMPIO'}`)
