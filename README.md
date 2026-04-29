# VisionCore — Sistema de Gestión de Cámaras NVR Hikvision

Sistema web completo para gestión centralizada de múltiples NVRs Hikvision con streaming en vivo, grabaciones, gestión de usuarios y control de acceso por roles.

## NVRs soportados en este despliegue

| NVR | Modelo | Canales | HDDs |
|-----|--------|---------|------|
| NVR 1 | DS-7xxxxx/16P | 16 | 2 |
| NVR2 | DS-xxxxx | 32 | 4 |
| NVR3 | DS-xxxxx| 31 | 2 |
| NVR4 | DS-xxxxxxx | 62 | 4 |

## Stack tecnológico

- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS
- **Backend**: Node.js + Fastify + Prisma ORM
- **Base de datos**: PostgreSQL
- **Caché**: Redis
- **Video proxy**: MediaMTX (RTSP → HLS/WebRTC)
- **Reverse proxy**: Nginx + SSL
- **Contenedores**: Docker + Docker Compose

## Roles del sistema

| Rol | Vista en vivo | Grabaciones | PTZ | Config NVR | Usuarios |
|-----|:---:|:---:|:---:|:---:|:---:|
| Administrador | ✅ Todos | ✅ Todos | ✅ | ✅ | ✅ |
| Supervisor | ✅ Todos | ✅ Todos | ✅ | ❌ | ❌ |
| Operador | ✅ Asignados | ❌ | ✅ Asignados | ❌ | ❌ |
| Auditor | ❌ | ✅ Asignados | ❌ | ❌ | ❌ |

## Inicio rápido

### Prerrequisitos
- Docker >= 24.0
- Docker Compose >= 2.0
- Acceso de red a los NVRs Hikvision

### 1. Clonar y configurar

```bash
git clone https://github.com/DaltonP93/Gestion_camaras.git
cd Gestion_camaras
cp .env.example .env
```

### 2. Editar `.env` con tus IPs de NVR

```env
NVR_1_IP=192.x.x.x
NVR_2_IP=192.x.x.x
NVR_3_IP=192.x.x.x
NVR_4_IP=192.x.x.x
```

### 3. Levantar todo

```bash
docker-compose up -d
```

### 4. Acceder

- **Web app**: http://localhost:3000
- **API**: http://localhost:4000
- **Usuario por defecto**: `admin` / `Admin123!`

## Estructura del proyecto

```
Gestion_camaras/
├── apps/
│   ├── api/                  # Backend Fastify
│   │   └── src/
│   │       ├── routes/       # auth, nvr, cameras, recordings, users
│   │       ├── services/     # HikVision ISAPI, streaming
│   │       ├── plugins/      # JWT, Prisma, Redis, Socket.io
│   │       └── jobs/         # Workers BullMQ
│   └── web/                  # Frontend React
│       └── src/
│           ├── pages/        # Dashboard, LiveView, Recordings, Users
│           ├── components/   # CameraGrid, NVRCard, VideoPlayer
│           ├── stores/       # Zustand stores
│           └── lib/          # API client, websocket
├── infra/
│   ├── mediamtx/             # Proxy RTSP → HLS
│   └── nginx/                # Reverse proxy
├── prisma/
│   └── schema.prisma         # Schema de base de datos
├── docker-compose.yml
└── .env.example
```

## Integración Hikvision ISAPI

El sistema se conecta via HTTP REST (ISAPI) y RTSP:

```
NVR (RTSP :554) → MediaMTX → HLS/WebRTC → Navegador web
NVR (ISAPI :80) → API Fastify → REST JSON → React frontend
```

## Licencia

MIT
