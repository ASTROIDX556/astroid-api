import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { StellarHealthIndicator, StellarHealthReport } from './indicators/stellar.health';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly stellarHealthIndicator: StellarHealthIndicator) {}

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
}
