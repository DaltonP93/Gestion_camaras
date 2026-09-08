// Política de acceso a NVR / cámara (RBAC por recurso) — FUENTE ÚNICA para las
// rutas de NVR. Complementa a `camera-scope.ts` (que resuelve cámaras sueltas por
// canView) con la semántica a nivel de NVR y de canal.
//
// SEMÁNTICA (alineada con el contrato vigente):
//   - ADMIN y SUPERVISOR: acceso total (no restringido por permisos de recurso).
//     No se amplían privilegios: es exactamente lo que ya hacían las rutas.
//   - Permiso NVR-scoped con canView=true (fila con nvrId y cameraId=null):
//     cubre TODAS las cámaras/canales de ese NVR.
//   - Permiso camera-scoped con canView=true (fila con cameraId): cubre SOLO esa
//     cámara/canal. NO habilita ver las demás cámaras del mismo NVR.
//
// Predicados deterministas sobre Prisma; no tocan red ni loguean credenciales.

type PrismaLike = any

/** ADMIN/SUPERVISOR tienen acceso no restringido por recurso (contrato actual). */
export function isPrivilegedRole(role: string): boolean {
  return role === 'ADMIN' || role === 'SUPERVISOR'
}

/**
 * ¿El usuario puede acceder al NVR? True si es privilegiado, o si tiene un permiso
 * REAL de lectura (canView=true) sobre el NVR o sobre alguna de sus cámaras.
 */
export async function userCanAccessNvr(
  prisma: PrismaLike, userId: string, role: string, nvrId: string,
): Promise<boolean> {
  if (isPrivilegedRole(role)) return true
  const perm = await prisma.userPermission.findFirst({
    where: { userId, canView: true, OR: [{ nvrId }, { camera: { nvrId } }] },
    select: { id: true },
  })
  return !!perm
}

/**
 * ¿El usuario puede acceder a recursos NVR-WIDE (de todo el dispositivo, no de una
 * cámara)? FAIL-CLOSED: sólo privilegiado o un permiso NVR-SCOPED real
 * (nvrId + cameraId=null + canView). Un permiso CAMERA-scoped NO habilita estos
 * endpoints — enumeran/exponen recursos del NVR completo (lista de cámaras del
 * dispositivo, HDDs, device-info, estado del NVR, capacidad de grabación), que un
 * usuario con acceso a una sola cámara no debe poder leer.
 *
 * Contrasta con `userCanAccessNvr` (relación con el NVR por CUALQUIER vía, incl.
 * camera-scoped), que sólo debe gatear colecciones POR-CÁMARA que además se
 * filtran al scope del usuario, nunca recursos de todo el dispositivo.
 */
export async function userCanAccessNvrWide(
  prisma: PrismaLike, userId: string, role: string, nvrId: string,
): Promise<boolean> {
  if (isPrivilegedRole(role)) return true
  const nvrScoped = await prisma.userPermission.findFirst({
    where: { userId, canView: true, nvrId, cameraId: null },
    select: { id: true },
  })
  return !!nvrScoped
}

/**
 * ¿El usuario puede acceder a un CANAL concreto del NVR? Un permiso NVR-scoped
 * (cameraId=null) cubre todos los canales; un permiso camera-scoped sólo cubre el
 * canal de esa cámara. Así un usuario con permiso sobre una sola cámara NO puede
 * leer la configuración de los demás canales del NVR.
 */
export async function userCanAccessNvrChannel(
  prisma: PrismaLike, userId: string, role: string, nvrId: string, channel: number,
): Promise<boolean> {
  if (isPrivilegedRole(role)) return true
  const nvrScoped = await prisma.userPermission.findFirst({
    where: { userId, canView: true, nvrId, cameraId: null },
    select: { id: true },
  })
  if (nvrScoped) return true
  const cameraScoped = await prisma.userPermission.findFirst({
    where: { userId, canView: true, camera: { nvrId, channel } },
    select: { id: true },
  })
  return !!cameraScoped
}

/**
 * Mapa de NVRs visibles para un usuario NO-privilegiado. Por cada NVR indica si ve
 * TODAS sus cámaras (`all=true`, permiso NVR-scoped) o sólo un subconjunto
 * (`cameraIds`, permisos camera-scoped). No incluye NVRs sin ningún permiso.
 * Los llamadores deben tratar ADMIN/SUPERVISOR aparte (ven todo).
 */
export async function getVisibleNvrMap(
  prisma: PrismaLike, userId: string,
): Promise<Map<string, { all: boolean; cameraIds: string[] }>> {
  const perms = await prisma.userPermission.findMany({
    where: { userId, canView: true },
    select: { nvrId: true, cameraId: true, camera: { select: { id: true, nvrId: true } } },
  })
  const map = new Map<string, { all: boolean; cameraIds: string[] }>()
  for (const p of perms as any[]) {
    if (p.cameraId && p.camera?.nvrId) {
      const e = map.get(p.camera.nvrId) ?? { all: false, cameraIds: [] }
      if (!e.cameraIds.includes(p.camera.id)) e.cameraIds.push(p.camera.id)
      map.set(p.camera.nvrId, e)
    } else if (p.nvrId && !p.cameraId) {
      const e = map.get(p.nvrId) ?? { all: false, cameraIds: [] }
      e.all = true
      map.set(p.nvrId, e)
    }
  }
  return map
}
