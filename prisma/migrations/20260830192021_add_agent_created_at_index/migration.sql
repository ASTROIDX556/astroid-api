-- CreateIndex
-- Rolling-window budget aggregation (issue #110) queries transactions by
-- `agentId` scoped to a `createdAt` range (e.g. "last 24h for agent X").
-- The existing `[agentId]`, `[agentId, status]` and `[createdAt]` indexes
-- cannot serve that range scan efficiently; this composite index lets
-- Postgres seek directly to the agent's rows ordered by time.
CREATE INDEX "transactions_agentId_createdAt_idx" ON "transactions"("agentId", "createdAt");
