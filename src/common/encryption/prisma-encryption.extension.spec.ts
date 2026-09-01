import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptionService } from './encryption.service';
import { createPrismaEncryptionExtension } from './prisma-encryption.extension';

describe('createPrismaEncryptionExtension', () => {
  let encryptionService: EncryptionService;

  beforeEach(() => {
    encryptionService = new EncryptionService();
    encryptionService.onModuleInit();
  });

  it('should encrypt fields on write operations and decrypt on read operations', async () => {
    const extension = createPrismaEncryptionExtension({
      encryptionService,
      fields: { Agent: ['metadata'] },
    });

    const queryHandler = extension.query.$allOperations;
    let storedDbRecord: { metadata: Record<string, unknown> } = { metadata: {} };

    // Simulate `prisma.agent.create`
    const createArgs = {
      data: {
        name: 'Finance Agent',
        metadata: {
          privateKey: 'SECRET_STELLAR_KEY',
          safeField: 'hello',
        },
      },
    };

    const mockCreateQuery = async (args: unknown): Promise<unknown> => {
      const typedArgs = args as { data: { metadata: Record<string, unknown> } };
      storedDbRecord = JSON.parse(JSON.stringify(typedArgs.data)) as {
        metadata: Record<string, unknown>;
      };
      return { id: 'agent-1', ...storedDbRecord };
    };

    const createdResult = (await queryHandler({
      model: 'Agent',
      operation: 'create',
      args: createArgs,
      query: mockCreateQuery,
    })) as { metadata: Record<string, unknown> };

    // In the stored database record, the privateKey inside metadata must be encrypted
    expect(encryptionService.isEncrypted(storedDbRecord.metadata.privateKey)).toBe(true);
    expect(storedDbRecord.metadata.safeField).toBe('hello');

    // The returned result from the query must have decrypted metadata
    expect(createdResult.metadata.privateKey).toBe('SECRET_STELLAR_KEY');
    expect(createdResult.metadata.safeField).toBe('hello');

    // Simulate `prisma.agent.findFirst` reading the storedDbRecord
    const mockFindQuery = async (): Promise<unknown> => {
      return { id: 'agent-1', ...storedDbRecord };
    };

    const findResult = (await queryHandler({
      model: 'Agent',
      operation: 'findFirst',
      args: { where: { id: 'agent-1' } },
      query: mockFindQuery,
    })) as { metadata: Record<string, unknown> };

    expect(findResult.metadata.privateKey).toBe('SECRET_STELLAR_KEY');
    expect(findResult.metadata.safeField).toBe('hello');
  });

  it('should pass through models and operations that do not match configured fields', async () => {
    const extension = createPrismaEncryptionExtension({
      encryptionService,
      fields: { Agent: ['metadata'] },
    });

    const queryHandler = extension.query.$allOperations;
    const args = { data: { name: 'Acme Corp' } };

    const mockQuery = async (passedArgs: unknown): Promise<unknown> => {
      const typed = passedArgs as { data: Record<string, unknown> };
      return { id: 'org-1', ...typed.data };
    };

    const result = await queryHandler({
      model: 'Organization',
      operation: 'create',
      args,
      query: mockQuery,
    });

    expect(result).toEqual({ id: 'org-1', name: 'Acme Corp' });
  });
});
