import fs from "node:fs";
import path from "node:path";
import { researchConfig } from "../config.js";
import type { PostRecord } from "./corpus.js";
import type { ClassifiedRecord } from "./schema.js";

export function postLink(id: string): string {
  return `https://www.moltbook.com/post/${encodeURIComponent(id).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`;
}

export function sanitiseText(text: string): string {
  return text.replace(/!?\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:|www\.)[^\s<>]+/gi, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/[`<>|\[\]\\*_#]/g, "").replace(/\s+/g, " ").trim().slice(0, researchConfig.maxQuoteChars);
}

function frequencies(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values.map(sanitiseText).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"));
}

export function writeSummary(posts: PostRecord[], records: ClassifiedRecord[]): string {
  const lines = ["# Agent platform research", "",
    "This corpus is a sample of what was trending when collected, not the whole platform.", "",
    "## Totals", "", "| Platform | Captured | Classified | Organising |", "| --- | ---: | ---: | ---: |"];
  for (const platform of [...new Set(posts.map(p => p.platform))].sort()) {
    const classified = records.filter(r => r.platform === platform);
    lines.push(`| ${sanitiseText(platform)} | ${posts.filter(p => p.platform === platform).length} | ${classified.length} | ${classified.filter(r => r.isOrganising).length} |`);
  }
  lines.push("", "## Open codes", "");
  for (const [code, count] of frequencies(records.flatMap(r => r.codes)).slice(0, researchConfig.maxCodes)) lines.push(`- ${code}: ${count}`);
  lines.push("", "## Projects", "", "| Project | Count | Goals seen | Decision mechanisms seen |", "| --- | ---: | --- | --- |");
  const projects = frequencies(records.flatMap(r => r.project ? [r.project] : []));
  for (const [project, count] of projects) {
    const matching = records.filter(r => r.project && sanitiseText(r.project) === project);
    const values = (key: "goal" | "decisionMechanism") => [...new Set(matching.map(r => sanitiseText(r[key] || "")).filter(Boolean))].sort().join("; ");
    lines.push(`| ${project} | ${count} | ${values("goal")} | ${values("decisionMechanism")} |`);
  }
  for (const [heading, key] of [["Decision mechanisms", "decisionMechanism"], ["Resource allocation", "resourceAllocation"]] as const) {
    lines.push("", `## ${heading}`, "");
    for (const [value, count] of frequencies(records.flatMap(r => r[key] ? [r[key]!] : []))) lines.push(`- ${value}: ${count}`);
  }
  lines.push("", "## Quotes", "");
  for (const record of records.filter(r => r.quote).sort((a, b) => `${a.platform}:${a.id}`.localeCompare(`${b.platform}:${b.id}`, "en")).slice(0, researchConfig.maxQuotes)) {
    const quote = sanitiseText(record.quote!);
    if (!quote) continue;
    const link = record.platform === "moltbook" ? ` ([post](${postLink(record.id)}))` : "";
    lines.push(`- “${quote}” — unverified text from an agent${link}`);
  }
  fs.mkdirSync(researchConfig.wikiDir, { recursive: true, mode: 0o700 });
  const file = path.join(researchConfig.wikiDir, "summary.md");
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return file;
}
