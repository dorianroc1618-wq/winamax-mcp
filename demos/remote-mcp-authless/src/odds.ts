// OddsPapi v4 normalized catalogue. Never infer a market label from its ID.
export interface Env {
  ODDSPAPI_API_KEY: string;
  PULSESCORE_API_KEY: string;
}
type Dict = Record<string, any>;
export interface Options {
  minOdds?: number;
  maxOdds?: number;
  includeInactive?: boolean;
  marketName?: string;
  selectionName?: string;
  bookmakers?: string;
  language?: string;
  timezone?: string;
  includeHistory?: boolean;
  includePoints?: boolean;
  offset?: number;
  limit?: number;
}
const BASE = "https://api.oddspapi.io/v4";
const WINAMAX = "winamax.fr";
const cooldown: Record<string, number> = {
  odds: 550,
  fixtures: 2050,
  "historical-odds": 5050,
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class ProviderError extends Error {}

export class OddsClient {
  private queues = new Map<string, Promise<unknown>>();
  private next = new Map<string, number>();
  private metadata = new Map<string, { expires: number; value: Promise<any> }>();
  constructor(
    private env: Env,
    private request: typeof fetch = fetch,
  ) {}

  async get(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    if (!this.env.ODDSPAPI_API_KEY) throw new ProviderError("Secret OddsPapi absent.");
    const previous = this.queues.get(endpoint) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(Math.max(0, (this.next.get(endpoint) ?? 0) - Date.now()));
          const url = new URL(`${BASE}/${endpoint}`);
          url.searchParams.set("apiKey", this.env.ODDSPAPI_API_KEY);
          for (const [key, value] of Object.entries(params))
            if (value) url.searchParams.set(key, value);
          let response: Response;
          try {
            response = await this.request(url, { signal: AbortSignal.timeout(25000) });
          } catch {
            throw new ProviderError(
              `OddsPapi ${endpoint}: connexion indisponible ou délai dépassé.`,
            );
          }
          this.next.set(endpoint, Date.now() + (cooldown[endpoint] ?? 1050));
          if (response.status === 429 && attempt < 2) {
            const data: any = await response.json().catch(() => ({}));
            const retryMs = Number(data?.error?.retryMs);
            const header = Number(response.headers.get("Retry-After"));
            const delay =
              Number.isFinite(retryMs) && retryMs > 0 ? retryMs : header > 0 ? header * 1000 : 5050;
            if (delay > 30000)
              throw new ProviderError("OddsPapi: limite de requêtes, réessayer plus tard.");
            this.next.set(endpoint, Date.now() + delay + 100);
            continue;
          }
          // Do not return upstream error bodies/URLs: they can contain credentials.
          if (!response.ok)
            throw new ProviderError(`OddsPapi ${endpoint}: HTTP ${response.status}.`);
          try {
            return await response.json();
          } catch {
            throw new ProviderError(`OddsPapi ${endpoint}: réponse JSON invalide.`);
          }
        }
      });
    this.queues.set(endpoint, pending);
    return pending;
  }

  async markets(language = "en"): Promise<Map<string, Dict>> {
    const key = `markets:${language}`;
    let cached = this.metadata.get(key);
    if (!cached || cached.expires < Date.now()) {
      const value = this.get("markets", { language }).then((rows) => {
        if (!Array.isArray(rows)) throw new ProviderError("Catalogue des marchés invalide.");
        return new Map(rows.map((row: Dict) => [String(row.marketId), row]));
      });
      cached = { value, expires: Date.now() + 6 * 3600000 };
      this.metadata.set(key, cached);
      value.catch(() => {
        if (this.metadata.get(key)?.value === value) this.metadata.delete(key);
      });
    }
    return cached.value;
  }
}

