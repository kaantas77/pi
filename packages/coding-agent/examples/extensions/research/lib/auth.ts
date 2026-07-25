import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getExaApiKey(): string {
	const envKey = process.env.EXA_API_KEY;
	if (envKey?.trim()) return envKey.trim();

	const authPath = join(getAgentDir(), "auth.json");
	try {
		if (existsSync(authPath)) {
			const auth = JSON.parse(readFileSync(authPath, "utf-8")) as {
				exa?: { key?: string };
			};
			const key = auth.exa?.key;
			if (key?.trim()) return key.trim();
		}
	} catch {
		// fall through
	}

	throw new Error('Exa API key not found. Set EXA_API_KEY or add {"exa":{"key":"..."}} to ~/.pi/agent/auth.json');
}
