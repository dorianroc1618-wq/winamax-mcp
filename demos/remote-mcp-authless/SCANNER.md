# Winamax scanner v2

The existing five MCP tool names are preserved. Responses now use a `schemaVersion: "2.0"` envelope rather than raw provider data.

## Usage

1. `search_winamax_events({from, to})`: current pre-match Winamax fixture catalogue, with sport, country/category, competition, participants, UTC and Europe/Paris times. Follow `nextOffset` until null.
2. `get_winamax_odds({fixtureId})`: active Winamax selections between 1.40 and 2.00 inclusive, resolved using `/v4/markets`. Every row includes provider market/outcome labels, participant display label, line, period, statuses, current decimal price, provider change timestamp and bookmaker timestamp when supplied. `retrievedAt` is the consultation time, not the last price change.
3. `get_odds_history({fixtureId})`: the same rows with Winamax/Pinnacle history. `includePoints: true` returns chronological points. Opening means the first recorded active quote, not a guaranteed bookmaker opening. Latest historical state and current quote are separate; a suspended quote is never treated as available.

`minOdds`, `maxOdds`, `marketName`, `selectionName`, `includeInactive`, `language` (`en`/`fr`), `timezone`, `offset`, and `limit` are configurable. Text filters use the requested provider language. Odds responses default to 100 selections (maximum 500); follow their `nextOffset` using `get_winamax_odds` or `get_odds_history` with the same filters.

`search_winamax_events` accepts `includeMarkets: true` to retrieve filtered selections for each event (20 events per page maximum). Events without matching selections remain present with an empty selection list; failures are explicit per event. Each event has its own selection pagination. Fixture pages are live and can change as events start. `includeHistory` works on both search and odds tools, but use it on shortlisted fixtures to conserve quota.

## Comparisons and limits

Current comparisons request all available bookmakers by default. Set `bookmakers` to a comma-separated list to limit them; Winamax and Pinnacle are always requested. Only the exact same fixture, market (line/period), outcome and player are compared. Each quote retains its timestamp and availability; unavailable quotes have no calculated price advantage. These prices are not synchronized snapshots and price advantage is not an estimated betting value.

Historical requests default to Winamax/Pinnacle. Additional comma-separated bookmakers are supported; `bookmakers: "all"` requests histories for all returned bookmakers in batches of at most three. This can be slow and consume substantial quota. Partial history failures are reported via `historyStatus` and warnings. Missing history has no fabricated opening or movement.

RLM is always `not_determinable`: OddsPapi data used here do not include public bet/ticket splits. Movement describes price changes at the same fixed line. The historical endpoint does not expose switches of the main handicap line.

Labels are the exact normalized **OddsPapi** catalogue labels; they are not claimed to reproduce native Winamax wording. Unresolved market/outcome/player labels are excluded and counted in `unresolvedSelections`. `country` uses an explicit provider country or a recognized geographic category (English/French region names); international competitions/tours remain null and retain `countryOrCategory`.

Metadata is cached for six hours per Worker instance/language. Endpoint requests are serialized within the client with documented cooldowns; HTTP 429 retries honor the provider delay (bounded to three attempts). Other Worker instances or consumers can still share upstream account limits. No provider error body or request URL is returned. `test_oddspapi` only returns an allowlisted connection/quota summary. `ODDSPAPI_API_KEY` and `PULSESCORE_API_KEY` stay in Cloudflare secrets; PulseScore is not called or changed.

## Validation

With dependencies installed, run:

```sh
node node_modules/typescript/bin/tsc --noEmit
node --experimental-transform-types --test test/odds.test.mjs
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .dry-run
