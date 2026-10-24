import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const vaultRoot = resolve(".umos-e2e");
const fixturePath = resolve("tests", "fixtures", "e2e-memory.md");
const cliPath = resolve("dist", "cli", "index.js");

rmSync(vaultRoot, { recursive: true, force: true });
mkdirSync(dirname(vaultRoot), { recursive: true });

function runCli(args) {
  execFileSync(process.execPath, [cliPath, ...args], { stdio: "inherit" });
}

runCli(["init", "--root", vaultRoot]);
runCli([
  "ingest",
  fixturePath,
  "--root",
  vaultRoot,
  "--kind",
  "markdown",
  "--space",
  "personal",
  "--trust-level",
  "trusted",
  "--origin",
  "manual",
  "--sensitivity",
  "internal"
]);
runCli(["app", "--root", vaultRoot]);
