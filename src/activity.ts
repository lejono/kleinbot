import fs from "fs";
import path from "path";
import { dataDir } from "./config.js";

const ACTIVITY_LOG = path.join(dataDir, "activity.log");

/**
 * Append a timestamped line to the shared cross-transport activity log.
 */
export function logActivity(
  transport: string,
  chatId: string,
  event: string,
  detail?: string,
): void {
  const ts = new Date().toISOString();
  const line = detail
    ? `${ts} [${transport}] ${event} ${chatId} ${detail}\n`
    : `${ts} [${transport}] ${event} ${chatId}\n`;

  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, line);
  } catch (err: any) {
    console.error(`[activity] Failed to write log:`, err.message);
  }
}
