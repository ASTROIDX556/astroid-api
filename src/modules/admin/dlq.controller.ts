import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DlqService } from './dlq.service';
import {
  ListDlqJobsQuery,
  listDlqJobsQuerySchema,
  PurgeDlqDto,
  purgeDlqSchema,
  DlqJobDetails,
  QueueJobCounts,
} from './dto/dlq.dto';
import { Queues } from '../../queues/queues.constants';

/**
 * Administrative Dead-Letter Queue (DLQ) controller.
 * Restricted strictly to system administrators (OWNER and ADMIN roles).
 */
@ApiTags('admin-dlq')
@Controller('admin/dlq')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class DlqController {
  constructor(private readonly dlqService: DlqService) {}

  @Get()
  @ApiOperation({ summary: 'List failed jobs across queues or for a specific queue' })
  @ApiResponse({ status: 200, description: 'List of failed / dead-lettered jobs' })
  async listFailedJobs(
    @Query(new ZodValidationPipe(listDlqJobsQuerySchema)) query: ListDlqJobsQuery,
  ) {
    return this.dlqService.listFailedJobs(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get queue job counts and DLQ health stats' })
  @ApiResponse({ status: 200, description: 'Summary counts across all BullMQ queues' })
  async getQueueStats(): Promise<QueueJobCounts[]> {
    return this.dlqService.getQueueStats();
  }

  @Post('retry-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed jobs across all queues or a specified queue' })
  @ApiResponse({ status: 200, description: 'Results of batch retry operation' })
  async retryAllJobs(@Query('queue') queue?: string) {
    return this.dlqService.retryAllFailedJobs(queue);
  }

  @Delete('purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Purge failed jobs across all queues or a specified queue' })
  @ApiResponse({ status: 200, description: 'Results of purge operation' })
  async purgeQueue(
    @Query(new ZodValidationPipe(purgeDlqSchema)) query: PurgeDlqDto,
  ) {
    return this.dlqService.purgeQueue(query);
  }

  @Post(':queue/retry-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed jobs in a specific queue' })
  async retryQueueAllJobs(@Param('queue') queue: string) {
    return this.dlqService.retryAllFailedJobs(queue);
  }

  @Delete(':queue/purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Purge failed jobs in a specific queue' })
  async purgeSpecificQueue(
    @Param('queue') queue: string,
    @Query(new ZodValidationPipe(purgeDlqSchema)) query: PurgeDlqDto,
  ) {
    return this.dlqService.purgeQueue({ ...query, queue });
  }

  @Get(':queue/:id')
  @ApiOperation({ summary: 'Inspect a specific failed job and error payload in a named queue' })
  @ApiResponse({ status: 200, description: 'Job inspection details' })
  async getJobDetails(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ): Promise<DlqJobDetails> {
    return this.dlqService.getJobDetails(queue, id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Inspect a specific failed job in the default Dead-Letter Queue' })
  @ApiResponse({ status: 200, description: 'Job inspection details' })
  async getDlqJobDetails(
    @Param('id') id: string,
    @Query('queue') queue?: string,
  ): Promise<DlqJobDetails> {
    return this.dlqService.getJobDetails(queue ?? Queues.DeadLetter, id);
  }

  @Post(':queue/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a specific failed job in a named queue' })
  @ApiResponse({ status: 200, description: 'Job retry confirmation' })
  async retryJob(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ) {
    return this.dlqService.retryJob(queue, id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a specific failed job in the default Dead-Letter Queue' })
  @ApiResponse({ status: 200, description: 'Job retry confirmation' })
  async retryDlqJob(
    @Param('id') id: string,
    @Query('queue') queue?: string,
  ) {
    return this.dlqService.retryJob(queue ?? Queues.DeadLetter, id);
  }

  @Delete(':queue/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete/remove a specific failed job from a named queue' })
  @ApiResponse({ status: 200, description: 'Job removal confirmation' })
  async removeJob(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ) {
    return this.dlqService.removeJob(queue, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete/remove a specific failed job from the default Dead-Letter Queue' })
  @ApiResponse({ status: 200, description: 'Job removal confirmation' })
  async removeDlqJob(
    @Param('id') id: string,
    @Query('queue') queue?: string,
  ) {
    return this.dlqService.removeJob(queue ?? Queues.DeadLetter, id);
  }
}
