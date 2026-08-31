import { Controller, Get } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { StellarConfig } from '../../config/stellar.config';

/**
 * Read-only informational endpoints for the Stellar integration. Payment and
 * balance operations are exposed through the wallets module.
 */
@ApiTags('stellar')
@ApiBearerAuth('access-token')
@Controller('stellar')
export class StellarController {
  constructor(private readonly config: ConfigService) {}

  @Get('network')
  @ApiOperation({
    summary: 'Returns the configured Stellar network + mode',
    description:
      'Returns the current Stellar network configuration including the Horizon URL ' +
      'and whether the integration is running in mock mode.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stellar network configuration',
    schema: {
      type: 'object',
      properties: {
        network: { type: 'string', example: 'TESTNET', description: 'Stellar network name' },
        horizonUrl: { type: 'string', example: 'https://horizon-testnet.stellar.org', description: 'Horizon server URL' },
        mock: { type: 'boolean', example: false, description: 'Whether running in mock mode' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getNetwork(): { network: string; horizonUrl: string; mock: boolean } {
    const stellar = this.config.getOrThrow<StellarConfig>('stellar');
    return {
      network: stellar.network,
      horizonUrl: stellar.horizonUrl,
      mock: stellar.useMock,
    };
  }
}
