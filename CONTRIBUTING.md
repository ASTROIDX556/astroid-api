# Contributing to the Astroid API

Thanks for your interest in improving the backend for Astroid — the Financial
Operating System for autonomous AI agents on Stellar. We develop in the open
and welcome issues, discussion, and pull requests.

## Getting started

```bash
git clone https://github.com/ASTROIDX556/astroid-api.git
cd astroid-api
npm install
cp .env.example .env     # fill in your database and API keys
npx prisma generate      # generate the Prisma client
npm run start:dev         # start the NestJS dev server
npm run typecheck         # strict TypeScript checking
npm run test              # run the vitest suites
```

The backend is a **NestJS modular monolith** using TypeScript, Prisma,
PostgreSQL, Redis, and BullMQ. Every module is isolated so it can later become
its own microservice.

## Ground rules

- **Strict TypeScript.** `strict` is on and `any` is banned. Prefer generics and precise types.
- **Module conventions.** Every module follows the same structure: controller, service, repository, DTOs, entity, events, validators, types, tests. Consistency is mandatory.
- **Thin controllers.** Controllers validate input and delegate to services. Business logic lives in services; persistence in repositories.
- **Conventional Commits.** `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, etc.
- **Tests are required** for new behaviour. Unit tests use vitest. Never call external services in unit tests.
- **Audit trail.** Every important action must be logged to the audit module.

## Pull request checklist

1. `npm run typecheck && npm run lint && npm run test` all pass.
2. Database schema changes include a Prisma migration.
3. `npm run db:verify:static` passes — see [Database migration verification](#database-migration-verification).
4. New endpoints are documented with OpenAPI/Swagger decorators.
5. Cross-repo contracts (response envelope, entity/enum names) still match `astroid-web` and `astroid-sdk`.

## Database migration verification

Schema changes in Prisma are strictly verified before they reach production so a
malformed or drifted migration can never break a deployment. CI runs two jobs
on every pull request:

| Job | Requires a database | What it checks |
|---|---|---|
| `migrations (static)` (`npm run db:verify:static`) | No | Every migration directory has a non-empty `migration.sql` containing executable SQL (not only comments), quotes/parentheses are balanced, and directory names follow the Prisma convention `<UTC-timestamp>_<snake_case_name>` |
| `migrations (database)` (`npm run db:verify`) | Yes | Migrations apply cleanly to a fresh PostgreSQL instance and the schema rebuilt from the migrations alone matches `prisma/schema.prisma` (no drift) |

### Naming convention

Migration directories **must** be named `<UTC-timestamp>_<snake_case_name>`
(e.g. `20260830174000_sync_schema`). CI fails the build otherwise. Create
migrations with `npm run prisma:migrate` — never by hand.

### Locally

```bash
npm run db:verify:static   # fast static checks, no database needed
npm run db:verify          # full verification (needs DATABASE_URL, and
                           # SHADOW_DATABASE_URL for the drift check)
```

The static mode is what containerized CI runners without an active PostgreSQL
connection use; the full script degrades to it automatically when `DATABASE_URL`
is unset.

## Branch strategy

`main` is always releasable. Use `feature/*` and `fix/*` branches and open PRs
against `main`. See the PRD (Document 3) for the full branching model.

By contributing you agree that your contributions are licensed under the MIT License.
