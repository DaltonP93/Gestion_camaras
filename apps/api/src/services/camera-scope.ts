// Scope de cámaras por permiso `canView` (RBAC por recurso). Fuente ÚNICA usada
// por las rutas que filtran "lo que el usuario puede ver" (cámaras y alertas).
//
// Deliberadamente NO decide el bypass de rol: cada ruta aplica su propia política
// (cameras.ts trata ADMIN+SUPERVISOR como no restringidos; alerts.ts sólo ADMIN).
// Este helper devuelve SÓLO los cameraIds con `canView=true` del usuario, sin
// lógica de rol, para poder centralizarlo sin cambiar el comportamiento de ninguna
// ruta existente.
export async function getViewableCameraIds(prisma: any, userId: string): Promise<string[]> {
  const perms = await prisma.userPermission.findMany({
    where: { userId, cameraId: { not: null }, canView: true },
    select: { cameraId: true },
  })
  return perms.map((p: any) => p.cameraId as string).filter(Boolean)
}
