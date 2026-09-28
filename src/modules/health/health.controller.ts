import { Controller, Get, HttpException, HttpStatus, UseGuards } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { StellarHealthIndicator, StellarHealthReport } from './indicators/stellar.health';
import {
  DatabaseMigrationHealthIndicator,
  MigrationHealthReport,
} from './indicators/database-migration.health';
import {
  BullMQHealthIndicator,
  QueuesHealthReport,
} from './indicators/bullmq.health';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly stellarHealthIndicator: StellarHealthIndicator,
    private readonly databaseMigrationIndicator: DatabaseMigrationHealthIndicator,
    private readonly bullmqHealthIndicator: BullMQHealthIndicator,
  ) {}

  @Get('stellar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER, UserRole.AUDITOR)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Comprehensive health check and latency diagnostics for Stellar Horizon and Soroban RPC endpoints',
    description:
      'Returns detailed health information including response times, connectivity status, ' +
      'and network version for Stellar Horizon and Soroban RPC endpoints.',
  })
  @ApiResponse({ status: 200, description: 'Stellar health report with latency metrics' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Stellar endpoint unreachable or degraded' })
  async checkStellarHealth(): Promise<StellarHealthReport> {
    return this.stellarHealthIndicator.checkHealth();
  }

  @Get('database')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER, UserRole.AUDITOR)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Database migration health check',
    description:
      'Verifies that all Prisma migrations are applied and the database schema is up to date. ' +
      'Returns 503 when pending migrations are detected, which is critical for Kubernetes ' +
      'liveness and readiness probes.',
  })
  @ApiResponse({ status: 200, description: 'All migrations applied, database schema is current' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Pending migrations detected or database unreachable' })
  async checkDatabaseMigrationHealth(): Promise<MigrationHealthReport> {
    const report = await this.databaseMigrationIndicator.checkHealth();

    if (report.status === 'down' || report.status === 'degraded') {
      // Throw to return 503 — Kubernetes probes will mark the pod as unhealthy.
      throw new HttpException(
        {
          statusCode: 503,
          message: report.status === 'down'
            ? 'Database unreachable during migration health check'
            : `${report.pendingMigrations} pending migration(s) detected — run 'prisma migrate deploy'`,
          report,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return report;
  }

  @Get('queues')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER, UserRole.AUDITOR)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'BullMQ queue health check',
    description:
      'Inspects every registered BullMQ queue (notifications, webhooks, ' +
      'stellar-sync, analytics, reports, outbox-events, stellar-fee-bump, ' +
      'transactions, risk-analysis, dead-letter, audit-cleanup, audit) and ' +
      'returns waiting/active/failed/delayed/completed/paused job counts plus ' +
      'Redis connectivity. Used by Kubernetes probes and dashboards to monitor ' +
      'asynchronous worker health.',
  })
  @ApiResponse({ status: 200, description: 'Per-queue job counts and Redis connectivity' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Redis unreachable or all queues failing' })
  async checkQueuesHealth(): Promise<QueuesHealthReport> {
    const report = await this.bullmqHealthIndicator.checkHealth();

    if (report.status === 'down') {
      throw new HttpException(
        {
          statusCode: 503,
          message: 'Redis unreachable or all BullMQ queues failing health probes',
          report,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return report;
  }
}
