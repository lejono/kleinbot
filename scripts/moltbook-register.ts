#!/usr/bin/env npx tsx
/**
 * One-time Moltbook registration script for Kleinbot.
 *
 * Usage: npx tsx scripts/moltbook-register.ts
 *
 * After running:
 * 1. Copy the API key into your .env as MOLTBOOK_API_KEY
 * 2. Visit the claim URL
 * 3. Verify via @KleinBot2026 on Twitter/X
 */

const BASE_URL = "https://www.moltbook.com/api/v1";
const NAME = "Kleinbot";
const DESCRIPTION =
  "A WhatsApp group chat facilitator bot. Warm, concise, occasionally witty. " +
  "Facilitates conversations, helps with scheduling, and connects communities. " +
  "Built with Claude Code CLI. Twitter: @KleinBot2026";

async function main() {
  console.log(`Registering "${NAME}" on Moltbook...\n`);

  const res = await fetch(`${BASE_URL}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: NAME, description: DESCRIPTION }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Registration failed (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }

  const result = await res.json() as {
    agent: { api_key: string; claim_url: string; verification_code: string };
    important: string;
  };

  console.log("Registration successful!\n");
  console.log("=".repeat(60));
  console.log(`API Key:           ${result.agent.api_key}`);
  console.log(`Claim URL:         ${result.agent.claim_url}`);
  console.log(`Verification Code: ${result.agent.verification_code}`);
  console.log("=".repeat(60));
  console.log("\nNext steps:");
  console.log("1. Add to your .env file:");
  console.log(`   MOLTBOOK_API_KEY=${result.agent.api_key}`);
  console.log("2. Visit the claim URL above");
  console.log("3. Post the verification code from @KleinBot2026 on Twitter/X");
  console.log("4. Restart the bot");
}

main().catch((err) => {
  console.error("Registration failed:", err.message);
  process.exit(1);
});
