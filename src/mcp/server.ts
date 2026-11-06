import { createInterface } from "node:readline";
import type { VaultPaths } from "../core/paths.js";
import { migrateDatabase, openDatabase, type UmosDatabase } from "../db/client.js";
import { ingestText } from "../ingest/ingest.js";
import { applyProposal, proposeSourceExtraction } from "../memory/proposals.js";
import { explainSources, readMemoryRecord } from "../memory/records.js";
import { retrievalGuidance, searchSections } from "../search/fts.js";
import { NEURAKEEP_SERVER_INFO, neurakeepTools } from "./manifest.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcRequest["id"];
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

const supportedProtocolVersions = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);
const latestProtocolVersion = "2025-11-25";

export function runMcpServer(paths: VaultPaths): void {
  const db = openDatabase(paths.dbPath);
  migrateDatabase(db);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    try {
      const request = JSON.parse(line.replace(/^\uFEFF/, "")) as JsonRpcRequest;
      const response = handleJsonRpcRequest(db, paths, request);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      writeResponse(null, null, error);
    }
  });

  rl.on("close", () => {
    db.close();
  });
}

export function handleJsonRpcRequest(
  db: UmosDatabase,
  paths: VaultPaths,
  request: JsonRpcRequest
): JsonRpcResponse | null {
  if (request.method === "initialize") {
    const requestedVersion = typeof request.params?.protocolVersion === "string"
      ? request.params.protocolVersion
      : undefined;
    return makeResponse(request.id, {
      protocolVersion: requestedVersion && supportedProtocolVersions.has(requestedVersion)
        ? requestedVersion
        : latestProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { ...NEURAKEEP_SERVER_INFO }
    });
  }

  if (request.method === "notifications/initialized") {
    return null;
  }

  if (request.id === undefined) {
    return null;
  }

  if (request.method === "tools/list") {
    return makeResponse(request.id, { tools: toolsList() });
  }

  if (request.method === "tools/call") {
    const name = String(request.params?.name ?? "");
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    return makeResponse(request.id, callTool(db, paths, name, args));
  }

  return makeResponse(request.id, null, new Error(`Unsupported method: ${request.method}`));
}

function callTool(
  db: UmosDatabase,
  paths: VaultPaths,
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (name === "memory_search") {
    const results = searchSections(db, {
      query: stringArg(args.query, "query"),
      limit: numberArg(args.limit, 10),
      neighbors: numberArg(args.neighbors, 0),
      space: optionalString(args.space) as never,
      project: optionalString(args.project),
      includeSecret: false
    });
    return content({ results, guidance: retrievalGuidance(results) });
  }

  if (name === "memory_read") {
    const record = readMemoryRecord(db, stringArg(args.id, "id"));
    return content({ record });
  }

  if (name === "memory_explain_sources") {
    const sourceIds = arrayArg(args.source_ids, "source_ids");
    return content({ sources: explainSources(db, sourceIds) });
  }

  if (name === "memory_save") {
    const ingest = ingestText(db, paths, {
      content: stringArg(args.content, "content"),
      title: optionalString(args.title),
      kind: "markdown",
      space: "personal",
      trustLevel: "observed",
      sourceOrigin: "agent",
      visibility: "private",
      sensitivity: "internal"
    });
    const proposal = ingest.skipped
      ? null
      : proposeSourceExtraction(db, ingest.sourceId, {
          extractor: "deterministic",
          reportPaths: paths
        });
    return content({
      saved: true,
      status: ingest.skipped ? "already_saved" : "saved_pending_review",
      sourceId: ingest.sourceId,
      sectionIds: ingest.sectionIds,
      proposalId: proposal?.proposalId ?? null,
      proposalSummary: proposal?.summary ?? null,
      searchableNow: true,
      durableAutoApplied: false,
      reviewRequired: Boolean(proposal),
      riskFlags: ingest.riskFlags
    });
  }

  if (name === "memory_propose_update") {
    const sourceId = stringArg(args.source_id ?? args.id, "source_id");
    return content(
      proposeSourceExtraction(db, sourceId, {
        extractor: "deterministic",
        reportPaths: paths
      })
    );
  }

  if (name === "memory_apply_update") {
    const proposalId = stringArg(args.proposal_id, "proposal_id");
    return content(applyProposal(db, paths, proposalId));
  }

  throw new Error(`Unknown tool: ${name}`);
}

function toolsList(): Array<Record<string, unknown>> {
  return neurakeepTools();
}

function content(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

function writeResponse(id: JsonRpcRequest["id"], result: unknown, error?: unknown): void {
  process.stdout.write(`${JSON.stringify(makeResponse(id, result, error))}\n`);
}

function makeResponse(id: JsonRpcRequest["id"], result: unknown, error?: unknown): JsonRpcResponse {
  return error
    ? {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    : { jsonrpc: "2.0", id, result };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayArg(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}
