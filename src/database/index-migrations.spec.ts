import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the status + createdAt index migrations (issue #293).
 *
 * The migrations are executed against a real database in CI (`npm run
 * db:verify`), but these structural assertions catch the mistakes that would
 * otherwise only surface during a deploy: an index that was added to the SQL
 * but not to `schema.prisma` (schema drift), a multi-statement `migration.sql`
 * (which makes Postgres reject `CONCURRENTLY`), or a rollback that drops a
 * different index than the one the migration created.
 */
const ROOT = resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = join(ROOT, 'prisma', 'schema.prisma');

interface IndexMigration {
  folder: string;
  model: string;
  table: string;
  columns: string[];
  index: string;
}

const STATUS_CREATED_AT_INDEXES: IndexMigration[] = [
  {
    folder: '20261022090000_add_transactions_org_status_created_at_index',
    model: 'Transaction',
    table: 'transactions',
    columns: ['organizationId', 'status', 'createdAt'],
    index: 'transactions_organizationId_status_createdAt_idx',
  },
  {
    folder: '20261022090100_add_transactions_agent_status_created_at_index',
    model: 'Transaction',
    table: 'transactions',
    columns: ['agentId', 'status', 'createdAt'],
    index: 'transactions_agentId_status_createdAt_idx',
  },
  {
    folder: '20261022090200_add_agents_org_status_created_at_index',
    model: 'Agent',
    table: 'agents',
    columns: ['organizationId', 'status', 'createdAt'],
    index: 'agents_organizationId_status_createdAt_idx',
  },
  {
    folder: '20261022090300_add_wallets_org_status_created_at_index',
    model: 'Wallet',
    table: 'wallets',
    columns: ['organizationId', 'status', 'createdAt'],
    index: 'wallets_organizationId_status_createdAt_idx',
  },
  {
    folder: '20261022090400_add_users_org_status_created_at_index',
    model: 'User',
    table: 'users',
    columns: ['organizationId', 'status', 'createdAt'],
    index: 'users_organizationId_status_createdAt_idx',
  },
];

/** Removes `--` line comments so statement parsing only sees executable SQL. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('--');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');
}

function statements(sql: string): string[] {
  return stripComments(sql)
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function readMigration(folder: string, file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, folder, file), 'utf8');
}

function readModel(model: string): string {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const match = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`));
  expect(match, `model ${model} not found in schema.prisma`).not.toBeNull();
  return match![0];
}

describe('status + createdAt index migrations (#293)', () => {
  it.each(STATUS_CREATED_AT_INDEXES)(
    '$folder is declared in schema.prisma',
    ({ model, columns }) => {
      expect(readModel(model)).toContain(`@@index([${columns.join(', ')}])`);
    },
  );

  it.each(STATUS_CREATED_AT_INDEXES)(
    '$folder creates exactly one concurrent index and ships a matching rollback',
    ({ folder, table, columns, index }) => {
      expect(existsSync(join(MIGRATIONS_DIR, folder, 'migration.sql'))).toBe(true);
      expect(existsSync(join(MIGRATIONS_DIR, folder, 'down.sql'))).toBe(true);

      const up = statements(readMigration(folder, 'migration.sql'));
      expect(up).toHaveLength(1);
      expect(up[0]).toBe(
        `CREATE INDEX CONCURRENTLY "${index}" ON "${table}"(${columns
          .map((column) => `"${column}"`)
          .join(', ')})`,
      );
      // IF NOT EXISTS would silently skip a leftover INVALID index after a
      // failed concurrent build (docs/concurrent-indexes.md).
      expect(up[0]).not.toContain('IF NOT EXISTS');
      expect(index).toBe(`${table}_${columns.join('_')}_idx`);

      const down = statements(readMigration(folder, 'down.sql'));
      expect(down).toHaveLength(1);
      expect(down[0]).toBe(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
    },
  );

  it('every rollback drops exactly the indexes its migration creates', () => {
    const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(MIGRATIONS_DIR, name, 'down.sql')));

    expect(folders.length).toBeGreaterThanOrEqual(STATUS_CREATED_AT_INDEXES.length);

    for (const folder of folders) {
      const created = statements(readMigration(folder, 'migration.sql'))
        .map((statement) => statement.match(/^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?"([^"]+)"/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1]);

      const downStatements = statements(readMigration(folder, 'down.sql'));
      const dropped = downStatements
        .map((statement) => statement.match(/^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?"([^"]+)"/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1]);

      expect(dropped.sort()).toEqual(created.sort());
      for (const statement of downStatements) {
        expect(statement).toMatch(/^DROP INDEX CONCURRENTLY IF EXISTS "[^"]+"$/);
      }
    }
  });
});
