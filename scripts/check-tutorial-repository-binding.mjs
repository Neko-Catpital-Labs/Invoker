#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tutorialPath = fileURLToPath(
  new URL("../docs/tutorial-first-agent-workflow.md", import.meta.url),
);
const tutorial = readFileSync(tutorialPath, "utf8");
const sectionStart = tutorial.indexOf("## Bind the repository\n");
const sectionEnd = tutorial.indexOf("\n## Draft the workflow", sectionStart);

if (sectionStart < 0 || sectionEnd < 0) {
  throw new Error("Could not find the repository-binding section");
}

const section = tutorial.slice(sectionStart, sectionEnd);
const requiredStatement =
  "Equivalent Git URL spellings retain that binding: a trailing slash, an optional `.git` suffix, and GitHub SSH or HTTPS forms for the same owner and repository. A genuinely different owner or repository still triggers correction.";

if (!section.includes(requiredStatement)) {
  throw new Error("Repository-binding outcomes are missing or incomplete");
}

const commandBlocks = [...tutorial.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
  (match) => match[1],
);
const commandDigest = createHash("sha256")
  .update(JSON.stringify(commandBlocks))
  .digest("hex");
const expectedCommandDigest =
  "fb2b02b07c1f8eb1016394155d898997afe6d88ad7ac4a80b6de69eb9a36bf20";

if (commandDigest !== expectedCommandDigest) {
  throw new Error(`Tutorial command blocks changed: ${commandDigest}`);
}

const outsideSection = tutorial.slice(0, sectionStart) + tutorial.slice(sectionEnd);
const outsideSectionDigest = createHash("sha256")
  .update(outsideSection)
  .digest("hex");
const expectedOutsideSectionDigest =
  "2924c9a398177aeb18e3eee9bba0f2638989eed0e7fb1fe1ed7f3f97a5fcf113";

if (outsideSectionDigest !== expectedOutsideSectionDigest) {
  throw new Error(`Content outside the binding section changed: ${outsideSectionDigest}`);
}

console.log("PASS repository-binding outcomes are documented");
console.log(`PASS ${commandBlocks.length} tutorial command blocks are unchanged`);
console.log("PASS content outside the repository-binding section is unchanged");
