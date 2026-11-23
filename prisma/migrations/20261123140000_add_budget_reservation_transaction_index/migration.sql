-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block, so this index lives in its own file.
CREATE INDEX CONCURRENTLY "transactions_budgetReservationId_idx"
    ON "transactions"("budgetReservationId");
