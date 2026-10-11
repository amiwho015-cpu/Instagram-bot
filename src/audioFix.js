"use strict";

/**
 * Instagram voice messages only play when the file is AAC in an MP4/M4A
 * container. Commands (song, spotify, ytb, say …) hand over raw mp3/webm/ogg
 * which uploads fine but plays SILENT. This converts such audio to m4a first.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const log = require("./logger");

const TMP = path.join(os.tmpdir(), "instabot-audio");
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_) { /* ignore */ }

const OK_EXT = new Set([".m4a", ".mp4", ".aac"]);
const MAX_BYTES = 4.5 * 1024 * 1024; // auth.js caps media at 5 MB (base64 grows it)

function ffmpegBin() {
	try { const p = require("ffmpeg-static"); if (p) return p; } catch (_) { /* use system */ }
	return "ffmpeg";
}

function rand() { return Math.random().toString(36).slice(2, 12); }

function isStream(v) { return v && typeof v === "object" && typeof v.pipe === "function" && typeof v.on === "function"; }

function drain(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", c => chunks.push(c));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.split("\n").slice(-3).join(" ").trim()}`)));
		setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) { /* ignore */ } }, 300000).unref();
	});
}

/**
 * @param source URL | path | Buffer | stream
 * @param hint   { ext, mimetype } from the caller (optional)
 * @returns the original source if it is already fine, else
 *          { buffer, filename, contentType } with AAC/m4a audio.
 */
async function toVoiceSource(source, hint = {}) {
	const mime = String(hint.mimetype || "").toLowerCase();
	let ext = String(hint.ext || "").toLowerCase();
	if (!ext && typeof source === "string") {
		try { ext = path.extname(/^https?:/i.test(source) ? new URL(source).pathname : source).toLowerCase(); } catch (_) { ext = ""; }
	}
	if (!ext && isStream(source) && source.path) ext = path.extname(String(source.path)).toLowerCase();

	if (OK_EXT.has(ext) || /audio\/(mp4|aac|x-m4a)/.test(mime)) return source;

	const input = path.join(TMP, `${rand()}${ext || ".bin"}`);
	const output = path.join(TMP, `${rand()}.m4a`);
	let ffIn = input;
	try {
		if (typeof source === "string" && /^https?:/i.test(source)) ffIn = source;
		else if (typeof source === "string") ffIn = source;
		else if (Buffer.isBuffer(source)) fs.writeFileSync(input, source);
		else if (isStream(source)) fs.writeFileSync(input, await drain(source));
		else return source;

		let bitrate = "96k";
		for (let attempt = 0; attempt < 2; attempt++) {
			await run(["-y", "-loglevel", "error", "-i", ffIn, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", output]);
			if (fs.statSync(output).size <= MAX_BYTES) break;
			bitrate = "48k";
		}
		const buffer = fs.readFileSync(output);
		log.info("AUDIO", `converted ${ext || "audio"} -> m4a (${Math.round(buffer.length / 1024)} KB)`);
		return { buffer, filename: "voice.m4a", contentType: "audio/mp4" };
	}
	finally {
		for (const f of [input, output]) fs.unlink(f, () => { });
	}
}

const VIDEO_MAX = 4.3 * 1024 * 1024; // raw bytes; base64 + JSON must stay under the server cap

function probeDuration(file) {
	return new Promise(resolve => {
		const child = spawn(ffmpegBin(), ["-i", file], { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", d => { err += d.toString(); });
		child.on("error", () => resolve(0));
		child.on("close", () => {
			const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
			resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
		});
	});
}

/**
 * Instagram bridge accepts ~5 MB of media per message. Shrink bigger videos
 * (re-encode to H.264/AAC sized for the clip's length) instead of failing.
 * Returns the original source when it already fits or cannot be inspected.
 */
async function toSendableVideo(source) {
	let file = null;
	const temp = [];
	if (typeof source === "string" && !/^https?:/i.test(source) && fs.existsSync(source)) file = source;
	else if (isStream(source) && source.path && fs.existsSync(String(source.path))) file = String(source.path);
	else if (Buffer.isBuffer(source)) {
		if (source.length <= VIDEO_MAX) return source;
		file = path.join(TMP, `${rand()}.mp4`); temp.push(file);
		fs.writeFileSync(file, source);
	}
	else return source;

	if (fs.statSync(file).size <= VIDEO_MAX) return source;

	const output = path.join(TMP, `${rand()}.mp4`); temp.push(output);
	try {
		const duration = await probeDuration(file);
		if (!duration) throw new Error("Video is too large to send (over 5 MB) and could not be compressed.");
		const audioBps = 64000;
		let videoBps = Math.floor((VIDEO_MAX * 8 * 0.9) / duration) - audioBps;
		if (videoBps < 90000) throw new Error(`Video is too long (${Math.round(duration)}s) to fit Instagram's 5 MB limit.`);
		for (let attempt = 0; attempt < 2; attempt++) {
			const height = videoBps < 250000 ? 240 : 360;
			await run(["-y", "-loglevel", "error", "-i", file, "-vf", `scale=-2:${height}`, "-c:v", "libx264", "-preset", "ultrafast",
				"-b:v", String(videoBps), "-maxrate", String(Math.floor(videoBps * 1.3)), "-bufsize", String(videoBps * 2),
				"-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ac", "2", "-movflags", "+faststart", output]);
			if (fs.statSync(output).size <= VIDEO_MAX) break;
			if (attempt === 1) throw new Error("Video is still over 5 MB after compression.");
			videoBps = Math.floor(videoBps * 0.6);
		}
		const buffer = fs.readFileSync(output);
		log.info("VIDEO", `compressed ${Math.round(fs.statSync(file).size / 1048576)} MB -> ${Math.round(buffer.length / 1024)} KB`);
		return { buffer, filename: "video.mp4", contentType: "video/mp4" };
	}
	finally {
		for (const f of temp) fs.unlink(f, () => { });
	}
}

module.exports = { toVoiceSource, toSendableVideo };