let countryNames: Set<string> | undefined;
function countryFromCategory(f: Dict): string | null {
  if (f.countryName) return f.countryName;
  if (!countryNames) {
    countryNames = new Set([
      "england",
      "scotland",
      "wales",
      "northern ireland",
      "usa",
      "uk",
      "angleterre",
      "écosse",
      "pays de galles",
      "irlande du nord",
    ]);
    for (const language of ["en", "fr"]) {
      const names = new Intl.DisplayNames([language], { type: "region", fallback: "none" });
      for (let a = 65; a <= 90; a++)
        for (let b = 65; b <= 90; b++) {
          const name = names.of(String.fromCharCode(a, b));
          if (name) countryNames.add(name.toLowerCase());
        }
    }
  }
  return countryNames.has(f.categoryName?.toLowerCase()) ? f.categoryName : null;
}
export function fixtureView(f: Dict, timezone = "Europe/Paris") {
  const date = new Date(f.startTime);
  const local = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("fr-FR", {
        timeZone: timezone,
        dateStyle: "short",
        timeStyle: "long",
      }).format(date)
    : null;
  return {
    fixtureId: f.fixtureId,
    sportId: f.sportId,
    sport: f.sportName ?? null,
    // categoryName can be "International" or a tour, not necessarily a country.
    country: countryFromCategory(f),
    countryOrCategory: f.countryName ?? f.categoryName ?? null,
    category: f.categoryName ?? null,
    competition: f.tournamentName ?? null,
    tournamentId: f.tournamentId,
    participants: [f.participant1Name ?? null, f.participant2Name ?? null],
    startTime: f.startTime ?? null,
    startTimeLocal: local,
    timezone,
    status: f.statusName ?? null,
    statusId: f.statusId,
    prematch: f.statusId === 0 && !f.trueStartTime && date.getTime() > Date.now(),
    updatedAt: f.updatedAt ?? null,
  };
}

function quote(book: Dict | undefined, marketId: string, outcomeId: string, playerId: string) {
  const market = book?.markets?.[marketId];
  const p = market?.outcomes?.[outcomeId]?.players?.[playerId];
  if (!p || typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 1) return null;
  return {
    price: p.price,
    timestamp: p.changedAt ?? null,
    bookmakerTimestamp: p.bookmakerChangedAt ?? null,
    bookmakerActive: book?.bookmakerIsActive === true,
    suspended: book?.suspended !== false,
    marketActive: market.marketActive === true,
    selectionActive: p.active === true,
    available:
      book?.bookmakerIsActive === true &&
      book?.suspended === false &&
      market.marketActive === true &&
      p.active === true,
    mainLine: p.mainLine ?? null,
    playerName: p.playerName ?? null,
  };
}

export function historyView(
  points: Dict[] | undefined,
  current: ReturnType<typeof quote>,
  includePoints = false,
) {
  const sorted = (points ?? [])
    .filter(
      (p) =>
        Number.isFinite(Date.parse(p.createdAt)) &&
        typeof p.price === "number" &&
        Number.isFinite(p.price) &&
        p.price > 1,
    )
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const opening = sorted.find((p) => p.active === true);
  const last = sorted[sorted.length - 1];
  const first = opening
    ? { price: opening.price, timestamp: opening.createdAt, active: opening.active }
    : null;
  const latest = last
    ? { price: last.price, timestamp: last.createdAt, active: last.active }
    : null;
  const delta = first && current?.available ? current.price - first.price : null;
  return {
    opening: first,
    openingDefinition: "first_recorded_active_quote_not_guaranteed_bookmaker_opening",
    latestRecorded: latest,
    current,
    priceChange: delta,
    priceChangePercent: delta !== null && first ? (100 * delta) / first.price : null,
    impliedProbabilityChangePoints:
      first && current?.available ? 100 * (1 / current.price - 1 / first.price) : null,
    direction:
      delta === null ? "unavailable" : delta > 0 ? "drift" : delta < 0 ? "shortening" : "stable",
    pointCount: sorted.length,
    ...(includePoints
      ? {
          points: sorted.map((p) => ({ price: p.price, timestamp: p.createdAt, active: p.active })),
        }
      : {}),
  };
}

function selectionLabel(name: string | undefined, f: Dict, playerName: string | null) {
  if (!name) return null;
  const participant = name === "1" ? f.participant1Name : name === "2" ? f.participant2Name : null;
  return [playerName, participant ?? name].filter(Boolean).join(" — ");
}

