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
			`OddsPapi ${response.status}: ${error.slice(0, 500)}`,
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

	/*
	 * TEST ODDS PAPI
	 */
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

	/*
	 * RECHERCHE DES EVENEMENTS WINAMAX
	 */
	server.registerTool(
		"search_winamax_events",
		{
			description:
				"Recherche les événements sportifs pré-match disposant de cotes chez Winamax France.",

			inputSchema: z.object({
				from: z
					.string()
					.describe(
						"Date/heure ISO UTC de début, par exemple 2026-09-23T08:00:00Z",
					),

				to: z
					.string()
					.describe(
						"Date/heure ISO UTC de fin. Utiliser une fenêtre inférieure à 48 heures.",
					),

				sportId: z
					.number()
					.optional()
					.describe(
						"Identifiant OddsPapi du sport. Facultatif.",
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

			const data = await oddsPapi(
				env,
				"fixtures",
				params,
			);

			return asText(data);
		},
	);

	/*
	 * COTES WINAMAX
	 */
	server.registerTool(
		"get_winamax_odds",
		{
			description:
				"Récupère les marchés et les cotes actuelles Winamax France pour un événement OddsPapi.",

			inputSchema: z.object({
				fixtureId: z
					.string()
					.describe(
						"Identifiant OddsPapi de l'événement.",
					),
			}),
		},
		async ({ fixtureId }) => {
			const data = await oddsPapi(
				env,
				"odds",
				{
					fixtureId,
					bookmakers: "winamax.fr",
					oddsFormat: "decimal",
					language: "en",
					verbosity: "3",
				},
			);

			return asText(data);
		},
	);

	/*
	 * DETAILS D'UN EVENEMENT
	 */
	server.registerTool(
		"get_fixture",
		{
			description:
				"Récupère les informations détaillées concernant un événement sportif OddsPapi.",

			inputSchema: z.object({
				fixtureId: z
					.string()
					.describe(
						"Identifiant OddsPapi de l'événement.",
					),
			}),
		},
		async ({ fixtureId }) => {
			const data = await oddsPapi(
				env,
				"fixture",
				{
					fixtureId,
					language: "en",
				},
			);

			return asText(data);
		},
	);

	/*
	 * HISTORIQUE DES COTES / RLM
	 */
	server.registerTool(
		"get_odds_history",
		{
			description:
				"Récupère l'historique des mouvements de cotes afin d'analyser le line movement et les éventuels signaux RLM.",

			inputSchema: z.object({
				fixtureId: z
					.string()
					.describe(
						"Identifiant OddsPapi de l'événement.",
					),

				bookmakers: z
					.string()
					.optional()
					.describe(
						"Bookmakers à comparer. Par défaut : winamax.fr,pinnacle.",
					),
			}),
		},
		async ({ fixtureId, bookmakers }) => {
			const data = await oddsPapi(
				env,
				"historical-odds",
				{
					fixtureId,
					bookmakers:
						bookmakers ||
						"winamax.fr,pinnacle",
				},
			);

			return asText(data);
		},
	);

	return server;
}

/*
 * CLOUDFLARE MCP HANDLER
 */
export default {
	fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	) {
		const handler = createMcpHandler(
			() => createServer(env),
		);

		return handler(
			request,
			env,
			ctx,
		);
	},
} satisfies ExportedHandler<Env>;

// Trigger Cloudflare deployment
