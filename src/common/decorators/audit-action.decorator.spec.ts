import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import {
  AUDIT_ACTION_KEY,
  AuditAction,
  AuditActionOptions,
  normalizeAuditAction,
} from './audit-action.decorator';

describe('AuditAction decorator', () => {
  it('attaches the action name as route metadata under AUDIT_ACTION_KEY', () => {
    class TestController {
      @AuditAction('TRANSFER_FUNDS')
      transfer() {}
    }

    const reflector = new Reflector();
    const action = reflector.get<AuditActionOptions>(
      AUDIT_ACTION_KEY,
      TestController.prototype.transfer,
    );

    expect(action).toEqual({ action: 'TRANSFER_FUNDS' });
  });

  it('attaches the entity and description when given as options', () => {
    class TestController {
      @AuditAction({ action: 'AGENT_KEY_ROTATED', entity: 'ApiKey', description: 'Rotates a key' })
      rotate() {}
    }

    const reflector = new Reflector();
    const action = reflector.get<AuditActionOptions>(
      AUDIT_ACTION_KEY,
      TestController.prototype.rotate,
    );

    expect(action).toEqual({
      action: 'AGENT_KEY_ROTATED',
      entity: 'ApiKey',
      description: 'Rotates a key',
    });
  });

  it('leaves undecorated handlers without audit action metadata', () => {
    class TestController {
      untouched() {}
    }

    const reflector = new Reflector();
    const action = reflector.get<AuditActionOptions | undefined>(
      AUDIT_ACTION_KEY,
      TestController.prototype.untouched,
    );

    expect(action).toBeUndefined();
  });
});

describe('normalizeAuditAction', () => {
  it('normalizes the plain string form', () => {
    expect(normalizeAuditAction('TRANSFER_FUNDS')).toEqual({ action: 'TRANSFER_FUNDS' });
  });

  it('trims the action name', () => {
    expect(normalizeAuditAction('  TRANSFER_FUNDS  ')).toEqual({ action: 'TRANSFER_FUNDS' });
  });

  it('keeps the entity and description of the object form', () => {
    expect(
      normalizeAuditAction({ action: 'POLICY_CREATED', entity: 'Policy', description: 'Created' }),
    ).toEqual({ action: 'POLICY_CREATED', entity: 'Policy', description: 'Created' });
  });

  it('drops empty optional fields', () => {
    expect(normalizeAuditAction({ action: 'POLICY_CREATED', entity: '  ' })).toEqual({
      action: 'POLICY_CREATED',
    });
  });

  it('returns undefined for values that carry no action', () => {
    expect(normalizeAuditAction(undefined)).toBeUndefined();
    expect(normalizeAuditAction(null)).toBeUndefined();
    expect(normalizeAuditAction('')).toBeUndefined();
    expect(normalizeAuditAction('   ')).toBeUndefined();
    expect(normalizeAuditAction({})).toBeUndefined();
    expect(normalizeAuditAction({ action: 42 })).toBeUndefined();
  });
});
