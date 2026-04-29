// apps/api/src/plugins/prisma.ts
import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'
import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

const prismaPlugin: FastifyPluginAsync = fp(async (server) => {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
  })

  await prisma.$connect()
  server.decorate('prisma', prisma)

  server.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect()
  })

  server.log.info('Prisma conectado a PostgreSQL')
})

export { prismaPlugin }
