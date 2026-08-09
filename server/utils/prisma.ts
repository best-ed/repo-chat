import { PrismaClient } from '@prisma/client'

// Nitro reloads server modules on every HMR pass in dev, which would otherwise
// open a new pool per reload and exhaust Postgres connections.
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.__prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma
}
