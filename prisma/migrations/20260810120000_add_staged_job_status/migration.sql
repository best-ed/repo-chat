-- AlterEnum
-- Placed before CHUNKING so the type's ordering in Postgres matches the
-- declaration order in schema.prisma. A plain `ADD VALUE` appends to the end of
-- the enum, which would leave the database and the schema reading differently.
ALTER TYPE "JobStatus" ADD VALUE 'STAGED' BEFORE 'CHUNKING';
