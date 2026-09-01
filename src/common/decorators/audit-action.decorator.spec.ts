import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AUDIT_ACTION_KEY, AuditAction } from './audit-action.decorator';

describe('AuditAction decorator', () => {
  it('attaches the action name as route metadata under AUDIT_ACTION_KEY', () => {
    class TestController {
      @AuditAction('TRANSFER_FUNDS')
      transfer() {}
    }

    const reflector = new Reflector();
    const action = reflector.get<string>(AUDIT_ACTION_KEY, TestController.prototype.transfer);

    expect(action).toBe('TRANSFER_FUNDS');
  });

  it('leaves undecorated handlers without audit action metadata', () => {
    class TestController {
      untouched() {}
    }

    const reflector = new Reflector();
    const action = reflector.get<string | undefined>(
      AUDIT_ACTION_KEY,
      TestController.prototype.untouched,
    );

    expect(action).toBeUndefined();
  });
});
