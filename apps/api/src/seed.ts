// apps/api/src/seed.ts
// Poblado inicial de la base de datos con los 4 NVRs y usuario admin
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
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

  // Crear usuario admin por defecto
  const adminHash = await bcrypt.hash('Admin123!', 12)
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@visioncore.local',
      passwordHash: adminHash,
      fullName: 'Administrador del Sistema',
      role: 'ADMIN',
      active: true,
    },
  })
  console.log(`✅ Usuario admin creado: admin / Admin123!`)

  // Crear usuarios de prueba
  const supervisorHash = await bcrypt.hash('Super123!', 12)
  await prisma.user.upsert({
    where: { username: 'supervisor' },
    update: {},
    create: {
      username: 'supervisor',
      email: 'supervisor@visioncore.local',
      passwordHash: supervisorHash,
      fullName: 'Supervisor de Seguridad',
      role: 'SUPERVISOR',
      active: true,
    },
  })

  const operatorHash = await bcrypt.hash('Oper123!', 12)
  await prisma.user.upsert({
    where: { username: 'operador1' },
    update: {},
    create: {
      username: 'operador1',
      email: 'operador1@visioncore.local',
      passwordHash: operatorHash,
      fullName: 'Operador Turno Mañana',
      role: 'OPERATOR',
      active: true,
    },
  })

  const auditorHash = await bcrypt.hash('Audit123!', 12)
  await prisma.user.upsert({
    where: { username: 'auditor' },
    update: {},
    create: {
      username: 'auditor',
      email: 'auditor@visioncore.local',
      passwordHash: auditorHash,
      fullName: 'Auditor de Seguridad',
      role: 'AUDITOR',
      active: true,
    },
  })

  console.log('✅ Usuarios de prueba creados')

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
  console.log('  admin      / Admin123!  (Administrador)')
  console.log('  supervisor / Super123!  (Supervisor)')
  console.log('  operador1  / Oper123!   (Operador)')
  console.log('  auditor    / Audit123!  (Auditor)')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
