import { stripVTControlCharacters } from "node:util";

const DURATION_TOKEN = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;

export function normalizeLog(log, { temporaryRoot } = {}) {
	if (typeof log !== "string") throw new TypeError("log must be a string");
	if (typeof temporaryRoot !== "string" || temporaryRoot.length === 0) {
		throw new TypeError("temporaryRoot must be a non-empty string");
	}

	return stripVTControlCharacters(log)
		.split(temporaryRoot)
		.join("<workspace>")
		.replace(DURATION_TOKEN, "<time>");
}
