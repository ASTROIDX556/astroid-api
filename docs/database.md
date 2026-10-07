# Database Guidelines & Migration Verification

All database changes must be managed via Prisma migrations.

## Startup Checks

The API retries PostgreSQL connections during startup using exponential backoff. Configure the total number of attempts with `DATABASE_CONNECT_RETRY_ATTEMPTS` (default `5`) and the initial delay with `DATABASE_CONNECT_RETRY_DELAY_MS` (default `1000` ms). Startup fails if either Prisma pool cannot connect or if any checked-in migration is pending or failed; deploy migrations before starting the API.

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
## Migration CLI and Rollback Protection

`npm run db:migrate -- <command>` wraps the Prisma migration commands behind a production safety guard (`src/database/migration-guard.ts`).

| Command | Effect | Destructive |
| --- | --- | --- |
| `deploy` | Applies pending migrations (`prisma migrate deploy`). | No |
| `status` | Reports applied and pending migrations. | No |
| `down <migration>` | Executes the migration's `down.sql`, then removes it from `_prisma_migrations` in the same script so `deploy` can re-apply it later. | Yes |
| `reset` | Drops and recreates the database (`prisma migrate reset`). | Yes |

Destructive commands are **rejected when `NODE_ENV=production`**: the CLI prints a warning to stderr, exits with code `1`, and never contacts the database. To proceed intentionally, take a verified backup and re-run with `--force`; the override itself is also announced on stderr.

```bash
# Blocked in production
NODE_ENV=production npm run db:migrate -- down 20260901080000_add_cleanup_job_logs

# Explicit override
NODE_ENV=production npm run db:migrate -- down 20260901080000_add_cleanup_job_logs --force
```

Prisma does not generate down migrations. To make a migration reversible, add a hand-written `down.sql` next to its `migration.sql`. One way to draft it is to run the following after editing `schema.prisma` but **before** applying the new migration, so the diff goes from the new datamodel back to the current database state:

```bash
npx prisma migrate diff   --from-schema-datamodel prisma/schema.prisma   --to-schema-datasource prisma/schema.prisma   --script > prisma/migrations/<migration>/down.sql
```

Review the generated SQL by hand before relying on it. `down` refuses to run for a migration without a `down.sql`.
