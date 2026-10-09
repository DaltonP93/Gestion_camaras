// Usuario simulado del prototipo. No hay login: un selector de rol permite revisar
// la experiencia de cada perfil con las MISMAS reglas que aplica la API.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { USERS, type ProtoUser } from './sim/mock'
import { ViewerRepo, browserStorage } from './model/viewers'

const USER_KEY = 'vc-proto:user:v1'

interface Session {
  user: ProtoUser
  setUserId: (id: string) => void
  viewers: ViewerRepo
}

const Ctx = createContext<Session | null>(null)

function initialUserId(): string {
  try {
    const id = window.localStorage.getItem(USER_KEY)
    if (id && USERS.some(u => u.id === id)) return id
  } catch { /* sin almacenamiento */ }
  return USERS[0].id
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserIdState] = useState(initialUserId)
  const viewers = useMemo(() => new ViewerRepo(browserStorage()), [])
  const user = USERS.find(u => u.id === userId) ?? USERS[0]
  const setUserId = (id: string) => {
    setUserIdState(id)
    try { window.localStorage.setItem(USER_KEY, id) } catch { /* sin almacenamiento */ }
  }
  return <Ctx.Provider value={{ user, setUserId, viewers }}>{children}</Ctx.Provider>
}

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession fuera de SessionProvider')
  return s
}

export const ROLE_LABEL: Record<ProtoUser['role'], string> = {
  ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operador',
  AUDITOR: 'Auditor',
}
