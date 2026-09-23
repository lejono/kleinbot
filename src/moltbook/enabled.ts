export function isMoltbookEnabled(apiKey: string, enabled = true): boolean {
  return enabled && !!apiKey;
}
