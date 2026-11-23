import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiExcludeController } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { QueueObservabilityService } from './queue-observability.service';
import { QueueObservabilityResponseDto } from './queue-observability.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';

@ApiExcludeController()
@ApiTags('operations')
@ApiBearerAuth('access-token')
@Controller('operations/queues')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class QueueObservabilityController {
  constructor(private readonly observability: QueueObservabilityService) {}

  @Get()
  @ApiOperation({
    summary: 'Get queue observability snapshot',
    description:
      'Returns per-queue job counts (waiting, active, delayed, completed, failed), ' +
      'the age of the oldest waiting job, and the most recent failed jobs with payloads stripped. ' +
      'Requires OWNER or ADMIN role. Endpoint is gated by QUEUE_OBSERVABILITY_ENABLED config (default: false).',
  })
  @ApiResponse({
    status: 200,
    description: 'Queue observability data',
    type: QueueObservabilityResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Insufficient permissions (requires OWNER or ADMIN role)',
  })
  @ApiResponse({
    status: 503,
    description: 'Queue observability is disabled or Redis is unavailable',
  })
  async getObservability(): Promise<QueueObservabilityResponseDto> {
    if (!this.observability['config'].enabled) {
      throw new DomainException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Queue observability endpoint is disabled. Set QUEUE_OBSERVABILITY_ENABLED=true to enable.',
      );
    }

    try {
      return await this.observability.getObservability();
    } catch (error) {
      throw new DomainException(
        ErrorCode.SERVICE_UNAVAILABLE,
        `Failed to query queue observability: ${(error as Error).message}`,
      );
    }
  }
}