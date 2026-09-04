// apps/api/src/seed.ts
// Poblado inicial de la base de datos con los 4 NVRs y usuario admin
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
// Usa la MISMA clave que el resto del sistema (antes omitía NVR_CREDENTIAL_KEY:
// con esa env definida, los NVRs sembrados quedaban cifrados con otra clave y
// eran indescifrables en runtime)
import { encryptNvrPassword as encryptPassword } from './services/credentials'

const prisma = new PrismaClient()

const NVR_CONFIGS = [
  {
    name: 'NVR UTI',
    model: 'DS-7616NI-K2/16P',
    ipAddress: process.env.NVR_UTI_IP || '192.168.1.100',
    port: parseInt(process.env.NVR_UTI_PORT || '80'),
    rtspPort: 554,
    username: process.env.NVR_UTI_USER || 'admin',
    password: process.env.NVR_UTI_PASS || 'admin_password',
    channels: 16,
    hddCount: 2,
    firmware: 'V3.4.106 build 190702',
    location: 'UTI',
  },
  {
    name: 'NVR_32_SAA_2023',
    model: 'DS-7732NI-K4',
    ipAddress: process.env.NVR_SAA_2023_IP || '192.168.1.101',
    port: parseInt(process.env.NVR_SAA_2023_PORT || '80'),
    rtspPort: 554,
    username: process.env.NVR_SAA_2023_USER || 'admin',
    password: process.env.NVR_SAA_2023_PASS || 'admin_password',
    channels: 32,
    hddCount: 4,
    firmware: 'V4.74.210 build 240108',
    location: 'SAA 2023',
  },
  {
    name: 'NVR Torre Vieja',
    model: 'DS-7732NI-K4',
    ipAddress: process.env.NVR_TORRE_VIEJA_IP || '192.168.1.102',
    port: parseInt(process.env.NVR_TORRE_VIEJA_PORT || '80'),
    rtspPort: 554,
    username: process.env.NVR_TORRE_VIEJA_USER || 'admin',
    password: process.env.NVR_TORRE_VIEJA_PASS || 'admin_password',
    channels: 31,
    hddCount: 2,
    firmware: 'V4.74.210 build 240108',
    location: 'Torre Vieja',
  },
  {
    name: 'NVR SAA Nueva Torre',
    model: 'DS-9664NI-I8',
    ipAddress: process.env.NVR_NUEVA_TORRE_IP || '192.168.1.103',
    port: parseInt(process.env.NVR_NUEVA_TORRE_PORT || '80'),
    rtspPort: 554,
    username: process.env.NVR_NUEVA_TORRE_USER || 'admin',
    password: process.env.NVR_NUEVA_TORRE_PASS || 'admin_password',
    channels: 62,
    hddCount: 4,
    firmware: 'V4.22.005 build 191208',
    location: 'SAA Nueva Torre',
  },
]

