import { PrismaClient } from '@prisma/client';
import { runSeedCommand } from '../src/database/seed-fixtures';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSeedCommand(prisma, process.env);
    // eslint-disable-next-line no-console
    console.log('Development database fixtures are ready.');
  } catch {
    // Do not print Prisma errors: some adapters include connection details.
    // eslint-disable-next-line no-console
    console.error('Database seeding failed. Check the database and migration status.');
    process.exitCode = 1;
  }
}

void main();