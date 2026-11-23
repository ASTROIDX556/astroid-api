import { ApiProperty } from '@nestjs/swagger';

export class AuditArchiveBatchDto {
  @ApiProperty({ example: '8f1c9a0b-1234-5678-abcd-ef0123456789', description: 'Unique identifier of the archive batch' })
  id!: string;

  @ApiProperty({ example: 100, description: 'Number of audit records in this batch' })
  recordCount!: number;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z', description: 'Timestamp of the earliest record in batch' })
  fromTimestamp!: string;

  @ApiProperty({ example: '2026-01-02T00:00:00.000Z', description: 'Timestamp of the latest record in batch' })
  toTimestamp!: string;

  @ApiProperty({ example: 'sha256:abc123...', description: 'SHA-256 checksum of the compressed batch archive' })
  checksum!: string;

  @ApiProperty({ example: '2026-01-02T01:00:00.000Z', description: 'When the batch was created by archival job' })
  createdAt!: string;
}

export class AuditArchiveBatchListDto {
  @ApiProperty({ type: [AuditArchiveBatchDto], description: 'Archive batches, newest first' })
  batches!: AuditArchiveBatchDto[];

  @ApiProperty({ example: 1, description: 'Total number of archive batches returned' })
  count!: number;
}

export class AuditArchiveRecordListDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: 'Decompressed audit log records from the batch',
  })
  records!: Record<string, unknown>[];

  @ApiProperty({ example: 100, description: 'Total number of audit records in batch' })
  count!: number;
}
