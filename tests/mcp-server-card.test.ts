import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/cli/commands/init.js";
import { getVaultPaths } from "../src/core/paths.js";
import { handleJsonRpcRequest } from "../src/mcp/server.js";
import { NEURAKEEP_VERSION, neurakeepServerCard, neurakeepTools } from "../src/mcp/manifest.js";
import { assertSecureHttpBinding, runHttpMcpServer } from "../src/mcp/http.js";
import { openDatabase } from "../src/db/client.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP static server card", () => {
  it("shares exact server and tool metadata with MCP initialize and tools/list", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-card-parity-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const paths = getVaultPaths(root);
    const db = openDatabase(paths.dbPath);

    try {
      const initialize = handleJsonRpcRequest(db, paths, { jsonrpc: "2.0", id: 1, method: "initialize" });
      const tools = handleJsonRpcRequest(db, paths, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const card = neurakeepServerCard() as {
        serverInfo: unknown;
        tools: unknown;
        authentication: unknown;
        resources: unknown[];
        prompts: unknown[];
      };

      expect(card.serverInfo).toEqual((initialize?.result as { serverInfo: unknown }).serverInfo);
      expect(card.tools).toEqual((tools?.result as { tools: unknown }).tools);
      expect(card.tools).toEqual(neurakeepTools());
      expect(card.authentication).toEqual({ required: true, schemes: ["oauth2"] });
      expect(card.resources).toEqual([]);
      expect(card.prompts).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("negotiates the protocol version requested by current MCP clients", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-protocol-negotiation-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const paths = getVaultPaths(root);
    const db = openDatabase(paths.dbPath);
    try {
      const initialize = handleJsonRpcRequest(db, paths, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" }
      });
      expect((initialize?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
      const unsupported = handleJsonRpcRequest(db, paths, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2026-07-28" }
      });
      expect((unsupported?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
    } finally {
      db.close();
    }
  });

  it("uses the same version as the published package metadata", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(NEURAKEEP_VERSION).toBe("0.3.3");
    expect(packageJson.version).toBe(NEURAKEEP_VERSION);
  });

  it("does not answer JSON-RPC notifications and does not advertise command execution", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-notification-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const paths = getVaultPaths(root);
    const db = openDatabase(paths.dbPath);
    try {
      expect(handleJsonRpcRequest(db, paths, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} })).toBeNull();
      const saveTool = neurakeepTools().find((tool) => tool.name === "memory_save");
      expect(saveTool).toMatchObject({
        description: expect.stringMatching(/save or remember new text/i),
        inputSchema: {
          required: ["content"],
          properties: {
            content: { type: "string", description: expect.any(String) },
            title: { type: "string", description: expect.any(String) }
          }
        },
        annotations: {
          title: "Save memory",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      });
      const proposalTool = neurakeepTools().find((tool) => tool.name === "memory_propose_update");
      expect(proposalTool?.inputSchema.properties).toEqual({ source_id: { type: "string" } });
    } finally {
      db.close();
    }
  });

  it("saves new text as searchable memory and queues one review-gated proposal", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-save-memory-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const paths = getVaultPaths(root);
    const db = openDatabase(paths.dbPath);
    const request = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: {
          title: "Claude memory save test",
          content: "# Preference\n\nDominic prefers teal interfaces and concise release reports."
        }
      }
    };

    try {
      const first = handleJsonRpcRequest(db, paths, request);
      const firstSaved = (first?.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(firstSaved).toMatchObject({
        saved: true,
        status: "saved_pending_review",
        searchableNow: true,
        durableAutoApplied: false,
        reviewRequired: true,
        proposalId: expect.stringMatching(/^prop_/),
        sourceId: expect.stringMatching(/^src_/)
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sources").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending'").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM facts").get()).toEqual({ count: 0 });

      const search = handleJsonRpcRequest(db, paths, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "teal interfaces" } }
      });
      const searchContent = (search?.result as { structuredContent: { results: unknown[] } }).structuredContent;
      expect(searchContent.results).toHaveLength(1);

      const duplicate = handleJsonRpcRequest(db, paths, { ...request, id: 5 });
      const duplicateSaved = (duplicate?.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(duplicateSaved).toMatchObject({
        saved: true,
        status: "already_saved",
        proposalId: null,
        reviewRequired: false
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sources").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM proposals").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("executes every advertised tool through the local MCP dispatcher", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-local-tools-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const paths = getVaultPaths(root);
    const db = openDatabase(paths.dbPath);
    const call = (id: number, name: string, args: Record<string, unknown>) => handleJsonRpcRequest(db, paths, {
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args }
    });

    try {
      const listed = handleJsonRpcRequest(db, paths, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(((listed?.result as any).tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        "memory_search", "memory_read", "memory_explain_sources", "memory_save", "memory_propose_update", "memory_apply_update"
      ]);

      const saved = call(2, "memory_save", {
        title: "Local MCP tool matrix",
        content: "# Decision\n\nDominic decided that local NeuraKeep MCP clients may apply explicitly reviewed proposals."
      });
      const savedContent = (saved?.result as any).structuredContent as { sourceId: string; sectionIds: string[] };
      expect(savedContent.sourceId).toMatch(/^src_/);

      const searched = call(3, "memory_search", { query: "explicitly reviewed proposals" });
      expect((searched?.result as any).structuredContent.results).toHaveLength(1);

      const read = call(4, "memory_read", { id: savedContent.sectionIds[0] });
      expect((read?.result as any).structuredContent.record.id).toBe(savedContent.sectionIds[0]);

      const explained = call(5, "memory_explain_sources", { source_ids: [savedContent.sourceId] });
      expect((explained?.result as any).structuredContent.sources).toHaveLength(1);

      const proposed = call(6, "memory_propose_update", { source_id: savedContent.sourceId });
      const proposalId = (proposed?.result as any).structuredContent.proposalId as string;
      expect(proposalId).toMatch(/^prop_/);

      const applied = call(7, "memory_apply_update", { proposal_id: proposalId });
      expect((applied?.result as any).structuredContent.proposalId).toBe(proposalId);
    } finally {
      db.close();
    }
  });

  it("refuses unauthenticated non-loopback HTTP bindings", () => {
    const base = { port: 8890, readOnly: true, serveUi: false };
    expect(() => assertSecureHttpBinding({ ...base, host: "0.0.0.0" })).toThrow(/non-loopback host without authentication/);
    expect(() => assertSecureHttpBinding({ ...base, host: "::" })).toThrow(/non-loopback host without authentication/);
    expect(() => assertSecureHttpBinding({ ...base, host: "127.0.0.1" })).not.toThrow();
    expect(() => assertSecureHttpBinding({ ...base, host: "0.0.0.0", token: "configured-at-runtime" })).not.toThrow();
  });

  it("defaults the local app to the Sigma graph interface", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-sigma-default-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const paths = getVaultPaths(root);
    const previousEngine = process.env.NEURAKEEP_FLAG_GRAPH_ENGINE;
    delete process.env.NEURAKEEP_FLAG_GRAPH_ENGINE;
    const server = runHttpMcpServer(paths, {
      host: "127.0.0.1",
      port: 0,
      readOnly: false,
      serveUi: true,
      hosted: { enabled: false }
    });

    try {
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/settings`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        provider: "local",
        firebaseRequired: false,
        flags: { graph: { engine: "sigma" } },
        hosted: { firebaseProjectId: null },
      });
    } finally {
      server.close();
      await once(server, "close");
      if (previousEngine === undefined) delete process.env.NEURAKEEP_FLAG_GRAPH_ENGINE;
      else process.env.NEURAKEEP_FLAG_GRAPH_ENGINE = previousEngine;
    }
  });

  it("serves metadata publicly without leaking vault content or credentials", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "neurakeep-card-http-"));
    tempRoots.push(projectDir);
    const root = join(projectDir, ".umos");
    initCommand({ root });
    const canary = "PRIVATE_MEMORY_CANARY_7f9d3a";
    writeFileSync(join(projectDir, "private-memory.md"), `${canary}\nBearer top-secret-token`, "utf8");
    const paths = getVaultPaths(root);
    const server = runHttpMcpServer(paths, {
      host: "127.0.0.1",
      port: 0,
      token: "top-secret-token",
      serviceTokens: ["another-secret-token"],
      readOnly: false,
      serveUi: false,
      hosted: { enabled: false }
    });

    try {
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/mcp/server-card.json`);
      const text = await response.text();
      const protectedResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      const notificationResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer top-secret-token" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual(neurakeepServerCard());
      expect(text).not.toContain(canary);
      expect(text).not.toContain("top-secret-token");
      expect(text).not.toContain("another-secret-token");
      expect(protectedResponse.status).toBe(401);
      expect(notificationResponse.status).toBe(202);
      expect(await notificationResponse.text()).toBe("");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
