import { PrismaClient } from '@prisma/client';
import {
  FixtureValidationError,
  runFixtureVerification,
  SeedEnvironmentError,
} from '../src/database/seed-fixtures';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runFixtureVerification(prisma, process.env);
    // eslint-disable-next-line no-console
    console.log('Database fixture verification passed.');
  } catch (error) {
    // Fixture diagnostics are value-free; database errors are intentionally generic.
    // eslint-disable-next-line no-console
    console.error(
      error instanceof FixtureValidationError || error instanceof SeedEnvironmentError
        ? error.message
        : 'Database fixture verification could not complete. Check database connectivity and migrations.',
    );
    process.exitCode = 1;
  }
}

void main();