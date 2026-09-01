import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set([
  ".git",
  ".superstack",
  "node_modules",
  "research",
  "target",
  "tmp",
]);
const excludedFiles = new Set(["AGENTS.md", "RESEARCH.md"]);
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
const failures = [];

for (const file of markdownFiles(root)) {
  const contents = readFileSync(file, "utf8");

  for (const match of contents.matchAll(linkPattern)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || isExternal(rawTarget)) {
      continue;
    }

    const targetWithoutTitle = rawTarget.replace(/^<|>$/g, "").split(/\s+"/u, 1)[0];
    const path = targetWithoutTitle?.split("#", 1)[0];
    if (!path) {
      continue;
    }

    const resolved = resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(resolved)) {
      failures.push(`${relativeToRoot(file)} -> ${path}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Broken local Markdown links:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Local Markdown link check passed.");
}

function* markdownFiles(directory) {
  for (const entry of readdirSync(directory)) {
    if (excludedDirectories.has(entry) || excludedFiles.has(entry)) {
      continue;
    }

    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* markdownFiles(path);
    } else if (extname(path) === ".md") {
      yield path;
    }
  }
}

function isExternal(target) {
  return (
    target.startsWith("#") ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:")
  );
}

function relativeToRoot(path) {
  return path.slice(root.length + 1);
}
