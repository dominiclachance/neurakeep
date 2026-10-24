#!/usr/bin/env node
import { Command } from "commander";
import { evalCommand } from "./commands/eval.js";
import { appCommand } from "./commands/app.js";
import { applyCommand } from "./commands/apply.js";
import { ingestCommand } from "./commands/ingest.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { proposeCommand } from "./commands/propose.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";
import { NEURAKEEP_VERSION } from "../mcp/manifest.js";

const program = new Command();

program
  .name("umos")
  .description("NeuraKeep: local-first, source-cited memory for AI agents.")
  .version(NEURAKEEP_VERSION);

program
  .command("init")
  .description("Initialize a NeuraKeep vault.")
  .option("--local", "Create a project-local .umos vault in the current directory.")
  .option("--root <path>", "Create or initialize a vault at a specific path.")
  .action(initCommand);

program
  .command("ingest")
  .description("Ingest a local markdown, note, PDF, or session transcript into NeuraKeep.")
  .argument("<path>", "File to ingest.")
  .option("--kind <kind>", "session, note, markdown, or pdf.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--space <space>", "personal, project, or system.")
  .option("--trust-level <level>", "untrusted, observed, trusted, or verified.")
  .option("--origin <origin>", "manual, local_file, session, agent, connector, import, or system.")
  .option("--visibility <visibility>", "private, space, team, client, or public.")
  .option("--sensitivity <sensitivity>", "normal, internal, confidential, or secret.")
  .option("--json", "Print machine-readable JSON.")
  .action(ingestCommand);

program
  .command("search")
  .description("Search indexed memory sections.")
  .argument("<query>", "Search query.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--space <space>", "Filter by memory space.")
  .option("--limit <number>", "Maximum result count.")
  .option("--neighbors <number>", "Include previous/next section context, 0-2.")
  .option("--project <name>", "Boost results tagged with a project in metadata.")
  .option("--include-secret", "Include records marked sensitivity=secret.")
  .option("--json", "Print machine-readable JSON.")
  .action(searchCommand);

program
  .command("mcp")
  .description("Run the NeuraKeep MCP-compatible stdio server.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .action(mcpCommand);

program
  .command("serve")
  .description("Run NeuraKeep over HTTP for remote MCP tunnels or local UI use.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--host <host>", "Bind host. Defaults to 127.0.0.1.")
  .option("--port <number>", "Bind port. Defaults to 8890.")
  .option("--token <token>", "Require Authorization: Bearer <token> for POST /mcp.")
  .option("--service-token <token>", "Allow a bearer service token for remote MCP/API access. Can be repeated or set with NEURAKEEP_SERVICE_TOKENS.")
  .option("--read-write", "Allow proposal/apply tools over HTTP. Default is read-only.")
  .option("--ui", "Serve the local NeuraKeep app from the same process.")
  .option("--hosted", "Enable hosted mode and require Firebase Authentication ID tokens for /api and POST /mcp.")
  .option("--firebase-project <id>", "Firebase project ID for hosted mode token verification.")
  .action(serveCommand);

program
  .command("propose")
  .description("Create a cited structured-memory proposal from an ingested source.")
  .argument("<source>", "Source ID, section ID, or 'latest'.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--extractor <mode>", "deterministic or command.")
  .option("--extractor-command <command>", "Command that reads extraction JSON input from stdin and returns JSON.")
  .option("--json", "Print machine-readable JSON.")
  .action(proposeCommand);

program
  .command("apply")
  .description("Apply a pending structured-memory proposal and compile the wiki.")
  .argument("<proposal-id>", "Proposal ID.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--json", "Print machine-readable JSON.")
  .action(applyCommand);

program
  .command("app")
  .description("Export the static NeuraKeep app and graph view.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--json", "Print machine-readable JSON.")
  .action(appCommand);

program
  .command("eval")
  .description("Seed or run the retrieval eval harness.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--space <space>", "Filter by memory space.")
  .option("--limit <number>", "Maximum result count per case.")
  .option("--neighbors <number>", "Include previous/next section context, 0-2.")
  .option("--seed", "Seed 10 starter retrieval eval cases.")
  .option("--json", "Print machine-readable JSON.")
  .action(evalCommand);

program
  .command("status")
  .description("Show vault status and record counts.")
  .option("--local", "Use the project-local .umos vault in the current directory.")
  .option("--root <path>", "Use a specific vault path.")
  .option("--json", "Print machine-readable JSON.")
  .action(statusCommand);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`umos: ${message}`);
  process.exitCode = 1;
});
