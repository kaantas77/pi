import { getExaApiKey } from "./auth.ts";

export interface ExaSearchResult {
	title?: string;
	url: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
}

export interface ExaSearchResponse {
	results: ExaSearchResult[];
	requestId: string;
	autopromptString?: string;
}

export interface ExaSearchOptions {
	numResults?: number;
	type?: "keyword" | "neural" | "auto";
	includeText?: boolean;
	useAutoprompt?: boolean;
	startPublishedDate?: string;
	endPublishedDate?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
	signal?: AbortSignal;
}

export async function exaSearch(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResponse> {
	const apiKey = getExaApiKey();

	const body: Record<string, unknown> = {
		query,
		numResults: Math.min(Math.max(options.numResults ?? 10, 1), 50),
		type: options.type ?? "auto",
		useAutoprompt: options.useAutoprompt ?? true,
	};

	if (options.includeText) {
		body.contents = { text: { maxCharacters: 4000 } };
	}
	if (options.startPublishedDate) body.startPublishedDate = options.startPublishedDate;
	if (options.endPublishedDate) body.endPublishedDate = options.endPublishedDate;
	if (options.includeDomains && options.includeDomains.length > 0) {
		body.includeDomains = options.includeDomains;
	}
	if (options.excludeDomains && options.excludeDomains.length > 0) {
		body.excludeDomains = options.excludeDomains;
	}

	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!response.ok) {
		const errBody = await response.text().catch(() => "unknown error");
		throw new Error(`Exa search failed (${response.status}): ${errBody}`);
	}

	return response.json() as Promise<ExaSearchResponse>;
}

export interface ExaContentResult {
	id: string;
	url: string;
	title?: string;
	text?: string;
	publishedDate?: string;
}

export interface ExaContentsResponse {
	results: ExaContentResult[];
}

export async function exaContents(
	urls: string[],
	options: { maxCharacters?: number; signal?: AbortSignal } = {},
): Promise<ExaContentsResponse> {
	const apiKey = getExaApiKey();
	const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
	if (unique.length === 0) {
		return { results: [] };
	}

	const response = await fetch("https://api.exa.ai/contents", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify({
			urls: unique,
			text: { maxCharacters: options.maxCharacters ?? 12000 },
		}),
		signal: options.signal,
	});

	if (!response.ok) {
		const errBody = await response.text().catch(() => "unknown error");
		throw new Error(`Exa contents failed (${response.status}): ${errBody}`);
	}

	return response.json() as Promise<ExaContentsResponse>;
}
