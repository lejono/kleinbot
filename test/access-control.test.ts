import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requiresApproval } from "../src/state.js";
import { isAdminAddEvent } from "../src/jid.js";
import type { BotState } from "../src/types.js";

function freshState(): BotState {
  return { lastProcessedTimestamp: 0, processedMessageIds: [], messageHistory: [], allowedDmJids: [] };
}

const ADMIN = "+44admin";

describe("requiresApproval", () => {
  it("blocks a DM from a non-admin, unapproved sender", () => {
    const state = freshState();
    const blocked = requiresApproval(
      state,
      { chatJid: "+44stranger", senderJid: "+44stranger" },
      { isDm: true, isGroup: false, isKnownChat: false },
      ADMIN,
    );
    assert.equal(blocked, true);
  });

  it("allows a DM sent by the admin", () => {
    const state = freshState();
    const blocked = requiresApproval(
      state,
      { chatJid: "+44stranger", senderJid: ADMIN },
      { isDm: true, isGroup: false, isKnownChat: false },
      ADMIN,
    );
    assert.equal(blocked, false);
  });

  it("allows a DM from a previously approved contact", () => {
    const state = freshState();
    state.allowedDmJids.push("+44friend");
    const blocked = requiresApproval(
      state,
      { chatJid: "+44friend", senderJid: "+44friend" },
      { isDm: true, isGroup: false, isKnownChat: false },
      ADMIN,
    );
    assert.equal(blocked, false);
  });

  it("blocks the first message in a brand-new group when it's not from the admin", () => {
    const state = freshState();
    const blocked = requiresApproval(
      state,
      { chatJid: "group123", senderJid: "+44notanumber" },
      { isDm: false, isGroup: true, isKnownChat: false },
      ADMIN,
    );
    assert.equal(blocked, true);
  });

  it("allows a brand-new group's first message when it's from the admin", () => {
    const state = freshState();
    const blocked = requiresApproval(
      state,
      { chatJid: "group123", senderJid: ADMIN },
      { isDm: false, isGroup: true, isKnownChat: false },
      ADMIN,
    );
    assert.equal(blocked, false);
  });

  it("never gates an already-onboarded group, regardless of sender", () => {
    const state = freshState();
    const blocked = requiresApproval(
      state,
      { chatJid: "group123", senderJid: "+44notanumber" },
      { isDm: false, isGroup: true, isKnownChat: true },
      ADMIN,
    );
    assert.equal(blocked, false);
  });

  it("allows a new group once explicitly approved via /allow", () => {
    const state = freshState();
    state.allowedDmJids.push("group123");
    const blocked = requiresApproval(
      state,
      { chatJid: "group123", senderJid: "+44notanumber" },
      { isDm: false, isGroup: true, isKnownChat: false },
      ADMIN,
    );
    assert.equal(blocked, false);
  });
});

// Baileys group-participants.update: the admin adding the bot to a group is an
// explicit statement of intent, so it should approve the group automatically.
describe("isAdminAddEvent", () => {
  const ADMIN_LID = "111000111222333@lid";
  const BOT_LID = "555000111222333@lid";
  const BOT_PHONE = "447700900123@s.whatsapp.net";
  const STRANGER_LID = "777000111222333@lid";

  const addEvent = (over: Partial<Parameters<typeof isAdminAddEvent>[0]> = {}) => ({
    id: "120363000000000000@g.us",
    author: ADMIN_LID,
    participants: [BOT_LID],
    action: "add" as const,
    ...over,
  });

  it("approves when the admin adds the bot", () => {
    assert.equal(isAdminAddEvent(addEvent(), [BOT_LID], ADMIN_LID), true);
  });

  it("does not approve when a non-admin adds the bot", () => {
    assert.equal(isAdminAddEvent(addEvent({ author: STRANGER_LID }), [BOT_LID], ADMIN_LID), false);
  });

  it("does not approve when the admin adds someone who isn't the bot", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ participants: [STRANGER_LID] }), [BOT_LID], ADMIN_LID),
      false,
    );
  });

  it("approves when the bot is one of several participants added at once", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ participants: [STRANGER_LID, BOT_LID] }), [BOT_LID], ADMIN_LID),
      true,
    );
  });

  for (const action of ["remove", "promote", "demote", "modify"] as const) {
    it(`does not approve on a '${action}' action`, () => {
      assert.equal(isAdminAddEvent(addEvent({ action }), [BOT_LID], ADMIN_LID), false);
    });
  }

  it("tolerates a device suffix on the author JID", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ author: "111000111222333:12@lid" }), [BOT_LID], ADMIN_LID),
      true,
    );
  });

  it("tolerates a device suffix on the bot's own JID", () => {
    assert.equal(
      isAdminAddEvent(addEvent(), ["555000111222333:47@lid"], ADMIN_LID),
      true,
    );
  });

  // Guards the areJidsSameUser trap: that helper ignores the server, so a LID and a
  // phone number with identical digits compare equal. They are different namespaces
  // and different people — treating them as one would be an auth bypass.
  it("does not approve when author digits collide with the admin's across namespaces", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ author: "111000111222333@s.whatsapp.net" }), [BOT_LID], ADMIN_LID),
      false,
    );
  });

  it("returns false when adminJid is unset rather than matching everything", () => {
    assert.equal(isAdminAddEvent(addEvent({ author: "" }), [BOT_LID], ""), false);
  });

  it("returns false when the bot's own JID is unknown", () => {
    assert.equal(isAdminAddEvent(addEvent({ participants: [""] }), [""], ADMIN_LID), false);
  });

  // sock.user is a Contact carrying both a .lid and a .jid for the same account, and
  // group participants arrive as @lid. Matching any of the bot's own known identities
  // is required, or the check misses whenever the identity forms differ.
  it("matches the bot on its LID when participants use LID form", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ participants: [BOT_LID] }), [BOT_PHONE, BOT_LID], ADMIN_LID),
      true,
    );
  });

  it("matches the bot on its phone JID when participants use phone form", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ participants: [BOT_PHONE] }), [BOT_PHONE, BOT_LID], ADMIN_LID),
      true,
    );
  });

  it("ignores empty identity slots when the bot has only one form known", () => {
    assert.equal(
      isAdminAddEvent(addEvent({ participants: [BOT_LID] }), ["", BOT_LID], ADMIN_LID),
      true,
    );
    assert.equal(
      isAdminAddEvent(addEvent({ participants: [STRANGER_LID] }), ["", BOT_LID], ADMIN_LID),
      false,
    );
  });
});
