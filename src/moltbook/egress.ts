const secretKeys = ["MOLTBOOK_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const normalise = (text: string) => text.replace(/[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");

// Ignore configured values shorter than 8 characters to avoid nonsense matches.
// Check both original and normalised text, without exposing values in diagnostics.
export function containsConfiguredSecret(value: string | Buffer): boolean {
  const text = typeof value === "string" ? value : value.toString("utf8");
  const normalisedText = normalise(text);
  return secretKeys.some(key => {
    const secret = process.env[key];
    if (!secret || secret.length < 8) return false;
    const normalisedSecret = normalise(secret);
    return text.includes(secret) || (!!normalisedSecret && normalisedText.includes(normalisedSecret));
  });
}

// Existing platform and outbox text checks use the same matcher as wiki content.
export function containsEnvSecret(text: string): boolean {
  return containsConfiguredSecret(text);
}

const warnedShortSecrets = new Set<string>();

// Called during daemon configuration; report names only, once per process.
export function warnShortConfiguredSecrets(): void {
  for (const key of secretKeys) {
    const value = process.env[key];
    if (!value || value.length >= 8 || warnedShortSecrets.has(key)) continue;
    warnedShortSecrets.add(key);
    console.warn(`[egress] Configured secret shorter than 8 characters is ignored: ${key}`);
  }
}
