import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The health of the API or of one of its dependencies. */
export class HealthStatusDto {
  @ApiProperty({ description: 'Health of the component', enum: ['up', 'down'], example: 'up' })
  status!: string;

  @ApiProperty({ description: 'Moment the check ran', example: '2026-01-15T10:30:00.000Z' })
  timestamp!: string;

  @ApiPropertyOptional({ description: 'Extra details reported by the check', example: { connections: 4 } })
  details?: Record<string, unknown>;
}
