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

/** Payload of the liveness probe. */
export class LivenessDto {
  @ApiProperty({
    description: 'Always `up` while the process can answer HTTP',
    enum: ['up'],
    example: 'up',
  })
  status!: 'up';

  @ApiProperty({ description: 'Moment the probe answered', example: '2026-01-15T10:30:00.000Z' })
  timestamp!: string;

  @ApiProperty({ description: 'Seconds since the process started', example: 42 })
  uptimeSeconds!: number;
}

/**
 * Outcome of one dependency check in the readiness probe. The probe is public, so
 * a failure is reported only as a coarse reason; the driver message, which can
 * name hosts, ports or connection strings, stays in the server log.
 */
export class DependencyProbeDto {
  @ApiProperty({ description: 'Health of the dependency', enum: ['up', 'down'], example: 'up' })
  status!: 'up' | 'down';

  @ApiProperty({ description: 'Round-trip time of the check, in milliseconds', example: 3 })
  latencyMs!: number;

  @ApiProperty({ description: 'Moment the check ran', example: '2026-01-15T10:30:00.000Z' })
  timestamp!: string;

  @ApiPropertyOptional({
    description: 'Why the dependency is down: the check hit its timeout, or it failed',
    enum: ['timeout', 'unavailable'],
    example: 'timeout',
  })
  error?: 'timeout' | 'unavailable';
}

/** One entry of the readiness `checks` list: the stable, machine-readable report. */
export class ReadinessCheckDto {
  @ApiProperty({ description: 'Name of the dependency', example: 'database' })
  name!: string;

  @ApiProperty({ description: 'Health of the dependency', enum: ['up', 'down'], example: 'up' })
  status!: 'up' | 'down';

  @ApiProperty({ description: 'Round-trip time of the check, in milliseconds', example: 3 })
  latencyMs!: number;

  @ApiPropertyOptional({
    description: 'Why the dependency is down. Never contains hosts, credentials or stack traces.',
    enum: ['timeout', 'unavailable'],
    example: 'timeout',
  })
  error?: 'timeout' | 'unavailable';
}

/** Per-dependency results of the readiness probe. */
export class ReadinessServicesDto {
  @ApiProperty({ description: 'PostgreSQL, probed with `SELECT 1`', type: DependencyProbeDto })
  database!: DependencyProbeDto;

  @ApiProperty({
    description: 'Redis, probed with `PING` on the shared client',
    type: DependencyProbeDto,
  })
  cache!: DependencyProbeDto;

  @ApiProperty({
    description:
      'BullMQ, probed with `PING` on the connection of a registered queue (no new connection)',
    type: DependencyProbeDto,
  })
  queue!: DependencyProbeDto;

  @ApiProperty({
    description: 'Soroban RPC, probed with a bounded `getHealth` call on the configured endpoint',
    type: DependencyProbeDto,
  })
  soroban!: DependencyProbeDto;
}

/** Payload of the readiness probe. */
export class ReadinessDto {
  @ApiProperty({
    description: '`up` when every required dependency is up',
    enum: ['up', 'down'],
    example: 'up',
  })
  status!: 'up' | 'down';

  @ApiProperty({ description: 'Moment the probe answered', example: '2026-01-15T10:30:00.000Z' })
  timestamp!: string;

  @ApiProperty({
    description:
      'Result of each dependency check, in a stable list: `{ name, status, latencyMs, error? }`',
    type: [ReadinessCheckDto],
  })
  checks!: ReadinessCheckDto[];

  @ApiProperty({ description: 'Result of each dependency check, keyed by name (kept for existing clients)', type: ReadinessServicesDto })
  services!: ReadinessServicesDto;
}
