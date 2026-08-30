import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { DeadLetterService } from './dead-letter.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Administrative dead-letter queue endpoints. Read-only inspection of captured
 * job failures plus a guarded re-drive action for remediated failures.
 * Restricted to owners/admins like the audit trail.
 */
@ApiTags('dead-letter')
@Controller('admin/dead-letter')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class DeadLetterController {
  constructor(private readonly deadLetterService: DeadLetterService) {}

  @Get()
  @ApiOperation({ summary: 'List captured DLQ failures for the organization' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query('queue') queue?: string,
    @Query('take') take?: string,
  ) {
    const limit = take ? Number(take) : undefined;
    return this.deadLetterService.listForOrganization(
      organizationId,
      queue,
      Number.isFinite(limit) ? limit : undefined,
    );
  }

  @Post(':queue/:jobId/retry')
  @ApiOperation({ summary: 'Re-drive a failed job back onto its queue' })
  retry(@Param('queue') queue: string, @Param('jobId') jobId: string) {
    return this.deadLetterService.requeue(queue, jobId);
  }

  @Delete(':queue/:jobId')
  @ApiOperation({ summary: 'Purge a failed job from the queue after review' })
  purge(@Param('queue') queue: string, @Param('jobId') jobId: string) {
    return this.deadLetterService.purge(queue, jobId);
  }
}