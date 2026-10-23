-- GENERATED FILE. DO NOT EDIT BY HAND.
-- Regenerate with: npm run db:export-schema
-- Source: exportSchemas() from the installed @mastra/pg. See package.json for the pin.
--
-- This is a committed snapshot of the DDL Mastra's own storage.init() applies:
-- memory threads and messages, workflow runs and suspensions, scores, agents,
-- MCP clients and servers, workspaces, and the observability tables.
--
-- It is documentation and a drift alarm, not a migration. scripts/db-migrate.ts
-- never replays it: the adapter creates and upgrades these tables itself, and
-- hand-applying generated DDL would break on the next Mastra minor version.
-- CI regenerates the file and fails if the result differs from what is
-- committed, so a Mastra upgrade that changes the schema cannot land unread.
-- See TECHNICAL_PLAN.md §14.2.


            CREATE TABLE IF NOT EXISTS "public"."mastra_threads" (
              "id" TEXT PRIMARY KEY NOT NULL,
"resourceId" TEXT NOT NULL,
"title" TEXT NOT NULL,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_messages" (
              "id" TEXT PRIMARY KEY NOT NULL,
"thread_id" TEXT NOT NULL,
"content" TEXT NOT NULL,
"role" TEXT NOT NULL,
"type" TEXT NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"resourceId" TEXT ,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_resources" (
              "id" TEXT PRIMARY KEY NOT NULL,
"workingMemory" TEXT ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_observational_memory" (
              "id" TEXT PRIMARY KEY NOT NULL,
"lookupKey" TEXT NOT NULL,
"scope" TEXT NOT NULL,
"resourceId" TEXT ,
"threadId" TEXT ,
"activeObservations" TEXT NOT NULL,
"activeObservationsPendingUpdate" TEXT ,
"originType" TEXT NOT NULL,
"config" TEXT NOT NULL,
"generationCount" INTEGER NOT NULL,
"supersededBy" TEXT ,
"lastObservedAt" TIMESTAMP ,
"lastReflectionAt" TIMESTAMP ,
"pendingMessageTokens" INTEGER NOT NULL,
"totalTokensObserved" INTEGER NOT NULL,
"observationTokenCount" INTEGER NOT NULL,
"isObserving" BOOLEAN NOT NULL,
"isReflecting" BOOLEAN NOT NULL,
"observedMessageIds" JSONB ,
"observedTimezone" TEXT ,
"bufferedObservations" TEXT ,
"bufferedObservationTokens" INTEGER ,
"bufferedMessageIds" JSONB ,
"bufferedReflection" TEXT ,
"bufferedReflectionTokens" INTEGER ,
"bufferedReflectionInputTokens" INTEGER ,
"reflectedObservationLineCount" INTEGER ,
"bufferedObservationChunks" JSONB ,
"isBufferingObservation" BOOLEAN NOT NULL,
"isBufferingReflection" BOOLEAN NOT NULL,
"lastBufferedAtTokens" INTEGER NOT NULL,
"lastBufferedAtTime" TIMESTAMP ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"lastObservedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"lastReflectionAtZ" TIMESTAMPTZ DEFAULT NOW(),
"lastBufferedAtTimeZ" TIMESTAMPTZ DEFAULT NOW(),
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE INDEX IF NOT EXISTS "idx_om_lookup_key" ON "public"."mastra_observational_memory" ("lookupKey");
CREATE INDEX IF NOT EXISTS "mastra_threads_resourceid_createdat_idx" ON "public"."mastra_threads" ("resourceId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "mastra_messages_thread_id_createdat_idx" ON "public"."mastra_messages" ("thread_id", "createdAt" DESC);

            CREATE TABLE IF NOT EXISTS "public"."mastra_memory_run_fences" (
              "runId" TEXT PRIMARY KEY NOT NULL,
"generation" BIGINT NOT NULL,
"ownerId" TEXT NOT NULL,
"retiredAt" BIGINT 
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_nodes" (
              "id" TEXT PRIMARY KEY NOT NULL,
"name" TEXT NOT NULL,
"kind" TEXT ,
"isScope" BOOLEAN NOT NULL,
"metadata" JSONB ,
"version" INTEGER NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"deletedAt" TIMESTAMP ,
"deletedBy" TEXT ,
"type" TEXT ,
"canonicalName" TEXT ,
"content" TEXT ,
"description" TEXT ,
"scope" JSONB ,
"scopeKey" TEXT ,
"mergedInto" TEXT ,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"deletedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_records" (
              "id" TEXT PRIMARY KEY NOT NULL,
"node" TEXT NOT NULL,
"text" TEXT NOT NULL,
"metadata" JSONB ,
"version" INTEGER NOT NULL,
"capturedAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"deletedAt" TIMESTAMP ,
"deletedBy" TEXT ,
"scope" JSONB ,
"scopeKey" TEXT ,
"sourceThreadId" TEXT ,
"when" TIMESTAMP ,
"capturedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"deletedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"whenZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_mentions" (
              "recordId" TEXT NOT NULL,
"targetNodeId" TEXT ,
"sourceType" TEXT ,
"sourceId" TEXT ,
PRIMARY KEY ("recordId", "sourceId")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_node_scopes" (
              "nodeId" TEXT NOT NULL,
"scopeNodeId" TEXT NOT NULL,
"addedAt" TIMESTAMP NOT NULL,
"addedAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("nodeId", "scopeNodeId")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_record_scopes" (
              "recordId" TEXT NOT NULL,
"scopeNodeId" TEXT NOT NULL,
"addedAt" TIMESTAMP NOT NULL,
"addedAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("recordId", "scopeNodeId")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_scope_grants" (
              "scopeNodeId" TEXT NOT NULL,
"scopeRefId" TEXT NOT NULL,
"role" TEXT NOT NULL,
"canSuggest" BOOLEAN ,
PRIMARY KEY ("scopeNodeId", "scopeRefId")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_access_state" (
              "id" TEXT PRIMARY KEY NOT NULL,
"epoch" INTEGER NOT NULL,
"schemaVersion" INTEGER NOT NULL
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_scope_addresses" (
              "address" TEXT PRIMARY KEY NOT NULL,
"scopeNodeId" TEXT NOT NULL
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_node_addresses" (
              "source" TEXT NOT NULL,
"address" TEXT NOT NULL,
"nodeId" TEXT NOT NULL,
PRIMARY KEY ("source", "address")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_import_state" (
              "importerId" TEXT NOT NULL,
"binding" TEXT NOT NULL,
"key" TEXT NOT NULL,
"value" TEXT NOT NULL,
PRIMARY KEY ("importerId", "binding", "key")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_import_runs" (
              "id" TEXT PRIMARY KEY NOT NULL,
"importerId" TEXT NOT NULL,
"binding" TEXT NOT NULL,
"importKind" TEXT NOT NULL,
"triggerKind" TEXT NOT NULL,
"status" TEXT NOT NULL,
"error" TEXT ,
"transcriptThreadId" TEXT ,
"traceId" TEXT ,
"queuedAt" TIMESTAMP NOT NULL,
"startedAt" TIMESTAMP ,
"completedAt" TIMESTAMP ,
"queuedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"startedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"completedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_proposals" (
              "id" TEXT PRIMARY KEY NOT NULL,
"targetType" TEXT NOT NULL,
"targetId" TEXT NOT NULL,
"action" TEXT NOT NULL,
"changes" JSONB NOT NULL,
"reason" TEXT ,
"proposerContextScopeId" TEXT NOT NULL,
"expectedVersion" INTEGER NOT NULL,
"status" TEXT NOT NULL,
"reviewerContextScopeId" TEXT ,
"reviewedAt" TIMESTAMP ,
"createdAt" TIMESTAMP NOT NULL,
"reviewedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_activity" (
              "id" TEXT PRIMARY KEY NOT NULL,
"action" TEXT NOT NULL,
"targetType" TEXT ,
"targetId" TEXT ,
"contextScopeId" TEXT ,
"importRunId" TEXT ,
"details" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"recordType" TEXT ,
"recordId" TEXT ,
"scope" JSONB ,
"scopeKey" TEXT ,
"sourceThreadId" TEXT ,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_knowledge_semantic_outbox" (
              "id" TEXT PRIMARY KEY NOT NULL,
"idempotencyKey" TEXT NOT NULL,
"documentId" TEXT NOT NULL,
"documentType" TEXT NOT NULL,
"operation" TEXT NOT NULL,
"scope" JSONB NOT NULL,
"scopeKey" TEXT NOT NULL,
"status" TEXT NOT NULL,
"attempts" INTEGER NOT NULL,
"availableAt" TIMESTAMP NOT NULL,
"claimedAt" TIMESTAMP ,
"claimedBy" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"completedAt" TIMESTAMP ,
"availableAtZ" TIMESTAMPTZ DEFAULT NOW(),
"claimedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"completedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_nodes_identity ON "mastra_knowledge_nodes" ("type", "scopeKey", "canonicalName");
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_scope ON "mastra_knowledge_nodes" ("scopeKey", "type");
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_name ON "mastra_knowledge_nodes" ("type", "canonicalName");
CREATE INDEX IF NOT EXISTS idx_knowledge_records_node_latest ON "mastra_knowledge_records" ("node", "id" DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_records_thread_latest ON "mastra_knowledge_records" ("sourceThreadId", "id" DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_mentions_record ON "mastra_knowledge_mentions" ("recordId", "sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS idx_knowledge_activity_latest ON "mastra_knowledge_activity" ("id" DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_records_scope ON "mastra_knowledge_records" ("scopeKey", "id");
CREATE INDEX IF NOT EXISTS idx_knowledge_activity_scope ON "mastra_knowledge_activity" ("scopeKey", "id" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_outbox_idempotency ON "mastra_knowledge_semantic_outbox" ("idempotencyKey");
CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_claim ON "mastra_knowledge_semantic_outbox" ("status", "availableAt", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_node_scopes_scope ON "mastra_knowledge_node_scopes" ("scopeNodeId", "nodeId");
CREATE INDEX IF NOT EXISTS idx_knowledge_record_scopes_scope ON "mastra_knowledge_record_scopes" ("scopeNodeId", "recordId");
CREATE INDEX IF NOT EXISTS idx_knowledge_scope_grants_ref ON "mastra_knowledge_scope_grants" ("scopeRefId", "scopeNodeId");
CREATE INDEX IF NOT EXISTS idx_knowledge_node_addresses_node ON "mastra_knowledge_node_addresses" ("nodeId");
CREATE INDEX IF NOT EXISTS idx_knowledge_import_runs_lookup ON "mastra_knowledge_import_runs" ("importerId", "binding", "queuedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_activity_import_run ON "mastra_knowledge_activity" ("importRunId", "id" DESC);

            CREATE TABLE IF NOT EXISTS "public"."mastra_notifications" (
              "id" TEXT NOT NULL,
"threadId" TEXT NOT NULL,
"source" TEXT NOT NULL,
"kind" TEXT NOT NULL,
"priority" TEXT NOT NULL,
"status" TEXT NOT NULL,
"summary" TEXT NOT NULL,
"payload" JSONB ,
"resourceId" TEXT ,
"agentId" TEXT ,
"sourceId" TEXT ,
"dedupeKey" TEXT ,
"coalesceKey" TEXT ,
"coalescedCount" INTEGER NOT NULL,
"attributes" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"deliveredAt" TIMESTAMP ,
"seenAt" TIMESTAMP ,
"dismissedAt" TIMESTAMP ,
"archivedAt" TIMESTAMP ,
"discardedAt" TIMESTAMP ,
"deliverAt" TIMESTAMP ,
"summaryAt" TIMESTAMP ,
"deliveryReason" TEXT ,
"deliveryAttempts" INTEGER NOT NULL,
"lastDeliveryAttemptAt" TIMESTAMP ,
"lastDeliveryError" TEXT ,
"deliveredSignalId" TEXT ,
"summarySignalId" TEXT ,
"metadata" JSONB ,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"deliveredAtZ" TIMESTAMPTZ DEFAULT NOW(),
"seenAtZ" TIMESTAMPTZ DEFAULT NOW(),
"dismissedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"archivedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"discardedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"deliverAtZ" TIMESTAMPTZ DEFAULT NOW(),
"summaryAtZ" TIMESTAMPTZ DEFAULT NOW(),
"lastDeliveryAttemptAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("threadId", "id")
            );
            
          
          
CREATE INDEX IF NOT EXISTS "idx_notifications_thread_status_updated" ON "public"."mastra_notifications" ("threadId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "idx_notifications_coalescing" ON "public"."mastra_notifications" ("threadId", "source", "kind", "status", "agentId", "resourceId", "dedupeKey", "coalesceKey");
CREATE INDEX IF NOT EXISTS "idx_notifications_due" ON "public"."mastra_notifications" ("status", "deliverAt", "summaryAt");

            CREATE TABLE IF NOT EXISTS "public"."mastra_ai_spans" (
              "traceId" TEXT NOT NULL,
"spanId" TEXT NOT NULL,
"name" TEXT NOT NULL,
"spanType" TEXT NOT NULL,
"isEvent" BOOLEAN NOT NULL,
"startedAt" TIMESTAMP NOT NULL,
"parentSpanId" TEXT ,
"entityType" TEXT ,
"entityId" TEXT ,
"entityName" TEXT ,
"parentEntityType" TEXT ,
"parentEntityId" TEXT ,
"parentEntityName" TEXT ,
"rootEntityType" TEXT ,
"rootEntityId" TEXT ,
"rootEntityName" TEXT ,
"userId" TEXT ,
"organizationId" TEXT ,
"resourceId" TEXT ,
"runId" TEXT ,
"sessionId" TEXT ,
"threadId" TEXT ,
"requestId" TEXT ,
"environment" TEXT ,
"serviceName" TEXT ,
"scope" JSONB ,
"entityVersionId" TEXT ,
"parentEntityVersionId" TEXT ,
"rootEntityVersionId" TEXT ,
"experimentId" TEXT ,
"source" TEXT ,
"metadata" JSONB ,
"tags" JSONB ,
"attributes" JSONB ,
"links" JSONB ,
"input" JSONB ,
"output" JSONB ,
"error" JSONB ,
"endedAt" TIMESTAMP ,
"requestContext" JSONB ,
"inputPreview" TEXT ,
"outputPreview" TEXT ,
"errorPreview" TEXT ,
"timeToFirstChunkMs" FLOAT ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP ,
"startedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"endedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = lower('mastra_ai_spans_traceid_spanid_pk') AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
              ) THEN
                ALTER TABLE "public"."mastra_ai_spans"
                ADD CONSTRAINT mastra_ai_spans_traceid_spanid_pk
                PRIMARY KEY ("traceId", "spanId");
              END IF;
            END $$;
            
          
CREATE OR REPLACE FUNCTION "public".trigger_set_timestamps()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."createdAt" = NOW();
        NEW."updatedAt" = NOW();
        NEW."createdAtZ" = NOW();
        NEW."updatedAtZ" = NOW();
    ELSIF TG_OP = 'UPDATE' THEN
        NEW."updatedAt" = NOW();
        NEW."updatedAtZ" = NOW();
        NEW."createdAt" = OLD."createdAt";
        NEW."createdAtZ" = OLD."createdAtZ";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $mastra_timestamps_trigger$
BEGIN
    -- Recreating the trigger unconditionally would take an ACCESS EXCLUSIVE
    -- lock on the table (DROP TRIGGER does, even when nothing changes), and
    -- init runs on every process start. Skip when the trigger is already
    -- exactly what the CREATE below would produce.
    --
    -- tgtype 23 = ROW (1) | BEFORE (2) | INSERT (4) | UPDATE (16), so a trigger
    -- whose timing or events differ still falls through and gets rebuilt. The
    -- behaviour itself lives in the function, which is replaced above on every
    -- init, so an upgraded function body lands without touching the trigger.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE tg.tgname = 'mastra_ai_spans_timestamps'
          AND c.relname = 'mastra_ai_spans'
          AND n.nspname = 'public'
          AND NOT tg.tgisinternal
          AND tg.tgtype = 23
          AND tg.tgfoid = '"public".trigger_set_timestamps()'::regprocedure
    ) THEN
        DROP TRIGGER IF EXISTS "mastra_ai_spans_timestamps" ON "public"."mastra_ai_spans";

        CREATE TRIGGER "mastra_ai_spans_timestamps"
            BEFORE INSERT OR UPDATE ON "public"."mastra_ai_spans"
            FOR EACH ROW
            EXECUTE FUNCTION "public".trigger_set_timestamps();
    END IF;
END
$mastra_timestamps_trigger$;
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_traceid_startedat_idx" ON "public"."mastra_ai_spans" ("traceId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_parentspanid_startedat_idx" ON "public"."mastra_ai_spans" ("parentSpanId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_name_idx" ON "public"."mastra_ai_spans" ("name");
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_spantype_startedat_idx" ON "public"."mastra_ai_spans" ("spanType", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_root_spans_idx" ON "public"."mastra_ai_spans" ("startedAt" DESC) WHERE "parentSpanId" IS NULL;
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_entitytype_entityid_idx" ON "public"."mastra_ai_spans" ("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_entitytype_entityname_idx" ON "public"."mastra_ai_spans" ("entityType", "entityName");
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_orgid_userid_idx" ON "public"."mastra_ai_spans" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_metadata_gin_idx" ON "public"."mastra_ai_spans" USING gin ("metadata");
CREATE INDEX IF NOT EXISTS "mastra_ai_spans_tags_gin_idx" ON "public"."mastra_ai_spans" USING gin ("tags");

            CREATE TABLE IF NOT EXISTS "public"."mastra_scorers" (
              "id" TEXT PRIMARY KEY NOT NULL,
"scorerId" TEXT NOT NULL,
"traceId" TEXT ,
"spanId" TEXT ,
"runId" TEXT NOT NULL,
"scorer" JSONB NOT NULL,
"preprocessStepResult" JSONB ,
"extractStepResult" JSONB ,
"analyzeStepResult" JSONB ,
"score" FLOAT NOT NULL,
"reason" TEXT ,
"metadata" JSONB ,
"preprocessPrompt" TEXT ,
"extractPrompt" TEXT ,
"generateScorePrompt" TEXT ,
"generateReasonPrompt" TEXT ,
"analyzePrompt" TEXT ,
"reasonPrompt" TEXT ,
"input" JSONB NOT NULL,
"output" JSONB NOT NULL,
"additionalContext" JSONB ,
"requestContext" JSONB ,
"entityType" TEXT ,
"entity" JSONB ,
"entityId" TEXT ,
"source" TEXT NOT NULL,
"resourceId" TEXT ,
"threadId" TEXT ,
"organizationId" TEXT ,
"projectId" TEXT ,
"batchId" TEXT ,
"datasetId" TEXT ,
"datasetItemId" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE INDEX IF NOT EXISTS "mastra_scores_trace_id_span_id_created_at_idx" ON "public"."mastra_scorers" ("traceId", "spanId", "createdAt" DESC);

            CREATE TABLE IF NOT EXISTS "public"."mastra_scorer_definitions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"organizationId" TEXT ,
"projectId" TEXT ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_scorer_definition_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"scorerDefinitionId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT ,
"type" TEXT NOT NULL,
"model" JSONB ,
"instructions" TEXT ,
"scoreRange" JSONB ,
"presetConfig" JSONB ,
"defaultSampling" JSONB ,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_scorer_definition_versions_def_version" ON "public"."mastra_scorer_definition_versions" ("scorerDefinitionId", "versionNumber");

            CREATE TABLE IF NOT EXISTS "public"."mastra_prompt_blocks" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_prompt_block_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"blockId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT ,
"content" TEXT NOT NULL,
"rules" JSONB ,
"requestContextSchema" JSONB ,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_prompt_block_versions_block_version" ON "public"."mastra_prompt_block_versions" ("blockId", "versionNumber");

            CREATE TABLE IF NOT EXISTS "public"."mastra_agents" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"visibility" TEXT ,
"metadata" JSONB ,
"favoriteCount" INTEGER ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_agent_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"agentId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT ,
"instructions" TEXT NOT NULL,
"model" JSONB NOT NULL,
"tools" JSONB ,
"defaultOptions" JSONB ,
"workflows" JSONB ,
"agents" JSONB ,
"integrationTools" JSONB ,
"toolProviders" JSONB ,
"inputProcessors" JSONB ,
"outputProcessors" JSONB ,
"memory" JSONB ,
"scorers" JSONB ,
"mcpClients" JSONB ,
"requestContextSchema" JSONB ,
"workspace" JSONB ,
"skills" JSONB ,
"skillsFormat" TEXT ,
"durable" JSONB ,
"browser" JSONB ,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_mcp_clients" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_mcp_client_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"mcpClientId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT ,
"servers" JSONB NOT NULL,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_client_versions_client_version" ON "public"."mastra_mcp_client_versions" ("mcpClientId", "versionNumber");

            CREATE TABLE IF NOT EXISTS "public"."mastra_mcp_servers" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_mcp_server_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"mcpServerId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"version" TEXT NOT NULL,
"description" TEXT ,
"instructions" TEXT ,
"repository" JSONB ,
"releaseDate" TEXT ,
"isLatest" BOOLEAN ,
"packageCanonical" TEXT ,
"tools" JSONB ,
"agents" JSONB ,
"workflows" JSONB ,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_server_versions_server_version" ON "public"."mastra_mcp_server_versions" ("mcpServerId", "versionNumber");

            CREATE TABLE IF NOT EXISTS "public"."mastra_workspaces" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"metadata" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_workspace_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"workspaceId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT ,
"filesystem" JSONB ,
"sandbox" JSONB ,
"mounts" JSONB ,
"search" JSONB ,
"skills" JSONB ,
"tools" JSONB ,
"autoSync" BOOLEAN ,
"operationTimeout" INTEGER ,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workspace_versions_workspace_version" ON "public"."mastra_workspace_versions" ("workspaceId", "versionNumber");

            CREATE TABLE IF NOT EXISTS "public"."mastra_skills" (
              "id" TEXT PRIMARY KEY NOT NULL,
"status" TEXT NOT NULL,
"activeVersionId" TEXT ,
"authorId" TEXT ,
"visibility" TEXT ,
"favoriteCount" INTEGER ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_skill_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"skillId" TEXT NOT NULL,
"versionNumber" INTEGER NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT NOT NULL,
"instructions" TEXT NOT NULL,
"license" TEXT ,
"compatibility" JSONB ,
"source" JSONB ,
"references" JSONB ,
"scripts" JSONB ,
"assets" JSONB ,
"files" JSONB ,
"metadata" JSONB ,
"tree" JSONB ,
"changedFields" JSONB ,
"changeMessage" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_versions_skill_version" ON "public"."mastra_skill_versions" ("skillId", "versionNumber");

            CREATE TABLE IF NOT EXISTS "public"."mastra_skill_blobs" (
              "hash" TEXT PRIMARY KEY NOT NULL,
"content" TEXT NOT NULL,
"size" INTEGER NOT NULL,
"mimeType" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_tool_provider_connections" (
              "authorId" TEXT NOT NULL,
"providerId" TEXT NOT NULL,
"connectionId" TEXT NOT NULL,
"toolkit" TEXT NOT NULL,
"label" TEXT ,
"scope" TEXT NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("authorId", "providerId", "connectionId")
            );
            
          
          
CREATE INDEX IF NOT EXISTS "idx_tool_provider_connections_author" ON "public"."mastra_tool_provider_connections" ("authorId", "providerId", "toolkit");

            CREATE TABLE IF NOT EXISTS "public"."mastra_workflow_snapshot" (
              "workflow_name" TEXT NOT NULL,
"run_id" TEXT NOT NULL,
"resourceId" TEXT ,
"snapshot" JSONB NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = lower('mastra_workflow_snapshot_workflow_name_run_id_key') AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
              ) AND NOT EXISTS (
                SELECT 1 FROM pg_indexes WHERE indexname = lower('mastra_workflow_snapshot_workflow_name_run_id_key') AND schemaname = 'public'
              ) THEN
                ALTER TABLE "public"."mastra_workflow_snapshot"
                ADD CONSTRAINT mastra_workflow_snapshot_workflow_name_run_id_key
                UNIQUE (workflow_name, run_id);
              END IF;
              IF EXISTS (
                SELECT 1 FROM pg_index i
                JOIN pg_class c ON i.indexrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE c.relname = lower('mastra_workflow_snapshot_workflow_name_run_id_key')
                AND n.nspname = 'public'
                AND i.indisreplident = false
              ) THEN
                ALTER TABLE "public"."mastra_workflow_snapshot"
                REPLICA IDENTITY USING INDEX mastra_workflow_snapshot_workflow_name_run_id_key;
              END IF;
            END $$;
            
          
          
CREATE INDEX IF NOT EXISTS "mastra_workflow_snapshot_name_createdat_idx" ON "public"."mastra_workflow_snapshot" ("workflow_name", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "mastra_workflow_snapshot_name_status_createdat_idx" ON "public"."mastra_workflow_snapshot" (workflow_name, (snapshot ->> 'status'), "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "mastra_workflow_snapshot_threadid_idx" ON "public"."mastra_workflow_snapshot" ((COALESCE(jsonb_path_query_first(snapshot, '$.context.* ? (@.status == "suspended").suspendPayload.__streamState.messageList.memoryInfo.threadId') #>> '{}', snapshot #>> '{context,input,messageListState,memoryInfo,threadId}')));

            CREATE TABLE IF NOT EXISTS "public"."mastra_workflow_run_owners" (
              "runId" TEXT PRIMARY KEY NOT NULL,
"generation" BIGINT NOT NULL,
"ownerId" TEXT NOT NULL,
"leaseExpiresAt" BIGINT ,
"updatedAt" BIGINT NOT NULL
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_workflow_definitions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"description" TEXT ,
"metadata" JSONB ,
"inputSchema" JSONB NOT NULL,
"outputSchema" JSONB NOT NULL,
"stateSchema" JSONB ,
"requestContextSchema" JSONB ,
"graph" JSONB NOT NULL,
"schedule" JSONB ,
"status" TEXT NOT NULL,
"source" TEXT NOT NULL,
"authorId" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_datasets" (
              "id" TEXT PRIMARY KEY NOT NULL,
"name" TEXT NOT NULL,
"description" TEXT ,
"metadata" JSONB ,
"inputSchema" JSONB ,
"groundTruthSchema" JSONB ,
"requestContextSchema" JSONB ,
"tags" JSONB ,
"targetType" TEXT ,
"targetIds" JSONB ,
"scorerIds" JSONB ,
"organizationId" TEXT ,
"projectId" TEXT ,
"candidateKey" TEXT ,
"candidateId" TEXT ,
"version" INTEGER NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_dataset_items" (
              "id" TEXT NOT NULL,
"datasetId" TEXT NOT NULL,
"datasetVersion" INTEGER NOT NULL,
"externalId" TEXT ,
"organizationId" TEXT ,
"projectId" TEXT ,
"validTo" INTEGER ,
"isDeleted" BOOLEAN NOT NULL,
"input" JSONB NOT NULL,
"groundTruth" JSONB ,
"requestContext" JSONB ,
"metadata" JSONB ,
"source" JSONB ,
"expectedTrajectory" JSONB ,
"toolMocks" JSONB ,
"unmockedToolPolicy" TEXT ,
"scorerIds" JSONB ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("id", "datasetVersion")
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_dataset_versions" (
              "id" TEXT PRIMARY KEY NOT NULL,
"datasetId" TEXT NOT NULL,
"version" INTEGER NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_experiments" (
              "id" TEXT PRIMARY KEY NOT NULL,
"name" TEXT ,
"description" TEXT ,
"metadata" JSONB ,
"provenance" JSONB ,
"runnerAttestation" JSONB ,
"experimentSetId" TEXT ,
"comparisonId" TEXT ,
"variantId" TEXT ,
"trialIndex" INTEGER ,
"datasetId" TEXT ,
"datasetVersion" INTEGER ,
"targetType" TEXT ,
"targetId" TEXT ,
"scorerIds" JSONB ,
"status" TEXT NOT NULL,
"totalItems" INTEGER NOT NULL,
"succeededCount" INTEGER NOT NULL,
"failedCount" INTEGER NOT NULL,
"skippedCount" INTEGER NOT NULL,
"startedAt" TIMESTAMP ,
"completedAt" TIMESTAMP ,
"agentVersion" TEXT ,
"organizationId" TEXT ,
"projectId" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"startedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"completedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_experiment_results" (
              "id" TEXT PRIMARY KEY NOT NULL,
"experimentId" TEXT NOT NULL,
"itemId" TEXT NOT NULL,
"itemDatasetVersion" INTEGER ,
"input" JSONB NOT NULL,
"output" JSONB ,
"groundTruth" JSONB ,
"metadata" JSONB ,
"error" JSONB ,
"startedAt" TIMESTAMP NOT NULL,
"completedAt" TIMESTAMP NOT NULL,
"retryCount" INTEGER NOT NULL,
"attempt" INTEGER ,
"traceId" TEXT ,
"status" TEXT ,
"tags" JSONB ,
"comment" TEXT ,
"toolMockReport" JSONB ,
"organizationId" TEXT ,
"projectId" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"startedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"completedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"createdAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_background_tasks" (
              "id" TEXT PRIMARY KEY NOT NULL,
"tool_call_id" TEXT NOT NULL,
"tool_name" TEXT NOT NULL,
"agent_id" TEXT NOT NULL,
"run_id" TEXT NOT NULL,
"thread_id" TEXT ,
"resource_id" TEXT ,
"status" TEXT NOT NULL,
"args" JSONB NOT NULL,
"result" JSONB ,
"error" JSONB ,
"suspend_payload" JSONB ,
"retry_count" INTEGER NOT NULL,
"max_retries" INTEGER NOT NULL,
"timeout_ms" INTEGER NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"startedAt" TIMESTAMP ,
"suspendedAt" TIMESTAMP ,
"completedAt" TIMESTAMP ,
"ownerId" TEXT ,
"leaseExpiresAt" TIMESTAMP ,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"startedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"suspendedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"completedAtZ" TIMESTAMPTZ DEFAULT NOW(),
"leaseExpiresAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE INDEX IF NOT EXISTS "mastra_bg_tasks_status_created_at_idx" ON "public"."mastra_background_tasks" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "mastra_bg_tasks_agent_status_idx" ON "public"."mastra_background_tasks" ("agent_id", "status");
CREATE INDEX IF NOT EXISTS "mastra_bg_tasks_thread_idx" ON "public"."mastra_background_tasks" ("thread_id", "createdAt");
CREATE INDEX IF NOT EXISTS "mastra_bg_tasks_tool_call_idx" ON "public"."mastra_background_tasks" ("tool_call_id");

            CREATE TABLE IF NOT EXISTS "public"."mastra_favorites" (
              "userId" TEXT NOT NULL,
"entityType" TEXT NOT NULL,
"entityId" TEXT NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("userId", "entityType", "entityId")
            );
            
          
          
CREATE INDEX IF NOT EXISTS idx_favorites_entity ON "mastra_favorites" ("entityType", "entityId");

            CREATE TABLE IF NOT EXISTS "public"."mastra_channel_installations" (
              "id" TEXT PRIMARY KEY NOT NULL,
"platform" TEXT NOT NULL,
"agentId" TEXT NOT NULL,
"status" TEXT NOT NULL,
"webhookId" TEXT ,
"data" JSONB NOT NULL,
"configHash" TEXT ,
"error" TEXT ,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_channel_config" (
              "platform" TEXT PRIMARY KEY NOT NULL,
"data" JSONB NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
            );
            
          
          
CREATE UNIQUE INDEX IF NOT EXISTS "idx_channel_installations_webhook" ON "public"."mastra_channel_installations" ("webhookId");
CREATE INDEX IF NOT EXISTS "idx_channel_installations_platform_agent" ON "public"."mastra_channel_installations" ("platform", "agentId");

            CREATE TABLE IF NOT EXISTS "public"."mastra_schedules" (
              "id" TEXT PRIMARY KEY NOT NULL,
"target" JSONB NOT NULL,
"cron" TEXT NOT NULL,
"timezone" TEXT ,
"status" TEXT NOT NULL,
"next_fire_at" BIGINT NOT NULL,
"last_fire_at" BIGINT ,
"last_run_id" TEXT ,
"created_at" BIGINT NOT NULL,
"updated_at" BIGINT NOT NULL,
"metadata" JSONB ,
"owner_type" TEXT ,
"owner_id" TEXT 
            );
            
          
          

            CREATE TABLE IF NOT EXISTS "public"."mastra_schedule_triggers" (
              "id" TEXT PRIMARY KEY NOT NULL,
"schedule_id" TEXT NOT NULL,
"run_id" TEXT ,
"scheduled_fire_at" BIGINT NOT NULL,
"actual_fire_at" BIGINT NOT NULL,
"outcome" TEXT NOT NULL,
"error" TEXT ,
"trigger_kind" TEXT NOT NULL,
"parent_trigger_id" TEXT ,
"metadata" JSONB 
            );
            
          
          
CREATE INDEX IF NOT EXISTS "idx_mastra_schedules_status_next_fire" ON "public"."mastra_schedules" ("status", "next_fire_at");
CREATE INDEX IF NOT EXISTS "idx_mastra_schedule_triggers_schedule_fire" ON "public"."mastra_schedule_triggers" ("schedule_id", "actual_fire_at" DESC);

            CREATE TABLE IF NOT EXISTS "public"."mastra_thread_state" (
              "threadId" TEXT NOT NULL,
"type" TEXT NOT NULL,
"value" JSONB NOT NULL,
"createdAt" TIMESTAMP NOT NULL,
"updatedAt" TIMESTAMP NOT NULL,
"createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
"updatedAtZ" TIMESTAMPTZ DEFAULT NOW(),
PRIMARY KEY ("threadId", "type")
            );
            
          
          