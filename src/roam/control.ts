import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { researchConfig, roamConfig } from "../config.js";
import { cleanInboxText } from "./inbox.js";

export interface RoamControl { paused?: boolean; directives?: string | null }

export function normaliseControl(value: unknown): RoamControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as RoamControl;
  const control: RoamControl = {};
  if (typeof input.paused === "boolean") control.paused = input.paused;
  if (input.directives === null) control.directives = null;
  else if (typeof input.directives === "string") {
    control.directives = cleanInboxText(input.directives).slice(0, roamConfig.controlMaxDirectiveChars);
  }
  return control;
}

export function readRoamControl(): RoamControl {
  try { return normaliseControl(JSON.parse(fs.readFileSync(path.join(researchConfig.dir, "control.json"), "utf8"))); }
  catch { return {}; }
}

export function writeRoamControl(control: RoamControl): void {
  fs.mkdirSync(researchConfig.dir, { recursive: true, mode: 0o700 });
  const temp = path.join(researchConfig.dir, `${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(normaliseControl(control)) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, path.join(researchConfig.dir, "control.json"));
  } finally { try { fs.unlinkSync(temp); } catch { /* Already renamed. */ } }
}
