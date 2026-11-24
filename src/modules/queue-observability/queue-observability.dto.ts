import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';

export class QueueFailedJobDto {
  @ApiProperty({ description: 'BullMQ job ID', example: '42' })
  @IsString()
  id = '';

  @ApiProperty({ description: 'Job name', example: 'webhook-delivery' })
  @IsString()
  name = '';

  @ApiProperty({ description: 'Failure reason', example: 'HTTP 500' })
  @IsString()
  failedReason = '';

  @ApiProperty({ description: 'Number of attempts made', example: 3 })
  @IsNumber()
  @Min(0)
  attemptsMade = 0;

  @ApiProperty({ description: 'Unix timestamp when the job was processed', example: 1699999999999 })
  @IsNumber()
  @Min(0)
  processedOn = 0;
}

export class QueueCountsDto {
  @ApiProperty({ description: 'Jobs waiting to be processed', example: 10 })
  @IsNumber()
  @Min(0)
  waiting = 0;

  @ApiProperty({ description: 'Jobs currently being processed', example: 2 })
  @IsNumber()
  @Min(0)
  active = 0;

  @ApiProperty({ description: 'Jobs delayed for future processing', example: 5 })
  @IsNumber()
  @Min(0)
  delayed = 0;

  @ApiProperty({ description: 'Jobs completed successfully', example: 100 })
  @IsNumber()
  @Min(0)
  completed = 0;

  @ApiProperty({ description: 'Jobs that have failed', example: 3 })
  @IsNumber()
  @Min(0)
  failed = 0;
}

export class QueueObservabilityDto {
  @ApiProperty({ description: 'Queue name', example: 'webhooks' })
  @IsString()
  queueName = '';

  @ApiProperty({ type: () => QueueCountsDto })
  counts = new QueueCountsDto();

  @ApiProperty({
    description: 'Age in milliseconds of the oldest waiting job, or null if no waiting jobs',
    example: 5000,
    nullable: true,
  })
  oldestWaitingJobAgeMs: number | null = null;

  @ApiProperty({
    description: 'Recent failed jobs (payload stripped)',
    type: () => [QueueFailedJobDto],
  })
  failedJobs: QueueFailedJobDto[] = [];
}

export class QueueObservabilityResponseDto {
  @ApiProperty({ type: () => [QueueObservabilityDto] })
  queues: QueueObservabilityDto[] = [];

  @ApiProperty({ description: 'Timestamp of the observability snapshot', example: '2024-01-15T10:30:00.000Z' })
  @IsString()
  timestamp = '';
}