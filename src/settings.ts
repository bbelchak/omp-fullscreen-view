import * as fs from "node:fs";
import * as path from "node:path";

/** Persisted next to the extension (gitignored), shared by every session. */
const FILE = path.join(import.meta.dir, "..", "settings.json");

export interface ViewSettings {
	rail: boolean;
}

const DEFAULTS: ViewSettings = { rail: true };

export function loadSettings(): ViewSettings {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
	} catch {
		return { ...DEFAULTS };
	}
	const rail = raw && typeof raw === "object" && "rail" in raw ? raw.rail : undefined;
	return { rail: typeof rail === "boolean" ? rail : DEFAULTS.rail };
}

export function saveSettings(settings: ViewSettings): void {
	fs.writeFileSync(FILE, `${JSON.stringify(settings, null, "\t")}\n`);
}
