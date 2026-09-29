# Database Guidelines & Migration Verification

All database changes must be managed via Prisma migrations. 

## Migration Verification Requirements
- Every migration folder must contain a valid, non-empty `migration.sql` file.
- Migration directories must start with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS`) to ensure strict ordering and avoid conflicts.
- Run `npm run db:verify` locally to execute `scripts/verify-migrations.sh` prior to opening a pull request.
- The CI pipeline automatically runs `scripts/verify-migrations.sh` to validate schema syntax, migration structure, and working tree cleanliness.

## Startup Migration Check
Before the HTTP server starts listening, `main.ts` calls `PrismaService.verifyMigrations()`, which compares the folders in `prisma/migrations` with the rows in `_prisma_migrations` (rolled-back rows are ignored). The behaviour is controlled by `DATABASE_MIGRATION_CHECK`:

| Mode | Default for | Pending or failed migrations | Migration history unreadable (e.g. DB down) |
|------|-------------|------------------------------|---------------------------------------------|
| `strict` | `NODE_ENV=production` | Logs the offending migrations with remediation steps and aborts startup (exit code 1) | Aborts startup |
| `warn` | every other environment | Logs the same instructions and keeps booting | Logs a warning and keeps booting |
| `off` | never | Check skipped | Check skipped |

To recover from an aborted start:
- Pending migrations: run `npm run prisma:deploy` against the target `DATABASE_URL`, then restart the service.
- Failed migrations: inspect the `logs` column in `_prisma_migrations`, repair the database, run `npx prisma migrate resolve --rolled-back <name>` (or `--applied <name>`), then redeploy.

If the runtime image keeps migrations somewhere other than `<cwd>/prisma/migrations`, point `DATABASE_MIGRATIONS_DIR` at that folder. When no migrations are found on disk, the check logs a warning instead of silently passing.
