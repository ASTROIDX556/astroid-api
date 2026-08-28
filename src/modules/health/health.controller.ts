import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({
    summary: 'Comprehensive health check and latency diagnostics for Stellar Horizon and Soroban RPC endpoints',
  })
  async checkStellarHealth(): Promise<StellarHealthReport> {
    return this.stellarHealthIndicator.checkHealth();
  }
}
