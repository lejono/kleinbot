import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { researchConfig } from "../config.js";

export function claimResearchRun(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  if (Number(values.hour) < researchConfig.hourUK) return false;
  const file = path.join(researchConfig.dir, "run-state.json");
  let lastRunDate = "";
  try { lastRunDate = JSON.parse(fs.readFileSync(file, "utf8")).lastRunDate; }
  catch (err: any) { if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err; }
  if (lastRunDate === date) return false;
  fs.mkdirSync(researchConfig.dir, { recursive: true, mode: 0o700 });
  const temp = path.join(researchConfig.dir, `${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify({ lastRunDate: date }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return true;
}
