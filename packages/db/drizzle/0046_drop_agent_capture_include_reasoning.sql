-- Reasoning is part of Agent output, not a signal of its own, so the capture
-- policy no longer carries includeReasoning. agentCapturePolicySchema is strict:
-- a stored document that still holds the key fails to parse, which would take
-- the whole observability policy offline on the first read after deploy.
UPDATE "observability_policies"
SET "document" = jsonb_set(
      "document",
      '{agentCapture}',
      ("document" -> 'agentCapture') - 'includeReasoning'
    ),
    "updated_at" = now()
WHERE "document" -> 'agentCapture' ? 'includeReasoning';
