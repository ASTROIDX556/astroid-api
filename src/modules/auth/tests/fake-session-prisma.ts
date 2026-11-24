import { vi } from 'vitest';

/** A session row as the auth service and repository read and write it. */
export interface FakeSessionRow {
  id: string;
  userId: string;
  device: string | null;
  browser: string | null;
  ipAddress: string | null;
  location: string | null;
  refreshTokenHash: string;
  familyId: string;
  consumedAt: Date | null;
  replacedByTokenId: string | null;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface FakeUserRow {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  passwordHash: string | null;
}

type Where = Record<string, unknown>;

/** Equality / null matcher covering the filters the auth repository uses. */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) =>
    expected === null ? row[key] == null : row[key] === expected,
  );
}

/**
 * In-memory stand-in for the slice of `PrismaService` the auth service and
 * `AuthRepository` use. Every session read yields to the event loop first, so
 * two overlapping requests can both observe the same state before either
 * writes: exactly the interleaving the atomic `consumedAt IS NULL` update has
 * to survive.
 */
export function createFakeSessionPrisma(user: FakeUserRow) {
  const sessions = new Map<string, FakeSessionRow>();
  const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  const session = {
    create: vi.fn(async ({ data }: { data: Partial<FakeSessionRow> & { id?: string } }) => {
      const row: FakeSessionRow = {
        id: `session-${sessions.size + 1}`,
        userId: user.id,
        device: null,
        browser: null,
        ipAddress: null,
        location: null,
        refreshTokenHash: '',
        familyId: '',
        consumedAt: null,
        replacedByTokenId: null,
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        revokedAt: null,
        createdAt: new Date(),
        ...data,
      };
      sessions.set(row.id, row);
      return { ...row };
    }),
    findUnique: vi.fn(
      async ({ where, include }: { where: { id: string }; include?: { user?: boolean } }) => {
        await yieldToLoop();
        const row = sessions.get(where.id);
        if (!row) return null;
        return include?.user ? { ...row, user: { ...user } } : { ...row };
      },
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeSessionRow> }) => {
      const row = sessions.get(where.id);
      if (!row) throw new Error('Record to update not found');
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<FakeSessionRow> }) => {
      let count = 0;
      for (const row of sessions.values()) {
        if (matches({ ...row }, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
  };

  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ ...user })),
      findFirst: vi.fn(async () => ({ ...user })),
      update: vi.fn(async () => ({ ...user })),
    },
    session,
    $transaction: vi.fn(async (work: (tx: { session: typeof session }) => Promise<unknown>) =>
      work({ session }),
    ),
  };

  return { prisma, sessions };
}
