# Database Guidelines & Migration Verification

All database changes must be managed via Prisma migrations. 

## Migration Verification Requirements
- Every migration folder must contain a valid, non-empty `migration.sql` file.
- Migration directories must start with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS`) to ensure strict ordering and avoid conflicts.
- Run `npm run db:verify` locally to execute `scripts/verify-migrations.sh` prior to opening a pull request.
- The CI pipeline automatically runs `scripts/verify-migrations.sh` to validate schema syntax, migration structure, and working tree cleanliness.
