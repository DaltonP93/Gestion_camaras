# Track 2 · Capstone del cliente nativo + alcance

## Entregado ✅ — `NativePlaybackController` (shared-core)
`apps/native/shared/native-controller.ts`. Compone las piezas de C22/N2 en un
único controlador usable por la app de plataforma:

```
coordinator (grant+decoder, latest-wins)
  + lifecycle-binder (hidden/visible/pagehide → invalidate/dispose)
  + applyPlaybackDecision (decisión del server → coordinador)
```

- **Cierra el lazo de N2a:** `onResume` del binder ahora **re-aplica la última
  decisión** del servidor (al volver a foreground se re-abre con el mismo
  contexto) en vez de dejar el gancho vacío. `onResume` se amplió a *awaitable*
  para que el resume sea determinista y testeable.
- API: `show(decision, ctx)`, `onHidden/onVisible/onPageHide`, `dispose()`;
  getters `suspended`/`lastDecision`/`isDisposed`.
- TS puro (sin DOM/Tauri): la plataforma cablea sus eventos a estos métodos.
- **No cambia autoridad ni invariantes:** la decisión la toma el servidor
  (`decideLivePlayback`); la reserva de cupo sigue en el stream-manager (C1–C21);
  aquí sólo se orquesta el lifecycle del cliente. Sólo corre si la app nativa lo
  usa (flags nativas existentes, OFF por defecto).
- 6 tests (incl. `hidden→visible` re-open, resume de decisión de servidor,
  dispose inerte). Native: **6 files / 37 tests** verde; `tsc` limpio.
- Mutación **M19** (resume no re-aplica) añadida al runner.

## Deliberadamente NO tocado (protección de invariantes / requiere greenlight)
"Otros subsistemas" en un VMS con invariantes C1–C21 muy sensibles: modificar su
core de forma autónoma contradiría la protección de invariantes que se sostuvo
todas las rondas. Estos quedan como **candidatos con greenlight explícito** (y,
varios, con infra real que aquí no existe):

- **stream-manager / capacidad**: la reserva del límite de 2 y el TTL de 90s son
  el invariante duro; sólo `waitForCapacity` (N2b) se entregó como helper que
  *observa*, sin tocar la reserva. Adoptarlo en el flujo real es un cambio con
  greenlight.
- **recordings / retención / preview**: lógica sensible (leases, cierre exacto);
  sin cambios.
- **AI pipeline**: ya endurecido (P0-7). Extensiones (2.º proveedor, métricas)
  posibles detrás de `AI_EVENTS_ENABLED`, pendientes de dirección.
- **web live-view (React)**: consume HLS; una capa que consuma el contrato de
  decisión/nativo es front-end, pendiente de dirección.
- **NVR config / search / dashboard**: fuera del alcance de esta ronda.

Estos son los ítems a auditar/dirigir con Codex el 7.
