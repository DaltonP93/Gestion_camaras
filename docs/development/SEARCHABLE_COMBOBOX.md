# SearchableCombobox — alcance e integración

Componente `apps/web/src/components/ui/SearchableCombobox.tsx`: selector con
buscador reutilizable para listas grandes y dinámicas.

## Qué ofrece
- Búsqueda por texto **insensible a mayúsculas/minúsculas y a tildes** sobre
  `label + sublabel + group + keywords`.
- Agrupación por `group` (p.ej. NVR).
- Teclado: ↑ ↓ Enter Escape, con `aria-activedescendant`.
- Botón limpiar, estados vacío / `disabled` / `loading`.
- Contenedor con scroll y tope de render `maxRender` (300 por defecto).

## Importante: NO virtualiza
Renderiza hasta `maxRender` opciones dentro de un contenedor con scroll — **no**
usa virtualización real. Con el default de 300, una lista de 144 cámaras se
muestra completa y scrolleable; el tope sólo recorta listas mucho mayores (ahí
aparece `+N más — refiná la búsqueda`). Para listas de miles de ítems, migrar a
virtualización real (react-virtual/react-window).

## Dónde está integrado (a hoy)
Sólo en **Analítica de video** (`AnalyticsPage`):
- Configuración → selector de cámara.
- Vista en vivo → selector de cámara con analítica.
- Forense → filtro de cámara.

## Pendiente (fase 2 — NO incluido en este PR)
La integración en el resto de módulos con listas extensas queda para una segunda
fase, para acotar el riesgo de este fix:
- Grabaciones (hoy multi-select por checkboxes — requiere un patrón multi-select
  o adaptación distinta, no un simple reemplazo de `<select>`).
- Usuarios / permisos.
- Visores.
- Alertas.
- Selección de NVR.

Los `<select>` de enums cortos (severidad, dirección, tipo de evento, layout) se
mantienen nativos a propósito — el combobox es sólo para listas grandes.
