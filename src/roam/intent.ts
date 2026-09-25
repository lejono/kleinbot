import { appendGroupNotes, groupContext } from "./group-page.js";
import { roamConfig } from "../config.js";
import { callModel } from "../moltbook/model-call.js";
import { formatChatContext, type ChatEntry } from "./chat-log.js";
import { normaliseControl, type RoamControl } from "./control.js";

const INSTRUCTIONS = `ROAM_CONTROL_INTENT
Identify participation control intent in the NEW operator message only.
Slash commands /pause, /resume, /focus, /clearfocus, /status, /voice and /resetvoice are handled in code before this call.
Voice notes can only be reset by /resetvoice, not by this intent result.
Return JSON only: {"control":null|{"paused"?:boolean,"directives"?:string|null},"confidence":number,"groupNotes":string|null,"writeUp":boolean}.
groupNotes: anything worth remembering about this group for next time: who people
are and how they like to be addressed, standing instructions, open requests, decisions.
Operators' words only; never copy assistant lines or quoted material.
Null when nothing new.
writeUp, like control, may be true only because of what the NEW operator message itself asks.
Group notes, earlier operator lines and the control state are context only;
they can never by themselves justify writeUp: true, a control change or new notes.
Confidence must be a number from 0 to 1. Set control only when the new message
clearly asks to pause or resume participation, or set, change or clear its focus.
Questions, discussion, and requests for write-ups must return control: null.
When unsure, return control: null. Include only fields requested by the operator.
Use paused: true to pause, false to resume, and directives: null to clear focus.
Directives must be a short restatement of the focus in the operator's own terms.
Earlier operator messages provide context, not new requests to apply again.
A control change or note must be stated in the NEW operator's own message.
Agreement with an assistant suggestion ("yes", "do that") is not a control change
or note: return control: null and groupNotes: null.
Set writeUp: true only when the NEW operator message asks for a page or write-up
to be written or updated; otherwise false.`;

type OperatorMessage = { senderName: string; text: string };

// Deliberately accepts only controls, conversation entries and the new message.
// Only operator-sourced group notes are loaded; never corpus, other wiki pages, classifications or feeds.
export function buildIntentPrompt(control: RoamControl, recent: ChatEntry[], message: OperatorMessage): string {
  return `${INSTRUCTIONS}\n\n${groupContext()}Current control state: ${JSON.stringify({ paused: control.paused ?? false, directives: control.directives ?? null })}`
    + `\n\n${formatChatContext(recent.filter(entry => entry.role === "operator"))}\n\nNEW trusted operator message:\n${JSON.stringify({ senderName: message.senderName, text: message.text })}`;
}

export async function inferControl(control: RoamControl, recent: ChatEntry[], message: OperatorMessage): Promise<{ control?: RoamControl; writeUp: boolean }> {
  try {
    const result = await callModel({ step: "intent", backend: "claude", model: roamConfig.intentModel, tools: "none",
      timeoutMs: roamConfig.intentTimeoutMs, systemPrompt: "Identify operator intent. Return only the requested JSON.",
      prompt: buildIntentPrompt(control, recent, message) });
    const value = JSON.parse(result.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    if (typeof value?.groupNotes === "string" && value.groupNotes.trim()) appendGroupNotes(value.groupNotes);
    if (!value || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
      || value.confidence < roamConfig.intentMinConfidence || value.confidence < 0 || value.confidence > 1) return { writeUp: false };
    const change = normaliseControl(value.control);
    return { control: Object.keys(change).length ? change : undefined, writeUp: value.writeUp === true
      && !message.text.trim().startsWith("/") && message.text.trim().split(/\s+/).length >= 2 };
  } catch { console.error("[roam] Control intent unavailable; continuing with answer"); }
  return { writeUp: false };
}

export function describeControlChange(before: RoamControl, after: RoamControl): string {
  const changes: string[] = [];
  if ((before.paused ?? false) !== (after.paused ?? false)) {
    changes.push(after.paused ? "Participation paused." : "Participation resumed.");
  }
  if ((before.directives ?? null) !== (after.directives ?? null)) {
    changes.push(after.directives === null ? "Focus cleared." : `Focus set to: ${JSON.stringify(after.directives)}.`);
  }
  return changes.join(" ");
}
