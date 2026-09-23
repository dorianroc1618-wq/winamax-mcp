import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
	ODDSPAPI_API_KEY: string;
	PULSESCORE_API_KEY: string;
}

const ODDS_BASE = "https://api.oddspapi.io/v4";

async function oddsPapi(
	env: Env,
	endpoint: string,
	params: Record<string, string> = {},
) {
	const url = new URL(`${ODDS_BASE}/${endpoint}`);

	url.searchParams.set("apiKey", env.ODDSPAPI_API_KEY);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") {
			url.searchParams.set(key, value);
		}
	}

	const response = await fetch(url.toString());

	if (!response.ok) {
		const error = await response.text();
		throw new Error(
			`OddsPapi ${response.status}: ${error.slice(0, 500)}`
		);
	}

	return response.json();
}

function asText(data: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function createServer(env: Env) {
	const server = new McpServer({
		name: "Winamax Odds Scanner",
		version: "1.0.0",
	});

	// 1. Vérifie que OddsPapi fonctionne
	server.registerTool(
		"test_oddspapi",
		{
			description:
				"Teste la connexion à OddsPapi sans révéler la clé API.",
			inputSchema: z.object({}),
		},
		async () => {
			const data: any = await oddsPapi(env, "account");

			if (data && typeof data === "object") {
				delete data.apiKey;
				delete data.api_key;
			}

			return asText(data);
		},
	);

	// 2. Cherche les événements réellement disponibles chez Winamax
	server.registerTool(
		"search_winamax_events",
		{
			description:
				"Recherche les événements sportifs pré-match ayant des cotes disponibles chez Winamax France.",
			inputSchema: z.object({
				from: z.string().describe(
					"Date/heure ISO UTC de début, ex: 2026-09-23T08:00:00Z"
				),
				to: z.string().describe(
					"Date/heure ISO UTC de fin. Fenêtre inférieure à 48h."
				),
				sportId: z.number().optional().describe(
					"Identifiant OddsPapi du sport. Facultatif."
				),
			}),
		},
		async ({ from, to, sportId }) => {
			const params: Record<string, string> = {
				from,
				to,
				statusId: "0",
				hasOdds: "true",
				bookmakers: "winamax.fr",
				language: "en",
			};

			if (sportId !== undefined) {
				params.sportId = String(sportId);
			}

			const data = await oddsPapi(env, "fixtures", params);

			return asText(data);
		},
	);

	// 3. Récupère les cotes Winamax d'un événement
	server.registerTool(
		"get_winamax_odds",
		{
			description:
				"Récupère les marchés et cotes actuelles Winamax France d'un événement OddsPapi.",
			inputSchema: z.object({
				fixtureId: z.string(),
			}),
		},
		async ({ fixtureId }) => {
			const data = await oddsPapi(env, "odds", {
				fixtureId,
				bookmakers: "winamax.fr",
				oddsFormat: "decimal",
				language: "en",
				verbosity: "3",
			});

			return asText(data);
		},
	);

	// 4. Informations détaillées sur un événement
	server.registerTool(
		"get_fixture",
		{
			description:
				"Récupère les informations détaillées d'un événement sportif.",
			inputSchema: z.object({
				fixtureId: z.string(),
			}),
		},
		async ({ fixtureId }) => {
			const data = await oddsPapi(env, "fixture", {
				fixtureId,
				language: "en",
			});

			return asText(data);
		},
	);

	// 5. Historique Winamax + bookmakers de référence
	server.registerTool(
		"get_odds_history",
		{
			description:
				"Récupère l'historique des mouvements de cotes pour analyser line movement et RLM.",
			inputSchema: z.object({
				fixtureId: z.string(),
				bookmakers: z
					.string()
					.optional()
					.describe(
						"Maximum 3 bookmakers séparés par des virgules. Par défaut winamax.fr,pinnacle."
					),
			}),
		},
		async ({ fixtureId, bookmakers }) => {
			const data = await oddsPapi(env, "historical-odds", {
				fixtureId,
				bookmakers: bookmakers || "winamax.fr,pinnacle",
			});

			return asText(data);
		},
	);

	return server;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const handler = createMcpHandler(() => createServer(env));
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
