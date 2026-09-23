import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { OddsClient, Scanner, ProviderError, fixtureView, type Env } from "./odds";

const clients = new WeakMap<object, OddsClient>();

function clientFor(env: Env) {
  let client = clients.get(env);
  if (!client) {
    client = new OddsClient(env);
    clients.set(env, client);
  }
  return client;
}

const common = {
  minOdds: z.number().gt(1).default(1.4).describe("Cote Winamax minimum, incluse."),
  maxOdds: z.number().gt(1).default(2).describe("Cote Winamax maximum, incluse."),

  includeInactive: z
    .boolean()
    .default(false)
    .describe("Inclure les cotes suspendues/inactives, explicitement signalées."),

  marketName: z
    .string()
    .max(150)
    .optional()
    .describe("Filtre textuel sur le nom du marché."),

  selectionName: z
    .string()
    .max(150)
    .optional()
    .describe("Filtre textuel sur la sélection/joueur/équipe."),

  bookmakers: z
    .string()
    .max(500)
    .regex(/^(all|[a-zA-Z0-9._-]+(?:,[a-zA-Z0-9._-]+)*)$/)
    .optional()
    .describe(
      "Comparaison: tous disponibles par défaut; ou liste séparée par virgules. Winamax et Pinnacle toujours demandés. Historique: Winamax/Pinnacle par défaut; all pour tous.",
    ),

  language: z.enum(["en", "fr"]).default("en"),

  timezone: z
    .string()
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("fr", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Fuseau IANA invalide")
    .default("Europe/Paris"),

  includeHistory: z
    .boolean()
    .default(false)
    .describe(
      "Ajouter ouverture enregistrée → cote actuelle. Plus lent et consomme davantage de requêtes.",
    ),

  offset: z.number().int().min(0).default(0),
};

function reply(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

async function safely(fn: () => Promise<unknown>) {
  try {
    return reply(await fn());
  } catch (e) {
    return {
      ...reply({
        error:
          e instanceof ProviderError
            ? e.message
            : "Impossible de traiter la réponse du fournisseur.",
        retrievedAt: new Date().toISOString(),
      }),
      isError: true,
    };
  }
}

export function createServer(env: Env) {
  const client = clientFor(env);
  const scanner = new Scanner(client);

  const server = new McpServer({
    name: "Winamax Odds Scanner",
    version: "2.0.0",
  });

  server.registerTool(
    "test_oddspapi",
    {
      description:
        "Teste la connexion sans retourner de secret ni de données personnelles du compte.",
      inputSchema: z.object({}),
    },
    async () =>
      safely(async () => {
        const data = await client.get("account");

        return {
          connected: true,
          retrievedAt: new Date().toISOString(),
          subscriptions: (data.subscriptions ?? []).map((s: any) => ({
            active: s.is_active,
            plan: s.plan,
            requestCount: s.request_count,
            requestLimit: s.request_limit,
            winamaxAvailable: !!s.bookmakers?.["winamax.fr"],
            pinnacleAvailable: !!s.bookmakers?.pinnacle,
          })),
        };
      }),
  );

  server.registerTool(
    "search_winamax_events",
    {
      description:
        "Catalogue réel Winamax pré-match avec sport, pays/catégorie, compétition, participants et heures UTC/locales. includeMarkets=true ajoute sélections libellées, filtrées 1,40–2,00, et comparaisons. Pagination explicite; suivre nextOffset.",

      inputSchema: z.object({
        ...common,
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
        sportId: z.number().int().optional(),
        sportName: z.string().optional(),
        includeMarkets: z.boolean().default(false),
        limit: z.number().int().min(1).max(20).default(20),
      }),
    },
    async (args) => safely(() => scanner.search(args)),
  );

  server.registerTool(
    "get_winamax_odds",
    {
      description:
        "Sélections Winamax lisibles et actives entre minOdds=1.40 et maxOdds=2.00, libellés OddsPapi, lignes, timestamps et comparaison exacte avec Pinnacle/autres bookmakers. includeHistory ajoute les mouvements. Suivre nextOffset.",

      inputSchema: z.object({
        ...common,
        fixtureId: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ fixtureId, ...options }) =>
      safely(() => scanner.odds(fixtureId, options)),
  );

  server.registerTool(
    "get_fixture",
    {
      description:
        "Détails lisibles d'un événement OddsPapi, horaires et statut pré-match.",

      inputSchema: z.object({
        fixtureId: z.string().min(1),
        language: common.language,
        timezone: common.timezone,
      }),
    },
    async ({ fixtureId, language, timezone }) =>
      safely(async () => ({
        retrievedAt: new Date().toISOString(),
        fixture: fixtureView(
          await client.get("fixture", { fixtureId, language }),
          timezone,
        ),
      })),
  );

  server.registerTool(
    "get_odds_history",
    {
      description:
        "Historique libellé des sélections Winamax: première cote active enregistrée → actuelle, derniers points, variation et comparaisons. Filtre Winamax 1,40–2,00 par défaut. RLM non déterminable sans répartition des mises. Historique Winamax/Pinnacle par défaut, bookmakers=all pour tous (plus lent).",

      inputSchema: z.object({
        ...common,
        fixtureId: z.string().min(1),
        includePoints: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ fixtureId, ...options }) =>
      safely(() =>
        scanner.odds(fixtureId, {
          ...options,
          includeHistory: true,
        }),
      ),
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env))(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
