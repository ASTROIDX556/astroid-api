# Database Guidelines & Migration Verification

All database changes must be managed via Prisma migrations.

## Startup Checks

The API retries PostgreSQL connections during startup using exponential backoff. Configure the total number of attempts with `DATABASE_CONNECT_RETRY_ATTEMPTS` (default `5`) and the initial delay with `DATABASE_CONNECT_RETRY_DELAY_MS` (default `1000` ms). Startup fails if either Prisma pool cannot connect or if any checked-in migration is pending or failed; deploy migrations before starting the API.

## Migration Verification Requirements

- Every migration folder must contain a valid, non-empty `migration.sql` file.
- Migration directories must start with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS`) to ensure strict ordering and avoid conflicts.
- Run `npm run db:verify` locally to execute `scripts/verify-migrations.sh` prior to opening a pull request.
- The CI pipeline automatically runs `scripts/verify-migrations.sh` to validate schema syntax, migration structure, and working tree cleanliness.
