#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const args = process.argv.slice(2);
const releaseMode = args.includes("--release") || process.env.NEURAKEEP_RELEASE_MODE === "oss";
const targetArg = args.find((arg) => !arg.startsWith("--"));
const root = resolve(process.cwd(), targetArg ?? ".");
const forbiddenPaths = [
  "marketing-site",
];
const forbiddenTrackedPaths = [...forbiddenPaths, ".umos", "dist", "web-dist", "test-results", "playwright-report", "blob-report"];
const forbiddenFiles = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "firebase-debug.log"
];
const forbiddenDocs = [
  "docs/HOSTED_ARCHITECTURE.md",
  "docs/HOSTED_FIREBASE_MVP.md",
  "docs/REMOTE_TEAM_ARCHITECTURE.md",
  "docs/FEATURE_MATRIX.md",
  "ARCHITECTURE.md",
  "BACKLOG.md",
  "BUILD_SPEC.md",
  "CLAUDE_OPUS_REVIEW.md",
  "CLAUDE_REVIEW_PROMPT.md",
  "FINAL_PLAN.md",
  "RESEARCH_NOTES.md",
  "ROADMAP.md",
  "V1_WEDGE.md"
];
const secretPatterns = [
  { name: "OpenAI API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: "Stripe secret key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: "Stripe webhook secret", regex: /\bwhsec_[A-Za-z0-9]{24,}\b/g },
  { name: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "Google service account private key", regex: /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/g },
  {
    name: "generic secret assignment",
    regex: /^(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*(?!["']?(?:<|REPLACE|your-|sha256:|test|example|placeholder|null|undefined))[^#\s][^\n]*/gm
  }
];
const privateCodePatterns = [
  { name: "Firebase Admin implementation", regex: /firebase-admin\/(?:app|auth)/g },
  { name: "Firebase browser implementation", regex: /firebase\/(?:app|auth)/g },
  { name: "Firebase token verification implementation", regex: /\bverifyIdToken\s*\(/g }
];
const privateWorkspacePatterns = [
  { name: "Windows user home path", regex: /\b[A-Za-z]:\\Users\\[^\\\s"'<>]+\\/g },
  { name: "macOS user home path", regex: /\/Users\/[^/\s"'<>]+\//g }
];
const allowSecretFiles = new Set([".env.example"]);
const allowPatternFiles = new Set(["scripts/security-scan.mjs"]);
const scanExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsonl", ".md", ".mjs", ".sql", ".svg", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);
const skipDirs = new Set([".git", ".worktrees", ".superpowers", ".npm-cache", "node_modules", ".umos", "release", "test-results", "playwright-report", "blob-report"]);

const errors = [];

if (releaseMode) {
  for (const path of [...forbiddenPaths, ...forbiddenFiles, ...forbiddenDocs]) {
    if (existsSync(join(root, path))) {
      errors.push(`Forbidden OSS release artifact present: ${path}`);
    }
  }
}

for (const file of trackedFiles()) {
  const normalized = file.split("\\").join("/");
  if (forbiddenTrackedPaths.some((path) => normalized === path || normalized.startsWith(`${path}/`))) {
    errors.push(`Forbidden tracked path: ${normalized}`);
  }
  if (!allowSecretFiles.has(normalized) && (forbiddenFiles.includes(normalized) || /^\.env\./.test(normalized))) {
    errors.push(`Forbidden tracked env file: ${normalized}`);
  }
  if (releaseMode && forbiddenDocs.some((path) => normalized === path || normalized.startsWith(`${path}/`))) {
    errors.push(`Private/internal doc must not be tracked in OSS release: ${normalized}`);
  }
}

for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join("/");
  if (allowSecretFiles.has(rel)) continue;
  if (!scanExtensions.has(extension(rel))) continue;
  const text = readFileSync(file, "utf8");
  if (allowPatternFiles.has(rel)) continue;
  for (const pattern of secretPatterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      errors.push(`${pattern.name} pattern in ${rel}`);
    }
  }
  if (releaseMode) {
    for (const pattern of privateCodePatterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) {
        errors.push(`${pattern.name} in OSS release file ${rel}`);
      }
    }
    for (const pattern of privateWorkspacePatterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) {
        errors.push(`${pattern.name} in OSS release file ${rel}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("NeuraKeep security scan failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("NeuraKeep security scan passed.");

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relParts = relative(root, full).split(sep);
    if (relParts.some((part) => skipDirs.has(part))) continue;
    const stats = statSync(full);
    if (stats.isDirectory()) files.push(...walk(full));
    else if (stats.size <= 2_000_000) files.push(full);
  }
  return files;
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}
