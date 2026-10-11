"use strict";

/**
 * info — full Instagram profile details (ported from the GoatBot-IG `info`).
 *   info                 your own profile
 *   info @tag / @handle  one or more users (max 3 per message)
 *   info <username|profile link|user id>
 *   reply to a message   that person's profile
 */

const { resolveUserTarget, resolveProfile } = require("../src/utils");
const { bestPicture } = require("../src/hdpic");

const MAX_TARGETS = 3;

function line(key, value) {
	return value === undefined || value === null || value === "" || value === false ? null : `│ ${key}: ${value}`;
}
const yesNo = v => (v ? "Yes" : "No");

function formatBlock(p, id) {
	const raw = p.raw || {};
	const lines = [
		"╭─ 👤 INSTAGRAM INFO ─",
		line("Username", p.username),
		line("Name", p.name),
		line("First name", p.name ? String(p.name).split(" ")[0] : null),
		line("User ID", p.userID || id),
		line("Followers", p.followers),
		line("Following", p.following),
		line("Posts", p.posts != null ? p.posts : raw.media_count),
		line("Private", yesNo(p.isPrivate)),
		line("Verified", yesNo(p.isVerified)),
		line("Business", p.isBusiness != null ? yesNo(p.isBusiness) : (raw.is_business != null ? yesNo(raw.is_business) : null)),
		line("Category", raw.category_name || raw.category),
		line("Friendship", p.isFriend ? "Following" : "Not following"),
		line("Biography", String(p.biography || "").replace(/\n/g, " ").trim()),
		line("External URL", p.externalUrl || raw.external_url),
		line("fbid", raw.fbid_v2 || raw.fbid),
		line("Interop fbid", raw.interop_messaging_user_fbid),
		line("Strong ID", raw.strong_id__),
		"╰─────────────────────"
	];
	return lines.filter(Boolean).join("\n");
}

module.exports = {
	config: {
		name: "info",
		aliases: ["whois", "userinfo", "profile"],
		author: "Neoaz 🐊",
		category: "info",
		cooldown: 5,
		role: 0,
		description: { en: "View all Instagram information of a user" },
		usage: {
			en: "{p}info — your own profile\n{p}info @tag | <username|profile link|user id> — someone else (up to 3)\nReply to a message with {p}info for that person"
		}
	},

	onStart: async function ({ message, args, event, api }) {
		// One lookup per target: the reply target, each argument, or the sender.
		const inputs = [];
		if (event.messageReply && event.messageReply.senderID) inputs.push([]);
		else if (!args.length) inputs.push([]);
		else for (const arg of args.slice(0, MAX_TARGETS)) inputs.push([arg]);

		const blocks = [];
		let picture = null;
		for (const input of inputs) {
			const label = input[0] || "";
			const target = await resolveUserTarget(input, event, api);
			if (!target.id) {
				blocks.push(target.rateLimited
					? "⏳ Instagram is rate-limiting lookups right now. Try again in a few minutes."
					: `❌ Could not find Instagram information${label ? ` for ${label}` : ""}`);
				continue;
			}
			const profile = await resolveProfile(input, event, api);
			if (!profile || (profile.rateLimited && !profile.username && !profile.name)) {
				blocks.push(profile && profile.rateLimited
					? "⏳ Instagram is rate-limiting lookups right now. Try again in a few minutes."
					: `❌ Could not find Instagram information${label ? ` for ${label}` : ""}`);
				continue;
			}
			blocks.push(formatBlock(profile, target.id));
			if (!picture) picture = profile;
		}

		const body = blocks.join("\n\n");
		if (picture) {
			try {
				const best = await bestPicture([...(picture.pictureUrls || []), picture.profilePicture]);
				if (best) return message.reply({ body, attachment: { buffer: best.buffer, fileName: `profile.${best.ext}` }, textFirst: true });
			}
			catch (_) { /* fall through to the plain URL / text */ }
			if (picture.profilePicture) return message.reply({ body, attachment: picture.profilePicture, textFirst: true });
		}
		return message.reply(body);
	}
};