export function normalizeOdds(
  f: Dict,
  metadata: Map<string, Dict>,
  options: Options = {},
  history?: Dict,
) {
  const min = options.minOdds ?? 1.4,
    max = options.maxOdds ?? 2;
  if (min > max) throw new ProviderError("minOdds doit être inférieur ou égal à maxOdds.");
  const books = f.bookmakerOdds ?? {};
  const rows: Dict[] = [];
  let unresolved = 0;
  const warnings: string[] = [];
  for (const [marketId, market] of Object.entries(books[WINAMAX]?.markets ?? {}) as [
    string,
    Dict,
  ][]) {
    const meta = metadata.get(marketId);
    for (const [outcomeId, outcome] of Object.entries(market.outcomes ?? {}) as [string, Dict][]) {
      const outcomeMeta = meta?.outcomes?.find((o: Dict) => String(o.outcomeId) === outcomeId);
      for (const playerId of Object.keys(outcome.players ?? {})) {
        const winamax = quote(books[WINAMAX], marketId, outcomeId, playerId);
        if (
          !winamax ||
          winamax.price < min ||
          winamax.price > max ||
          (!options.includeInactive && !winamax.available)
        )
          continue;
        const resolved =
          !!meta?.marketName &&
          !!outcomeMeta?.outcomeName &&
          String(meta.sportId) === String(f.sportId) &&
          (playerId === "0" || !!winamax.playerName);
        if (!resolved) {
          unresolved++;
          continue;
        }
        const selection = selectionLabel(outcomeMeta.outcomeName, f, winamax.playerName);
        if (
          options.marketName &&
          !meta!.marketName.toLowerCase().includes(options.marketName.toLowerCase())
        )
          continue;
        if (
          options.selectionName &&
          !selection?.toLowerCase().includes(options.selectionName.toLowerCase())
        )
          continue;
        const comparisons = Object.entries(books)
          .filter(([b]) => b !== WINAMAX)
          .flatMap(([bookmaker, book]) => {
            const q = quote(book as Dict, marketId, outcomeId, playerId);
            return q
              ? [
                  {
                    bookmaker,
                    ...q,
                    winamaxPriceDifference:
                      winamax.available && q.available ? winamax.price - q.price : null,
                    winamaxPriceAdvantagePercent:
                      winamax.available && q.available ? 100 * (winamax.price / q.price - 1) : null,
                  },
                ]
              : [];
          });
        const historyBooks = history
          ? [...new Set([WINAMAX, ...Object.keys(history.bookmakers ?? {})])]
          : [];
        const movements = historyBooks.map((bookmaker) => ({
          bookmaker,
          ...historyView(
            history?.bookmakers?.[bookmaker]?.markets?.[marketId]?.outcomes?.[outcomeId]?.players?.[
              playerId
            ],
            quote(books[bookmaker], marketId, outcomeId, playerId),
            options.includePoints,
          ),
        }));
        rows.push({
          marketId,
          outcomeId,
          playerId,
          market: meta!.marketName,
          outcome: outcomeMeta.outcomeName,
          selection,
          line: meta!.handicap ?? null,
          period: meta!.period ?? null,
          marketType: meta!.marketType ?? null,
          labelSource:
            "OddsPapi /v4/markets (normalized provider labels, not guaranteed Winamax wording)",
          winamax,
          comparisons,
          ...(history ? { movement: movements } : {}),
        });
      }
    }
  }
  if (unresolved)
    warnings.push(
      `${unresolved} sélection(s) exclue(s): métadonnées manquantes. Aucun libellé inventé.`,
    );
  if (!books[WINAMAX]) warnings.push("Aucune cote Winamax retournée pour cet événement.");
  const offset = options.offset ?? 0,
    limit = options.limit ?? 100;
  return {
    schemaVersion: "2.0",
    retrievedAt: new Date().toISOString(),
    fixture: fixtureView(f, options.timezone),
    filters: { minOdds: min, maxOdds: max, includeInactive: options.includeInactive ?? false },
    availableBookmakers: Object.keys(books),
    totalSelections: rows.length,
    offset,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    selections: rows.slice(offset, offset + limit),
    unresolvedSelections: unresolved,
    warnings,
    comparisonMethod:
      "same fixture + market (including line/period) + outcome + player; timestamps may differ",
    movementMethod:
      "Price movement at a fixed line. Historical main-line switches are not supplied by this endpoint.",
    rlm: {
      status: "not_determinable",
      reason: "Aucune donnée de répartition des mises/tickets; un mouvement de cote ne suffit pas.",
    },
  };
}

