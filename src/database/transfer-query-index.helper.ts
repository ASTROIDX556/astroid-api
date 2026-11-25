export interface TransferIndexDescriptor {
  name: string;
  table: string;
  columns: readonly string[];
}

export const HIGH_FREQUENCY_TRANSFER_INDICES: readonly TransferIndexDescriptor[] = [
  {
    name: 'transactions_organizationId_status_createdAt_idx',
    table: 'transactions',
    columns: ['organizationId', 'status', 'createdAt'],
  },
  {
    name: 'transactions_agentId_status_createdAt_idx',
    table: 'transactions',
    columns: ['agentId', 'status', 'createdAt'],
  },
];

export function matchesIndexedTransferQuery(filterColumns: string[]): boolean {
  return HIGH_FREQUENCY_TRANSFER_INDICES.some((idx) =>
    idx.columns.every((col, pos) => filterColumns[pos] === col),
  );
}
