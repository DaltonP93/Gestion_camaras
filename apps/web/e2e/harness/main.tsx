// Bootstrap del harness de E2E. Monta el COMPONENTE REAL `ViewPlayerPage` (no una
// copia) sobre un MemoryRouter en la ruta `views/:id`. Todo lo demás —controlador
// de ciclo de vida, cierre por identidad con `fetch(keepalive)`, API de pantalla
// completa, handlers de `pagehide`/`pageshow`— es el código de producción.
//
// No se usa React.StrictMode: en dev StrictMode monta/desmonta dos veces (lo que
// dispararía `disposeView` en el primer montaje descartable) y eso haría no
// determinista el conteo de llamadas de red del test. La build de producción no
// hace ese doble montaje, así que el harness refleja producción.
import ReactDOM from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ViewPlayerPage } from '@/pages/ViewPlayerPage'

// `sessionClose.closeWithKeepalive` devuelve {emitted:false} si NO hay token en
// storage (mismo origen que lee el interceptor de axios). Sin esto, ningún DELETE
// de cierre saldría y el harness no ejercería la liberación rápida. Es un token
// ficticio: el backend está interceptado por Playwright, nunca se valida.
try { localStorage.setItem('accessToken', 'e2e-token') } catch { /* storage bloqueado */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/views/v1']}>
    <Routes>
      <Route path="/views/:id" element={<ViewPlayerPage />} />
      <Route path="/views" element={<div data-testid="views-index">views index</div>} />
    </Routes>
  </MemoryRouter>,
)
