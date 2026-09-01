import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';

describe('OrganizationController.rotateKeys', () => {
  let controller: OrganizationController;
  let service: OrganizationService;

  beforeEach(() => {
    service = { rotateKeys: vi.fn().mockResolvedValue({ id: 'key-new' }) } as unknown as OrganizationService;
    controller = new OrganizationController(service);
  });

  it('is restricted to organization owners via @Roles(OWNER)', () => {
    const reflector = new Reflector();
    const roles = reflector.get<UserRole[]>(
      ROLES_KEY,
      OrganizationController.prototype.rotateKeys,
    );
    expect(roles).toEqual([UserRole.OWNER]);
  });

  it('delegates to the service with the caller context and validated body', async () => {
    const user: AuthenticatedUser = {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'owner@acme.io',
      role: UserRole.OWNER,
    };
    const body = { reason: 'key may have leaked' };

    await controller.rotateKeys(user, body);

    expect(service.rotateKeys).toHaveBeenCalledWith('org-1', 'user-1', body);
  });
});
