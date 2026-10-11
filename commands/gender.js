"use strict";

const { resolveGender } = require("../src/gender");

const LABEL = { 1: "👦 boy", 2: "👧 girl", 0: "❓ unknown" };

module.exports = {
	config: {
		name: "gender",
		aliases: ["setgender"],
		version: "1.0",
		author: "CRX Shihab",
		countDown: 3,
		role: 0,
		shortDescription: { en: "Set gender so pair matches boy with girl" },
		category: "love",
		guide: {
			en: "{pn} boy | girl — set your own\n{pn} boy | girl (reply to someone) — set theirs (group admin)\n{pn} scan — list members and who is still unknown (group admin)"
		}
	},

	onStart: async function ({ args, event, message, api, usersData, role }) {
		const sub = String(args[0] || "").toLowerCase();

		if (sub === "scan") {
			if (role < 1) return message.reply("Only group admins can scan the group.");
			const info = await api.getThreadInfo(event.threadID);
			const rows = [];
			for (const id of (info.participantIDs || []).slice(0, 80)) {
				const g = await resolveGender(usersData, id);
				rows.push(`${LABEL[g.gender]}  ${g.name || id}${g.manual ? " ✔" : ""}`);
			}
			return message.reply(`Members (✔ = set by hand)\n${rows.join("\n")}\n\nFix one: reply to their message with "gender boy" or "gender girl".`);
		}

		const value = sub === "boy" || sub === "male" ? 1 : sub === "girl" || sub === "female" ? 2 : null;
		if (!value) return message.reply("Usage: gender boy | gender girl | gender scan");

		const replyTo = event.messageReply && event.messageReply.senderID;
		const target = replyTo && String(replyTo) !== String(event.senderID) ? String(replyTo) : String(event.senderID);
		if (target !== String(event.senderID) && role < 1)
			return message.reply("Only group admins can set someone else's gender.");

		await usersData.set(target, value, "gender");
		const name = await usersData.getName(target);
		return message.reply(`✅ ${name} is now set as ${LABEL[value]}.`);
	}
};
