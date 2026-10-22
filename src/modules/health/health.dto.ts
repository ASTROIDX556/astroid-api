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

/** The health of a single external endpoint (Horizon, Soroban RPC). */
export class StellarEndpointHealthDto {
  @ApiProperty({ description: 'Health of the endpoint', enum: ['up', 'degraded', 'down'], example: 'up' })
  status!: string;

  @ApiProperty({ description: 'Round-trip time of the probe, in milliseconds', example: 42 })
  latencyMs!: number;

  @ApiProperty({ description: 'URL that was probed', example: 'https://horizon-testnet.stellar.org' })
  url!: string;

  @ApiPropertyOptional({ description: 'Latest ledger the endpoint reported', example: 54321 })
  ledgerSequence?: number;

  @ApiPropertyOptional({ description: 'Protocol version reported by the endpoint', example: 21 })
  protocolVersion?: number;

  @ApiPropertyOptional({ description: 'Reason the endpoint was reported as unhealthy', example: 'HTTP 503 Service Unavailable' })
  error?: string;
}

/** The health of the Stellar network dependencies. */
export class StellarHealthDto {
  @ApiProperty({ description: 'Overall health of the Stellar dependencies', enum: ['up', 'degraded', 'down'], example: 'up' })
  status!: string;

  @ApiProperty({ description: 'Moment the check ran', example: '2026-01-15T10:30:00.000Z' })
  timestamp!: string;

  @ApiProperty({ description: 'Stellar network the endpoints belong to', example: 'testnet' })
  network!: string;

  @ApiProperty({ description: 'Health of the Horizon server', type: StellarEndpointHealthDto })
  horizon!: StellarEndpointHealthDto;

  @ApiProperty({ description: 'Health of the Soroban RPC node', type: StellarEndpointHealthDto })
  sorobanRpc!: StellarEndpointHealthDto;
}