export class Scanner {
  constructor(private client: OddsClient) {}
  async odds(fixtureId: string, options: Options = {}) {
    if ((options.minOdds ?? 1.4) > (options.maxOdds ?? 2))
      throw new ProviderError("Plage de cotes invalide.");
    const language = options.language ?? "en";
    const bookList =
      options.bookmakers && options.bookmakers !== "all"
        ? [
            ...new Set([
              WINAMAX,
              "pinnacle",
              ...options.bookmakers
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            ]),
          ].join(",")
        : "";
    const metadata = await this.client.markets(language);
    const f = await this.client.get("odds", {
      fixtureId,
      language,
      verbosity: "3",
      oddsFormat: "decimal",
      bookmakers: bookList,
    });
    let history: Dict | undefined;
    let historyError: string | undefined;
    if (options.includeHistory) {
      history = { bookmakers: {} };
      // Historical endpoint accepts at most 3 bookmakers per call.
      const requested =
        options.bookmakers === "all"
          ? Object.keys(f.bookmakerOdds ?? {})
          : [
              ...new Set([
                WINAMAX,
                "pinnacle",
                ...(options.bookmakers
                  ?.split(",")
                  .map((s) => s.trim())
                  .filter(Boolean) ?? []),
              ]),
            ];
      const groups = requested.filter((b) => f.bookmakerOdds?.[b]);
      for (let i = 0; i < groups.length; i += 3) {
        try {
          const h = await this.client.get("historical-odds", {
            fixtureId,
            bookmakers: groups.slice(i, i + 3).join(","),
          });
          Object.assign(history.bookmakers, h.bookmakers ?? {});
        } catch (e) {
          historyError = e instanceof ProviderError ? e.message : "Historique indisponible.";
          break;
        }
      }
    }
    const result = normalizeOdds(f, metadata, options, history);
    if (historyError) result.warnings.push(historyError);
    return {
      ...result,
      historyStatus: !options.includeHistory
        ? "not_requested"
        : historyError
          ? "partial_or_unavailable"
          : "retrieved",
    };
  }

  async search(
    args: Options & {
      from: string;
      to: string;
      sportId?: number;
      sportName?: string;
      includeMarkets?: boolean;
    },
  ) {
    const from = Date.parse(args.from),
      to = Date.parse(args.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from >= 48 * 3600000)
      throw new ProviderError(
        "Utiliser deux dates ISO avec fuseau, dans une fenêtre positive inférieure à 48 heures.",
      );
    const data = await this.client.get("fixtures", {
      from: args.from,
      to: args.to,
      statusId: "0",
      hasOdds: "true",
      bookmakers: WINAMAX,
      language: args.language ?? "en",
      ...(args.sportId === undefined ? {} : { sportId: String(args.sportId) }),
    });
    if (!Array.isArray(data)) throw new ProviderError("Catalogue des événements invalide.");
    const events = data
      .filter(
        (f: Dict) =>
          f.statusId === 0 &&
          !f.trueStartTime &&
          Date.parse(f.startTime) > Date.now() &&
          Date.parse(f.startTime) >= from &&
          Date.parse(f.startTime) <= to &&
          (!args.sportName || f.sportName?.toLowerCase().includes(args.sportName.toLowerCase())),
      )
      .sort(
        (a: Dict, b: Dict) =>
          Date.parse(a.startTime) - Date.parse(b.startTime) ||
          String(a.fixtureId).localeCompare(String(b.fixtureId)),
      );
    const offset = args.offset ?? 0,
      limit = args.limit ?? 20;
    const page = events.slice(offset, offset + limit);
    const results: Dict[] = [];
    for (const f of page) {
      if (args.includeMarkets) {
        try {
          results.push(await this.odds(f.fixtureId, { ...args, offset: 0, limit: 100 }));
        } catch (e) {
          results.push({
            fixture: fixtureView(f, args.timezone),
            error: e instanceof ProviderError ? e.message : "Cotes indisponibles.",
          });
        }
      } else results.push(fixtureView(f, args.timezone));
    }
    return {
      schemaVersion: "2.0",
      retrievedAt: new Date().toISOString(),
      from: args.from,
      to: args.to,
      totalEvents: events.length,
      offset,
      nextOffset: offset + limit < events.length ? offset + limit : null,
      includeMarkets: args.includeMarkets ?? false,
      events: results,
      note: "countryOrCategory reprend la catégorie du fournisseur; country reste null pour les catégories sans pays reconnu. Les filtres de cotes s'appliquent avec includeMarkets=true.",
    };
  }
}
