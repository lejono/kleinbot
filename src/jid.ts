import { jidNormalizedUser } from "baileys";

export type ParticipantAction = "add" | "remove" | "promote" | "demote" | "modify";

export interface GroupParticipantsUpdate {
  /** Group JID the action happened in */
  id: string;
  /** JID of whoever performed the action */
  author: string;
  /** JIDs the action was performed on */
  participants: string[];
  action: ParticipantAction;
}

/**
 * Compare two JIDs for identity.
 *
 * Deliberately NOT Baileys' areJidsSameUser(), which compares only the user part and
 * ignores the server — so areJidsSameUser("123@lid", "123@s.whatsapp.net") is true.
 * A LID is an opaque identifier in a separate namespace from a phone number; identical
 * digits are not the same person. This is an auth check, so the namespace must match.
 *
 * jidNormalizedUser() strips the device suffix (":12") and maps c.us -> s.whatsapp.net
 * while preserving @lid, so an exact comparison of the results is both robust to device
 * suffixes and strict about namespace.
 */
export function isSameJid(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normA = jidNormalizedUser(a);
  const normB = jidNormalizedUser(b);
  if (!normA || !normB) return false;
  return normA === normB;
}

/**
 * Whether a group-participants update is "the admin added me to this group", which we
 * treat as explicit approval of that group.
 *
 * botJids is the bot's own known identities. Baileys' sock.user is a Contact carrying
 * both a .lid and a .jid for the same account, and group participants arrive in @lid
 * form, so we must match on any of them. These are authenticated identities of one
 * account supplied by Baileys — unlike comparing raw digits across namespaces, which
 * isSameJid() deliberately refuses.
 *
 * Only fires while the daemon is connected — Baileys companion devices receive nothing
 * offline, so an add that happens while the bot is down produces no event and the group
 * still has to go through the normal approval gate.
 */
export function isAdminAddEvent(
  evt: GroupParticipantsUpdate,
  botJids: string[],
  adminJid: string,
): boolean {
  if (evt.action !== "add") return false;
  if (!isSameJid(evt.author, adminJid)) return false;
  return evt.participants.some((p) => botJids.some((self) => isSameJid(p, self)));
}