async function main() {
  console.log('🌱 Iniciando seed de VisionCore...')

  // ─── Usuario admin ─────────────────────────────────────────
  // Seguridad: NO se hornea una contraseña conocida. La contraseña del admin
  // viene de SEED_ADMIN_PASSWORD; si no se define, se genera una aleatoria fuerte
  // y se muestra UNA sola vez en este log (nunca se persiste en claro ni se
  // versiona). El email/usuario pueden ajustarse por env (no son secretos).
  // Esto no rompe el flujo del seed: el admin siempre se crea.
  const adminUsername = process.env.SEED_ADMIN_USERNAME || 'admin'
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@visioncore.local'
  const providedAdminPassword = process.env.SEED_ADMIN_PASSWORD
  // 24 chars base64url = 18 bytes de entropía. Suficientemente fuerte y sin
  // caracteres problemáticos para copiar/pegar.
  const adminPassword = providedAdminPassword || crypto.randomBytes(18).toString('base64url')
  const adminPasswordGenerated = !providedAdminPassword

  const adminHash = await bcrypt.hash(adminPassword, 12)
  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      username: adminUsername,
      email: adminEmail,
      passwordHash: adminHash,
      fullName: 'Administrador del Sistema',
      role: 'ADMIN',
      active: true,
    },
  })
  if (adminPasswordGenerated) {
    console.log('⚠️  SEED_ADMIN_PASSWORD no definido — se generó una contraseña aleatoria.')
    console.log('    Guardala ahora (se muestra UNA sola vez) y cambiala tras el primer login:')
    console.log(`      usuario:     ${adminUsername}`)
    console.log(`      contraseña:  ${adminPassword}`)
  } else {
    console.log(`✅ Usuario admin creado: ${adminUsername} (contraseña definida por SEED_ADMIN_PASSWORD)`)
  }

  // ─── Usuarios DEMO (supervisor / operador1 / auditor) ──────────
  // Seguridad: en un deploy real NO se crean usuarios con contraseñas conocidas.
  // Igual que el admin, estos usuarios de prueba se gatean por entorno:
  //   - Sólo se crean si SEED_DEMO_USERS=true (opt-in explícito, típicamente dev).
  //   - Con la opción activa, la contraseña de cada uno viene de su env dedicada
  //     (SEED_SUPERVISOR_PASSWORD / SEED_OPERATOR_PASSWORD / SEED_AUDITOR_PASSWORD);
  //     si falta, se genera una aleatoria fuerte y se muestra UNA sola vez.
  //   - Sin SEED_DEMO_USERS, no se crea ningún usuario con password conocido.
  // Esto no rompe el flujo del seed: el admin siempre se crea (arriba) y los NVRs
  // se crean igual más abajo.
  const seedDemoUsers = process.env.SEED_DEMO_USERS === 'true'
  const demoCredentials: Array<{ username: string; password: string; generated: boolean; role: string }> = []

  if (seedDemoUsers) {
    const demoUsers = [
      { username: 'supervisor', email: 'supervisor@visioncore.local', fullName: 'Supervisor de Seguridad', role: 'SUPERVISOR' as const, envVar: 'SEED_SUPERVISOR_PASSWORD' },
      { username: 'operador1',  email: 'operador1@visioncore.local',  fullName: 'Operador Turno Mañana',    role: 'OPERATOR' as const,   envVar: 'SEED_OPERATOR_PASSWORD' },
      { username: 'auditor',    email: 'auditor@visioncore.local',    fullName: 'Auditor de Seguridad',     role: 'AUDITOR' as const,    envVar: 'SEED_AUDITOR_PASSWORD' },
    ]
    for (const u of demoUsers) {
      const provided = process.env[u.envVar]
      const password = provided || crypto.randomBytes(18).toString('base64url')
      const generated = !provided
      const hash = await bcrypt.hash(password, 12)
      await prisma.user.upsert({
        where: { username: u.username },
        update: {},
        create: {
          username: u.username,
          email: u.email,
          passwordHash: hash,
          fullName: u.fullName,
          role: u.role,
          active: true,
        },
      })
      demoCredentials.push({ username: u.username, password, generated, role: u.role })
    }
    console.log('✅ Usuarios DEMO creados (SEED_DEMO_USERS=true)')
    const anyGenerated = demoCredentials.some((c) => c.generated)
    if (anyGenerated) {
      console.log('⚠️  Contraseñas DEMO generadas aleatoriamente (se muestran UNA sola vez — guardalas):')
      for (const c of demoCredentials) {
        if (c.generated) {
          console.log(`      ${c.username.padEnd(11)} / ${c.password}   (${c.role})`)
        }
      }
    }
  } else {
    console.log('ℹ️  Usuarios DEMO omitidos (SEED_DEMO_USERS!=true). Definí SEED_DEMO_USERS=true para crearlos en entornos de prueba.')
  }

  // Crear los 4 NVRs
  for (const config of NVR_CONFIGS) {
    const nvr = await prisma.nVR.upsert({
      where: { name: config.name },
      update: {
        ipAddress: config.ipAddress,
        firmware: config.firmware,
      },
      create: {
        ...config,
        password: encryptPassword(config.password),
      },
    })

    console.log(`✅ NVR creado: ${nvr.name} (${config.ipAddress}) - ${config.channels} canales`)

    // Crear cámaras para este NVR
    for (let ch = 1; ch <= config.channels; ch++) {
      await prisma.camera.upsert({
        where: { nvrId_channel: { nvrId: nvr.id, channel: ch } },
        update: {},
        create: {
          nvrId: nvr.id,
          channel: ch,
          name: `${config.location} - Canal ${String(ch).padStart(2, '0')}`,
          active: true,
          online: false,
          ptzEnabled: false,
        },
      })
    }

    console.log(`  → ${config.channels} cámaras creadas para ${config.name}`)
  }

  console.log('\n🎉 Seed completado exitosamente!')
  console.log('\n📋 Credenciales de acceso:')
  if (adminPasswordGenerated) {
    console.log(`  ${adminUsername}      / (ver contraseña generada arriba)  (Administrador)`)
  } else {
    console.log(`  ${adminUsername}      / (SEED_ADMIN_PASSWORD)  (Administrador)`)
  }
  if (seedDemoUsers) {
    for (const c of demoCredentials) {
      const shown = c.generated ? '(ver contraseña generada arriba)' : `(${c.username === 'supervisor' ? 'SEED_SUPERVISOR_PASSWORD' : c.username === 'operador1' ? 'SEED_OPERATOR_PASSWORD' : 'SEED_AUDITOR_PASSWORD'})`
      console.log(`  ${c.username.padEnd(11)}/ ${shown}  (${c.role})`)
    }
  } else {
    console.log('  (usuarios DEMO omitidos — definí SEED_DEMO_USERS=true para crearlos)')
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
