import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ConfigService } from '@nestjs/config';
import { StellarConfig } from '../../config/stellar.config';
import { SorobanValidationPipe } from '../../common/pipes/soroban-validation.pipe';
import {
  sorobanInvocationSchema,
  sorobanTransactionSchema,
  SorobanInvocationDto,
  SorobanTransactionDto,
  SorobanResponseDto,
} from './dto/soroban.dto';

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
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  getNetwork(): { network: string; horizonUrl: string; mock: boolean } {
    const stellar = this.config.getOrThrow<StellarConfig>('stellar');
    return {
      network: stellar.network,
      horizonUrl: stellar.horizonUrl,
      mock: stellar.useMock,
    };
  }

  @Post('soroban/invoke')
  @ApiOperation({
    summary: 'Invoke a Soroban smart contract function',
    description:
      'Validates and prepares a Soroban contract invocation. ' +
      'The contract ID, function name, and arguments are validated against strict schemas.',
  })
  @ApiBody({ type: SorobanInvocationDto })
  @ApiEnvelope(SorobanResponseDto, { description: 'Contract invocation prepared successfully' })
  @ApiErrorResponses({
    validation: 'Validation error - invalid contract ID, function name, or arguments',
    unauthorized: true,
    serverError: 'Stellar network error',
  })
  async invokeContract(
    @Body(new SorobanValidationPipe(sorobanInvocationSchema)) _body: SorobanInvocationDto,
  ): Promise<SorobanResponseDto> {
    // Placeholder - actual implementation would interact with Soroban client
    return {
      result: { status: 'success' },
      hash: 'mock-hash',
      feeCharged: 1000,
    };
  }

  @Post('soroban/submit')
  @ApiOperation({
    summary: 'Submit a Soroban transaction to the network',
    description:
      'Validates and submits a Soroban transaction envelope. ' +
      'The XDR envelope is validated for format and structure before submission.',
  })
  @ApiBody({ type: SorobanTransactionDto })
  @ApiEnvelope(SorobanResponseDto, { description: 'Transaction submitted successfully' })
  @ApiErrorResponses({
    validation: 'Validation error - invalid XDR format',
    unauthorized: true,
    serverError: 'Stellar network error',
  })
  async submitTransaction(
    @Body(new SorobanValidationPipe(sorobanTransactionSchema)) _body: SorobanTransactionDto,
  ): Promise<SorobanResponseDto> {
    // Placeholder - actual implementation would submit to Soroban network
    return {
      result: { status: 'success' },
      hash: 'mock-hash',
      feeCharged: 1000,
    };
  }
}
