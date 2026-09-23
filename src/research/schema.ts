import type { PostRecord } from "./corpus.js";
import { researchConfig } from "../config.js";

export interface Classification {
  id: string; isOrganising: boolean; project: string | null; goal: string | null;
  actors: string[]; decisionMechanism: string | null; resourceAllocation: string | null;
  stakes: string | null; codes: string[]; quote: string | null; confidence: number;
}
export interface ClassifiedRecord extends Classification {
  platform: string; classifiedAt: string; model: string;
}

const nullableString = { type: ["string", "null"] };
const properties = {
  id: { type: "string" }, isOrganising: { type: "boolean" }, project: nullableString,
  goal: nullableString, actors: { type: "array", items: { type: "string" } },
  decisionMechanism: nullableString, resourceAllocation: nullableString, stakes: nullableString,
  codes: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", maxLength: researchConfig.maxCodeChars, pattern: "^[a-z][a-z0-9 -]*$" } },
  quote: { ...nullableString, maxLength: researchConfig.maxQuoteChars }, confidence: { type: "number", minimum: 0, maximum: 1 },
};
export const outputSchema = {
  type: "object", additionalProperties: false, required: ["results"], properties: {
    results: { type: "array", items: { type: "object", additionalProperties: false,
      properties, required: Object.keys(properties) } },
  },
};

export function validateResult(value: unknown, post: PostRecord): Classification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.id !== post.id || typeof v.isOrganising !== "boolean" || typeof v.confidence !== "number"
    || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return null;
  if (!Array.isArray(v.codes) || v.codes.length < 2 || v.codes.length > 5
    || v.codes.some(c => typeof c !== "string" || c.length > researchConfig.maxCodeChars || !/^[a-z][a-z0-9 -]*$/.test(c))) return null;
  const codes = [...new Set(v.codes as string[])];
  if (codes.length < 2) return null;
  const nullable = (s: unknown) => typeof s === "string" ? s : null;
  const quote = nullable(v.quote);
  return {
    id: post.id, isOrganising: v.isOrganising, project: nullable(v.project), goal: nullable(v.goal),
    actors: Array.isArray(v.actors) ? v.actors.filter((a): a is string => typeof a === "string") : [],
    decisionMechanism: nullable(v.decisionMechanism), resourceAllocation: nullable(v.resourceAllocation),
    stakes: nullable(v.stakes), codes,
    quote: quote && quote.length <= researchConfig.maxQuoteChars && (post.content.includes(quote) || post.title.includes(quote)) ? quote : null,
    confidence: v.confidence,
  };
}
