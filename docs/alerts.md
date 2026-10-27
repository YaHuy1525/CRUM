# CRUM Alert Definitions

Every alert reads a metric or a store query with an explicit time range. Source: TECHNICAL_PLAN.md §8.6.

| Condition | Source | Threshold | Window | Action |
|-----------|--------|-----------|--------|--------|
| Tool call error rate | `mastra_tool_duration_ms` by `status` | > 5% `error` | 5 min | Ops channel |
| Agent latency p95 | `mastra_agent_duration_ms{status="ok"}` | > 5 s | 10 min | Ops channel |
| Model latency p95 | `mastra_model_duration_ms` | > 8 s | 10 min | Ops channel |
| Prompt cache hit share | `mastra_model_input_cache_read_tokens` ÷ `mastra_model_total_input_tokens` | < 40% on the assistant agent | 1 h | Ops channel; investigate prefix mutation (§4.10) |
| Spend ceiling headroom | token metrics × `costContext.estimatedCost` | < 10% | 1 day | Tenant admin plus ops |
| Negative feedback rate | `addFeedback` rows with `value: 'down'` | > 2% of turns | 1 day | Ops channel; queue for §8.5 review |
| Pending approval age | CRM query, not a metric | > 1 h | 1 h | Approver nudge |
| Tenant isolation scorer | `runEvals` verdict (§7.5) | any gate below floor | per PR | Block merge |
| Eval gate regression | `runEvals` verdict (§7.5) | any gate below floor | per PR | Block merge |

## Missing Metrics

If metrics are missing entirely (not merely flat):

1. Is `MastraStorageExporter` present in the Mastra constructor?
2. Is the store metrics-capable per §8.4? (`PostgresStoreVNext` with `observability` config.)
3. Is sampling non-zero? (`SamplingStrategyType.probability` with a rate > 0.)

The third is the one that produces a completely empty dashboard with a configuration that looks correct.
