import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { SCOPES_KEY } from '../../common/decorators/scopes.decorator';
import { WebhookDlqController } from './webhook-dlq.controller';
import { WebhookDlqService } from './services/webhook-dlq.service';

describe('WebhookDlqController', () => {
  const listFailedDeliveries = vi.fn();
  const getFailedDelivery = vi.fn();
  const replayDeadLetter = vi.fn();
  const controller = new WebhookDlqController({
    listFailedDeliveries,
    getFailedDelivery,
    replayDeadLetter,
  } as unknown as WebhookDlqService);

  beforeEach(() => {
    listFailedDeliveries.mockReset().mockResolvedValue({ items: [], meta: {} });
    getFailedDelivery.mockReset().mockResolvedValue({ id: 'delivery-1' });
    replayDeadLetter.mockReset().mockResolvedValue({ record: { id: 'delivery-1' }, jobId: 'job-1' });
  });

  it('is mounted under the admin path and restricted to owners and admins', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WebhookDlqController)).toBe(
      'admin/webhooks/dead-letters',
    );
    expect(Reflect.getMetadata(ROLES_KEY, WebhookDlqController)).toEqual([
      UserRole.OWNER,
      UserRole.ADMIN,
    ]);
  });

  it('lists dead-lettered deliveries for the caller organization', async () => {
    const query = { page: 2, limit: 5 } as never;

    await controller.list('org-1', query);

    expect(listFailedDeliveries).toHaveBeenCalledWith('org-1', 2, 5);
  });

  it('inspects one dead-lettered delivery', async () => {
    await controller.inspect('org-1', 'delivery-1');

    expect(getFailedDelivery).toHaveBeenCalledWith('org-1', 'delivery-1');
  });

  it('replays a dead-lettered delivery and requires the manage scope', async () => {
    await controller.replay('org-1', 'delivery-1');

    expect(replayDeadLetter).toHaveBeenCalledWith('org-1', 'delivery-1');
    expect(
      Reflect.getMetadata(SCOPES_KEY, WebhookDlqController.prototype.replay),
    ).toEqual(['webhooks:manage']);
  });
});
