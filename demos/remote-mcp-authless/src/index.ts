import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import {
  Env,
  OddsClient,
  Scanner,
  ProviderError,
} from "./odds";

// ============================================================
// HELPERS
// ============================================================

function jsonText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function safely(
  action: () => Promise<unknown>,
) {
  try {
    const result = await action();

    return jsonText(result);
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: message,
        },
      ],
    };
  }
}

// ============================================================
// CREATE MCP SERVER
// ============================================================

function createServer(env: Env) {
  const server = new McpServer({
    name: "Winamax MCP",
    version: "2.0.2",
  });

  const client = new OddsClient(env);
  const scanner = new Scanner(client);

  // ==========================================================
  // TOOL 1 — TEST ODDSPAPI
  // ==========================================================

  server.tool(
    "test_oddspapi",
    "Teste la connexion entre le Worker Cloudflare et OddsPapi.",
    {},
    async () =>
      safely(async () => {
        const account =
          await client.get("account");

        return {
          success: true,
          provider: "OddsPapi",
          message:
            "Connexion OddsPapi réussie.",
          account,
        };
      }),
  );

  // ==========================================================
  // TOOL 2 — SEARCH WINAMAX EVENTS
  // ==========================================================

  server.tool(
    "search_winamax_events",
    "Recherche les événements prématch réellement présents chez Winamax France.",
    {
      from: z
        .string()
        .describe(
          "Date ISO de début avec fuseau.",
        ),

      to: z
        .string()
        .describe(
          "Date ISO de fin avec fuseau. Fenêtre inférieure à 48 heures.",
        ),

      sportId: z
        .number()
        .optional(),

      sportName: z
        .string()
        .optional(),

      includeMarkets: z
        .boolean()
        .optional(),

      minOdds: z
        .number()
        .optional(),

      maxOdds: z
        .number()
        .optional(),

      includeInactive: z
        .boolean()
        .optional(),

      marketName: z
        .string()
        .optional(),

      selectionName: z
        .string()
        .optional(),

      bookmakers: z
        .string()
        .optional(),

      language: z
        .string()
        .optional(),

      timezone: z
        .string()
        .optional(),

      includeHistory: z
        .boolean()
        .optional(),

      includePoints: z
        .boolean()
        .optional(),

      offset: z
        .number()
        .int()
        .min(0)
        .optional(),

      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional(),
    },
    async (args) =>
      safely(() =>
        scanner.search(args),
      ),
  );

  // ==========================================================
  // TOOL 3 — GET WINAMAX ODDS
  // ==========================================================

  server.tool(
    "get_winamax_odds",
    "Récupère et normalise les marchés et cotes Winamax d'un événement.",
    {
      fixtureId: z.string(),

      minOdds: z
        .number()
        .optional(),

      maxOdds: z
        .number()
        .optional(),

      includeInactive: z
        .boolean()
        .optional(),

      marketName: z
        .string()
        .optional(),

      selectionName: z
        .string()
        .optional(),

      bookmakers: z
        .string()
        .optional(),

      language: z
        .string()
        .optional(),

      timezone: z
        .string()
        .optional(),

      includeHistory: z
        .boolean()
        .optional(),

      includePoints: z
        .boolean()
        .optional(),

      offset: z
        .number()
        .int()
        .min(0)
        .optional(),

      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional(),
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
  // TOOL 4 — GET FIXTURE
  // ==========================================================

  server.tool(
    "get_fixture",
    "Récupère les informations brutes d'un événement OddsPapi.",
    {
      fixtureId: z.string(),

      language: z
        .string()
        .optional(),
    },
    async ({
      fixtureId,
      language,
    }) =>
      safely(() =>
        client.get(
          "fixtures",
          {
            fixtureId,
            language:
              language ?? "en",
          },
        ),
      ),
  );

  // ==========================================================
  // TOOL 5 — GET ODDS HISTORY
  // ==========================================================

  server.tool(
    "get_odds_history",
    "Récupère l'historique des cotes OddsPapi pour un événement.",
    {
      fixtureId: z.string(),

      bookmakers: z
        .string()
        .optional(),
    },
    async ({
      fixtureId,
      bookmakers,
    }) =>
      safely(() =>
        client.get(
          "historical-odds",
          {
            fixtureId,
            bookmakers:
              bookmakers ??
              "winamax.fr,pinnacle",
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
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(
      request.url,
    );

    // ========================================================
    // TEMPORARY DIRECT ODDSPAPI TEST
    //
    // This bypasses:
    // - MCP
    // - OddsClient
    // - Scanner
    //
    // It tests only:
    // Cloudflare Worker -> native fetch -> OddsPapi
    // ========================================================

    if (
      url.pathname ===
      "/debug-oddspapi"
    ) {
      if (
        !env.ODDSPAPI_API_KEY
      ) {
        return Response.json(
          {
            test:
              "direct-fetch",

            success:
              false,

            error:
              "ODDSPAPI_API_KEY absent du Worker.",
          },
          {
            status: 500,
          },
        );
      }

      try {
        const apiUrl =
          new URL(
            "https://api.oddspapi.io/v4/account",
          );

        apiUrl.searchParams.set(
          "apiKey",
          env.ODDSPAPI_API_KEY,
        );

        // Native Cloudflare fetch.
        // No OddsClient and no detached fetch function.
        const response =
          await fetch(
            apiUrl.toString(),
          );

        return Response.json({
          test:
            "direct-fetch",

          success:
            response.ok,

          fetchWorked:
            true,

          status:
            response.status,

          ok:
            response.ok,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        return Response.json(
          {
            test:
              "direct-fetch",

            success:
              false,

            fetchWorked:
              false,

            error:
              message,
          },
          {
            status: 500,
          },
        );
      }
    }

    // ========================================================
    // NORMAL MCP ENDPOINT
    // ========================================================

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
