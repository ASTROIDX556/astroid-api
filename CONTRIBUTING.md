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
npm run db:verify         # verify migration structure and drift-free state
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
2. Run `npm run db:verify` locally to verify migration structure, syntax validity, and drift-free state (`scripts/verify-migrations.sh`).
3. Database schema changes include a valid Prisma migration folder containing `migration.sql`.
4. New endpoints are documented with OpenAPI/Swagger decorators.
5. Cross-repo contracts (response envelope, entity/enum names) still match `astroid-web` and `astroid-sdk`.

## Branch strategy

`main` is always releasable. Use `feature/*` and `fix/*` branches and open PRs
against `main`. See the PRD (Document 3) for the full branching model.

By contributing you agree that your contributions are licensed under the MIT License.
