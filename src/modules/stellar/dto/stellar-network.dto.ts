import { ApiProperty } from '@nestjs/swagger';

export class StellarNetworkDto {
  @ApiProperty({ example: 'TESTNET', description: 'Stellar network name' })
  network!: string;

  @ApiProperty({
    example: 'https://horizon-testnet.stellar.org',
    description: 'Horizon server URL',
  })
  horizonUrl!: string;

  @ApiProperty({ example: false, description: 'Whether running in mock mode' })
  mock!: boolean;
}
