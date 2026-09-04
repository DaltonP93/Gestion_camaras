// apps/api/src/services/onvif/parse.ts
//
// NÚCLEO PURO — parsers de respuestas SOAP ONVIF y de WS-Discovery ProbeMatch.
//
// XXE-SAFE POR DISEÑO: NO se usa ningún parser XML con resolución de entidades.
// La extracción es por regex acotada sobre el texto, así que ninguna entidad
// externa ni DTD se expande jamás (no hay parser que lo haga). Como defensa en
// profundidad, `stripDoctype()` elimina cualquier `<!DOCTYPE …>` y bloques CDATA
// se tratan como texto literal. Nunca se hace fetch de SYSTEM/PUBLIC ids.
//
// Se toleran prefijos de namespace arbitrarios (tt:, trt:, tds:, etc.) y la
// ausencia de prefijo, igual que el patrón xmlGet de services/hikvision.ts.

/** Elimina declaraciones DOCTYPE (defensa XXE) antes de cualquier extracción. */
export function stripDoctype(xml: string): string {
  return xml.replace(/<!DOCTYPE[^>]*(\[[\s\S]*?\])?[^>]*>/gi, '')
}

/** Escapa metacaracteres regex de un nombre de tag. */
function esc(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Primer valor de texto de <[ns:]tag>…</[ns:]tag> (namespace-tolerante). */
export function tagText(xml: string, tag: string): string | null {
  const t = esc(tag)
  const m = xml.match(new RegExp(`<([A-Za-z0-9_.-]+:)?${t}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${t}>`, 'i'))
  if (!m) return null
  return decodeBasicEntities(m[2].trim())
}

/** Todos los bloques completos <[ns:]tag …>…</[ns:]tag>. */
export function tagBlocks(xml: string, tag: string): string[] {
  const t = esc(tag)
  const re = new RegExp(`<([A-Za-z0-9_.-]+:)?${t}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${t}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[0])
  return out
}

/** Valor de un atributo del primer tag que lo tenga (p.ej. token="…"). */
export function attrOf(xml: string, tag: string, attr: string): string | null {
  const t = esc(tag)
  const a = esc(attr)
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${t}\\b[^>]*\\b${a}="([^"]*)"`, 'i'))
  return m ? decodeBasicEntities(m[1]) : null
}

/** Decodifica sólo las 5 entidades predefinidas de XML (nunca entidades custom). */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ─── SOAP Fault ───────────────────────────────────────────────

export interface SoapFault {
  code: string | null
  reason: string | null
  subcode: string | null
}

/** Detecta y extrae un <Fault> SOAP 1.2 (o 1.1). null si no hay fault. */
export function parseSoapFault(xml: string): SoapFault | null {
  const clean = stripDoctype(xml)
  if (!/<(?:[A-Za-z0-9_.-]+:)?Fault\b/i.test(clean)) return null
  // SOAP 1.2: Code/Value, Reason/Text. SOAP 1.1: faultcode, faultstring.
  const code = tagText(clean, 'Value') ?? tagText(clean, 'faultcode')
  const reason = tagText(clean, 'Text') ?? tagText(clean, 'faultstring')
  const subcodeBlocks = tagBlocks(clean, 'Subcode')
  const subcode = subcodeBlocks.length > 0 ? tagText(subcodeBlocks[0], 'Value') : null
  return { code, reason, subcode }
}

// ─── Media: GetStreamUri ──────────────────────────────────────

/** Extrae la URI RTSP de una respuesta GetStreamUri. null si ausente. */
export function parseStreamUri(xml: string): string | null {
  const clean = stripDoctype(xml)
  // La respuesta trae <MediaUri><Uri>rtsp://…</Uri>… Preferir dentro de MediaUri.
  const mediaUri = tagBlocks(clean, 'MediaUri')[0]
  const uri = mediaUri ? tagText(mediaUri, 'Uri') : tagText(clean, 'Uri')
  return uri && uri.length > 0 ? uri : null
}

// ─── Media: GetProfiles ───────────────────────────────────────

