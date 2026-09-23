import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import {
  OddsClient,
  Scanner,
  ProviderError,
  fixtureView,
  type Env,
} from "./odds";

// ============================================================
// COMMON PARAMETERS
// ============================================================

const common = {
  minOdds: z
    .number()
    .gt(1)
    .default(1.4)
    .describe(
      "Cote Winamax minimum, incluse.",
    ),

  maxOdds: z
    .number()
    .gt(1)
    .default(2)
    .describe(
      "Cote Winamax maximum, incluse.",
    ),

  includeInactive: z
    .boolean()
    .default(false)
    .describe(
      "Inclure les cotes suspendues/inactives, explicitement signalées.",
    ),

  marketName: z
    .string()
    .max(150)
    .optional()
    .describe(
      "Filtre textuel sur le nom du marché.",
    ),

  selectionName: z
    .string()
    .max(150)
    .optional()
    .describe(
      "Filtre textuel sur la sélection/joueur/équipe.",
    ),

  bookmakers: z
    .string()
    .max(500)
    .regex(
      /^(all|[a-zA-Z0-9._-]+(?:,[a-zA-Z0-9._-]+)*)$/,
    )
    .optional()
    .describe(
      "Comparaison: tous disponibles par défaut; ou liste séparée par virgules. Winamax et Pinnacle toujours demandés. Historique: Winamax/Pinnacle par défaut; all pour tous.",
    ),

  language: z
    .enum(["en", "fr"])
    .default("en"),

  timezone: z
    .string()
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat(
            "fr",
            {
              timeZone: value,
            },
          );

          return true;
        } catch {
          return false;
        }
      },
      "Fuseau IANA invalide",
    )
    .default("Europe/Paris"),

  includeHistory: z
    .boolean()
    .default(false)
    .describe(
      "Ajouter ouverture enregistrée → cote actuelle. Plus lent et consomme davantage de requêtes.",
    ),

  offset: z
    .number()
    .int()
    .min(0)
    .default(0),
};

// ============================================================
// MCP RESPONSE
// ============================================================

function reply(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data),
      },
    ],
  };
}

// ============================================================
// ERROR HANDLING
// ============================================================

async function safely(
  fn: () => Promise<unknown>,
) {
  try {
    const data = await fn();

    return reply(data);
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      ...reply({
        error: message,
        retrievedAt:
          new Date().toISOString(),
      }),

      isError: true,
    };
  }
}

// ============================================================
// CREATE MCP SERVER
// ============================================================

export function createServer(
  env: Env,
) {
  // Deliberately create a fresh client for the MCP server.
  // No global WeakMap/cache around the environment.
  const client =
    new OddsClient(env);

  const scanner =
    new Scanner(client);

  const server =
    new McpServer({
      name:
        "Winamax Odds Scanner",

      version:
        "2.0.1",
    });

  // ==========================================================
  // TEST ODDSPAPI
  // ==========================================================

  server.registerTool(
    "test_oddspapi",

    {
      description:
        "Teste directement la connexion à OddsPapi sans retourner de secret ni de données personnelles du compte.",

      inputSchema:
        z.object({}),
    },

    async () =>
      safely(async () => {
        const data =
          await client.get(
            "account",
          );

        return {
          connected: true,

          retrievedAt:
            new Date().toISOString(),

          subscriptions:
            (
              data.subscriptions ??
              []
            ).map(
              (subscription: any) => ({
                active:
                  subscription.is_active,

                plan:
                  subscription.plan,

                requestCount:
                  subscription.request_count,

                requestLimit:
                  subscription.request_limit,

                winamaxAvailable:
                  !!subscription
                    .bookmakers?.[
                    "winamax.fr"
                  ],

                pinnacleAvailable:
                  !!subscription
                    .bookmakers
                    ?.pinnacle,
              }),
            ),
        };
      }),
  );

  // ==========================================================
  // SEARCH WINAMAX EVENTS
  // ==========================================================

  server.registerTool(
    "search_winamax_events",

    {
      description:
        "Catalogue réel Winamax pré-match avec sport, pays/catégorie, compétition, participants et heures UTC/locales. includeMarkets=true ajoute les sélections libellées, filtrées selon minOdds/maxOdds, ainsi que les comparaisons. Pagination explicite avec nextOffset.",

      inputSchema:
        z.object({
          ...common,

          from:
            z.iso.datetime({
              offset: true,
            }),

          to:
            z.iso.datetime({
              offset: true,
            }),

          sportId:
            z
              .number()
              .int()
              .optional(),

          sportName:
            z
              .string()
              .optional(),

          includeMarkets:
            z
              .boolean()
              .default(false),

          limit:
            z
              .number()
              .int()
              .min(1)
              .max(20)
              .default(20),
        }),
    },

    async (args) =>
      safely(() =>
        scanner.search(args),
      ),
  );

  // ==========================================================
  // GET WINAMAX ODDS
  // ==========================================================

  server.registerTool(
    "get_winamax_odds",

    {
      description:
        "Sélections Winamax lisibles et actives entre minOdds et maxOdds, avec libellés OddsPapi, lignes, timestamps et comparaison exacte avec Pinnacle/autres bookmakers. includeHistory ajoute les mouvements. Suivre nextOffset.",

      inputSchema:
        z.object({
          ...common,

          fixtureId:
            z
              .string()
              .min(1),

          limit:
            z
              .number()
              .int()
              .min(1)
              .max(500)
              .default(100),
        }),
    },

    async ({
      fixtureId,
      ...options
    }) =>
      safely(() =>
        scanner.odds(
          fixtureId,
          options,
        ),
      ),
  );

  // ==========================================================
  // GET FIXTURE
  // ==========================================================

  server.registerTool(
    "get_fixture",

    {
      description:
        "Détails lisibles d'un événement OddsPapi, horaires et statut pré-match.",

      inputSchema:
        z.object({
          fixtureId:
            z
              .string()
              .min(1),

          language:
            common.language,

          timezone:
            common.timezone,
        }),
    },

    async ({
      fixtureId,
      language,
      timezone,
    }) =>
      safely(async () => {
        const fixture =
          await client.get(
            "fixture",
            {
              fixtureId,
              language,
            },
          );

        return {
          retrievedAt:
            new Date().toISOString(),

          fixture:
            fixtureView(
              fixture,
              timezone,
            ),
        };
      }),
  );

  // ==========================================================
  // GET ODDS HISTORY
  // ==========================================================

  server.registerTool(
    "get_odds_history",

    {
      description:
        "Historique libellé des sélections Winamax: première cote active enregistrée → actuelle, derniers points, variation et comparaisons. RLM non déterminable sans répartition des mises.",

      inputSchema:
        z.object({
          ...common,

          fixtureId:
            z
              .string()
              .min(1),

          includePoints:
            z
              .boolean()
              .default(false),

          limit:
            z
              .number()
              .int()
              .min(1)
              .max(500)
              .default(100),
        }),
    },

    async ({
      fixtureId,
      ...options
    }) =>
      safely(() =>
        scanner.odds(
          fixtureId,
          {
            ...options,
            includeHistory:
              true,
          },
        ),
      ),
  );

  return server;
}

// ============================================================
// CLOUDFLARE WORKER
// ============================================================

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const handler =
      createMcpHandler(
        () =>
          createServer(env),
      );

    return handler(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
