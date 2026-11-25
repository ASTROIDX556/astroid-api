-- One reviewer may cast one decision per proposal. This makes the service's
-- multi-signature approval count safe under concurrent retries.
CREATE UNIQUE INDEX "approvals_proposalId_userId_key" ON "approvals"("proposalId", "userId");
