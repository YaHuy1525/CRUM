# CRUM Runbook

## On-Call Alerts

See [`alerts.md`](./alerts.md) for the full alert table with thresholds and windows.

## Common Incidents

### `/health` returns `degraded`

1. Check which dependency is `error` in the response body.
2. If `storage`: verify `DATABASE_URL` is reachable. Check Supabase dashboard for pool exhaustion (`EMAXCONNSESSION`). If pool cap hit, lower `MASTRA_PG_POOL_MAX` or switch to transaction-mode pooler.
3. If `observability`: this is a soft dependency. Check that the observability store is reachable, but traffic continues on reduced capability.

### Tool call error rate > 5%

1. Check `mastra_tool_duration_ms` by `status` in the metrics dashboard.
2. Identify which tool is erroring. Common causes:
   - `crm.*` tools: schema mismatch after migration — run `npm run db:migrate`.
   - `knowledge.retrieve`: vector store unreachable — check `VECTOR_STORE_URL`.
3. If model-related, check `OPENROUTER_API_KEY` validity.

### Agent latency p95 > 5s

1. Check `mastra_agent_duration_ms{status="ok"}`.
2. If model latency is also high (`mastra_model_duration_ms` p95 > 8s), the upstream provider is slow. Check OpenRouter status.
3. If model latency is fine but agent latency is high, check tool call count — a runaway loop may be calling tools excessively. Verify `maxSteps: 6` is set on the agent.

### Prompt cache hit share < 40%

1. Check `mastra_model_input_cache_read_tokens` ÷ `mastra_model_total_input_tokens`.
2. Low hit rate means the prompt prefix is mutating between turns. Check processors — a processor that appends unique content (timestamps, random ids) to the system prompt breaks caching. See §4.10.

### Spend ceiling headroom < 10%

1. Check token metrics × `costContext.estimatedCost` on the usage dashboard.
2. If approaching the ceiling, notify the tenant admin. Consider raising the ceiling or throttling usage.

### Pending approval age > 1h

1. Query the `pending_writes` table for rows older than 1 hour.
2. Nudge the approver via the ops channel. If the approver is unavailable, check whether the approval can be re-assigned.

### Eval gate regression

1. This is a CI gate, not a runtime alert. If it fires on a PR:
2. Run `npm run eval:run` locally to see which scorer regressed.
3. Compare the prompt change against the golden dataset. If the regression is expected (e.g., trading one behaviour for another), re-baseline the dataset.

## Restart Recovery

1. If the process crashes mid-approval, the `pending_writes` table survives. On restart, the approval queue's Resolved tab shows rows that are no longer resumable.
2. If the process crashes mid-goal, the objective is persisted in thread state. On restart, the goal loop resumes from where it left off (or pauses if the budget was exhausted).

## Database Connection Issues

- **`EMAXCONNSESSION`**: pool cap hit. Lower `MASTRA_PG_POOL_MAX` (default 4) or switch to transaction-mode pooler.
- **TLS errors**: set `MASTRA_PG_SSL=disable` for local dev, `MASTRA_PG_SSL=require` for production.
