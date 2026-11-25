import { EncryptionService } from './encryption.service';

export interface PrismaEncryptionExtensionOptions {
  encryptionService: EncryptionService;
  /**
   * Models and their respective fields that should be encrypted on write
   * and decrypted on read.
   */
  fields?: Record<string, string[]>;
}

export interface PrismaEncryptionClientExtension {
  name: string;
  query: {
    $allOperations: (params: {
      model?: string;
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) => Promise<unknown>;
  };
}

function encryptValue(value: unknown, encryptionService: EncryptionService): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return encryptionService.isEncrypted(value) ? value : encryptionService.encrypt(value);
  }
  if (typeof value === 'object') {
    return encryptionService.transformSensitiveFields(value, 'encrypt');
  }
  return value;
}

function decryptValue(value: unknown, encryptionService: EncryptionService): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' && encryptionService.isEncrypted(value)) {
    try {
      const decrypted = encryptionService.decrypt(value);
      try {
        return JSON.parse(decrypted);
      } catch {
        return decrypted;
      }
    } catch {
      return value;
    }
  }
  if (typeof value === 'object') {
    return encryptionService.transformSensitiveFields(value, 'decrypt');
  }
  return value;
}

function encryptModelData(
  data: unknown,
  fields: string[],
  encryptionService: EncryptionService,
): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => encryptModelData(item, fields, encryptionService));
  }

  const result = { ...(data as Record<string, unknown>) };
  for (const field of fields) {
    if (field in result && result[field] !== undefined) {
      result[field] = encryptValue(result[field], encryptionService);
    }
  }
  return result;
}

function decryptModelResult(
  result: unknown,
  fields: string[],
  encryptionService: EncryptionService,
): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }

  if (Array.isArray(result)) {
    return result.map((item) => decryptModelResult(item, fields, encryptionService));
  }

  const decrypted = { ...(result as Record<string, unknown>) };
  for (const field of fields) {
    if (field in decrypted && decrypted[field] !== undefined) {
      decrypted[field] = decryptValue(decrypted[field], encryptionService);
    }
  }
  return decrypted;
}

/**
 * Creates a Prisma Client Extension that automatically encrypts sensitive fields on save
 * and decrypts them on retrieval.
 */
export function createPrismaEncryptionExtension(
  options: PrismaEncryptionExtensionOptions,
): PrismaEncryptionClientExtension {
  const {
    encryptionService,
    fields = {
      Agent: ['metadata'],
      agent: ['metadata'],
    },
  } = options;

  return {
    name: 'encryptionAtRest',
    query: {
      async $allOperations({ model, operation: _operation, args, query }) {
        if (!model) {
          return query(args);
        }

        const modelFields =
          fields[model] ||
          fields[model.toLowerCase()] ||
          fields[model.charAt(0).toUpperCase() + model.slice(1)];

        if (!modelFields || modelFields.length === 0) {
          return query(args);
        }

        if (args && typeof args === 'object') {
          const typedArgs = args as Record<string, unknown>;
          if (typedArgs.data) {
            typedArgs.data = encryptModelData(typedArgs.data, modelFields, encryptionService);
          }
          if (typedArgs.create) {
            typedArgs.create = encryptModelData(typedArgs.create, modelFields, encryptionService);
          }
          if (typedArgs.update) {
            typedArgs.update = encryptModelData(typedArgs.update, modelFields, encryptionService);
          }
        }

        const result = await query(args);
        return decryptModelResult(result, modelFields, encryptionService);
      },
    },
  };
}
