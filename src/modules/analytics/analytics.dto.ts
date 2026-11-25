import { ApiProperty } from '@nestjs/swagger';

/** Aggregated metrics of the dashboard overview. */
export class AnalyticsOverviewDto {
  @ApiProperty({
    type: Object,
    description: 'Number of agents, wallets, pending proposals and transactions',
    example: { agents: 4, wallets: 6, pendingProposals: 2, transactions: 128 },
  })
  counts!: {
    agents: number;
    wallets: number;
    pendingProposals: number;
    transactions: number;
  };

  @ApiProperty({
    type: Object,
    description: 'Total spend of the organization, split by period',
    example: { allTime: '12500.0000000', last30d: '4200.0000000' },
  })
  spend!: { allTime: string; last30d: string };

  @ApiProperty({
    type: Object,
    description: 'Number of transactions per status',
    example: { COMPLETED: 120, FAILED: 3 },
  })
  byStatus!: Record<string, number>;

  @ApiProperty({
    type: Object,
    description: 'Number of transactions per risk band',
    example: { LOW: 100, MEDIUM: 20, HIGH: 6, CRITICAL: 2 },
  })
  byRisk!: Record<string, number>;
}

/** Spend of a single agent. */
export class AgentSpendDto {
  @ApiProperty({ description: 'Agent id', format: 'uuid', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  agentId!: string;

  @ApiProperty({ description: 'Total amount the agent moved', example: '4200.0000000' })
  totalSpent!: string;

  @ApiProperty({ description: 'Number of transactions the agent made', example: 12 })
  transactionCount!: number;
}
