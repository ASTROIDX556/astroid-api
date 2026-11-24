ALTER TABLE "transactions"
  ADD COLUMN "simulatedAt" TIMESTAMP(3),
  ADD COLUMN "minResourceFee" DECIMAL(30,0),
  ADD COLUMN "footprintSummary" JSONB,
  ADD COLUMN "simulationErrorCode" TEXT,
  ADD COLUMN "simulationErrorMessage" TEXT;
