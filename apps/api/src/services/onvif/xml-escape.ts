// apps/api/src/services/onvif/xml-escape.ts
//
// NÚCLEO PURO — escape mínimo de texto para incrustar en XML/SOAP.
// Evita inyección de marcado si un token/valor trae caracteres especiales.

export function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