export interface OnvifProfile {
  token: string
  name: string | null
  /** Token de la fuente de video (VideoSourceConfiguration.SourceToken). */
  videoSourceToken: string | null
  encoding: string | null
  width: number | null
  height: number | null
}

export function parseProfiles(xml: string): OnvifProfile[] {
  const clean = stripDoctype(xml)
  const blocks = tagBlocks(clean, 'Profiles')
  const out: OnvifProfile[] = []
  for (const b of blocks) {
    const token = attrOf(b, 'Profiles', 'token')
    if (!token) continue
    const vsc = tagBlocks(b, 'VideoSourceConfiguration')[0] ?? ''
    const enc = tagBlocks(b, 'VideoEncoderConfiguration')[0] ?? ''
    const res = enc ? tagBlocks(enc, 'Resolution')[0] ?? '' : ''
    const w = res ? tagText(res, 'Width') : null
    const h = res ? tagText(res, 'Height') : null
    out.push({
      token,
      name: tagText(b, 'Name'),
      videoSourceToken: vsc ? tagText(vsc, 'SourceToken') : null,
      encoding: enc ? tagText(enc, 'Encoding') : null,
      width: w ? Number(w) : null,
      height: h ? Number(h) : null,
    })
  }
  return out
}

// ─── PTZ: GetConfigurations ───────────────────────────────────

export interface PtzConfiguration {
  token: string
  name: string | null
  nodeToken: string | null
}

export function parsePtzConfigurations(xml: string): PtzConfiguration[] {
  const clean = stripDoctype(xml)
  const blocks = tagBlocks(clean, 'PTZConfiguration')
  const out: PtzConfiguration[] = []
  for (const b of blocks) {
    const token = attrOf(b, 'PTZConfiguration', 'token')
    if (!token) continue
    out.push({ token, name: tagText(b, 'Name'), nodeToken: tagText(b, 'NodeToken') })
  }
  return out
}

// ─── Imaging: GetImagingSettings ──────────────────────────────

export interface ImagingSettings {
  brightness: number | null
  contrast: number | null
  colorSaturation: number | null
  sharpness: number | null
  irCutFilter: string | null
  focus: { autoFocusMode: string | null; defaultSpeed: number | null } | null
}

export function parseImagingSettings(xml: string): ImagingSettings {
  const clean = stripDoctype(xml)
  const scope = tagBlocks(clean, 'ImagingSettings')[0] ?? clean
  const num = (t: string): number | null => {
    const v = tagText(scope, t)
    return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
  }
  const focusBlock = tagBlocks(scope, 'Focus')[0]
  return {
    brightness: num('Brightness'),
    contrast: num('Contrast'),
    colorSaturation: num('ColorSaturation'),
    sharpness: num('Sharpness'),
    irCutFilter: tagText(scope, 'IrCutFilter'),
    focus: focusBlock
      ? {
          autoFocusMode: tagText(focusBlock, 'AutoFocusMode'),
          defaultSpeed: (() => {
            const v = tagText(focusBlock, 'DefaultSpeed')
            return v !== null && Number.isFinite(Number(v)) ? Number(v) : null
          })(),
        }
      : null,
  }
}

// ─── WS-Discovery: ProbeMatch ─────────────────────────────────

export interface ProbeMatch {
  /** EndpointReference/Address (urn:uuid:…). */
  endpoint: string | null
  /** XAddrs: URLs de servicio del dispositivo (separadas por espacio). */
  xaddrs: string[]
  types: string | null
  scopes: string[]
}

export function parseProbeMatches(xml: string): ProbeMatch[] {
  const clean = stripDoctype(xml)
  const blocks = tagBlocks(clean, 'ProbeMatch')
  const out: ProbeMatch[] = []
  for (const b of blocks) {
    const addr = tagText(b, 'Address')
    const xaddrsRaw = tagText(b, 'XAddrs') ?? ''
    const scopesRaw = tagText(b, 'Scopes') ?? ''
    out.push({
      endpoint: addr,
      xaddrs: xaddrsRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean),
      types: tagText(b, 'Types'),
      scopes: scopesRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean),
    })
  }
  return out
}
