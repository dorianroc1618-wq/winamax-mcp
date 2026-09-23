import test from "node:test";
import assert from "node:assert/strict";
import { OddsClient, Scanner, normalizeOdds, historyView, fixtureView } from "../src/odds.ts";

const env = { ODDSPAPI_API_KEY: "test-secret-never-return", PULSESCORE_API_KEY: "unused-secret" };
const meta = new Map([
  [
    "101",
    {
      marketId: 101,
      sportId: 10,
      marketName: "Full Time Result",
      handicap: 0,
      period: "fulltime",
      marketType: "1x2",
      outcomes: [
        { outcomeId: 101, outcomeName: "1" },
        { outcomeId: 102, outcomeName: "X" },
        { outcomeId: 103, outcomeName: "2" },
      ],
    },
  ],
  [
    "106",
    {
      marketId: 106,
      sportId: 10,
      marketName: "Over Under Full Time",
      handicap: 0.5,
      period: "fulltime",
      marketType: "totals",
      outcomes: [{ outcomeId: 106, outcomeName: "Over" }],
    },
  ],
]);
function book(prices, suspended = false) {
  return {
    bookmakerIsActive: true,
    suspended,
    markets: {
      101: {
        marketActive: true,
        outcomes: Object.fromEntries(
          prices.map((price, i) => [
            101 + i,
            { players: { 0: { active: true, price, changedAt: "2026-09-23T10:00:00Z" } } },
          ]),
        ),
      },
    },
  };
}
const fixture = () => ({
  fixtureId: "example",
  sportId: 10,
  sportName: "Soccer",
  tournamentName: "League",
  categoryName: "France",
  participant1Name: "Team A",
  participant2Name: "Team B",
  statusId: 0,
  startTime: "2099-09-23T15:00:00Z",
  bookmakerOdds: {
    "winamax.fr": book([1.4, 2, 2.01]),
    pinnacle: book([1.5, 2.1, 2.2]),
    other: book([1.6, 2.2, 2.3], true),
  },
});

test("inclusive Winamax range, resolved participants, matching quotes and suspended comparison", () => {
  const r = normalizeOdds(fixture(), meta);
  assert.equal(r.totalSelections, 2);
  assert.equal(r.selections[0].selection, "Team A");
  assert.equal(r.selections[0].market, "Full Time Result");
  assert.equal(r.selections[0].outcome, "1");
  assert.equal(r.selections[0].comparisons[0].price, 1.5);
  assert.equal(r.selections[0].comparisons[1].winamaxPriceAdvantagePercent, null);
  assert.equal(r.rlm.status, "not_determinable");
});
test("inactive selections and suspended markets excluded unless requested", () => {
  const f = fixture();
  f.bookmakerOdds["winamax.fr"].markets["101"].outcomes["101"].players["0"].active = false;
  assert.equal(normalizeOdds(f, meta).totalSelections, 1);
  assert.equal(normalizeOdds(f, meta, { includeInactive: true }).totalSelections, 2);
  f.bookmakerOdds["winamax.fr"].suspended = true;
  assert.equal(normalizeOdds(f, meta).totalSelections, 0);
});
test("unknown metadata never presented as meaningful labels", () => {
  const r = normalizeOdds(fixture(), new Map());
  assert.equal(r.totalSelections, 0);
  assert.equal(r.unresolvedSelections, 2);
});
test("different lines and players never cross-matched; line exposed", () => {
  const f = fixture();
  f.bookmakerOdds["winamax.fr"].markets = {
    106: {
      marketActive: true,
      outcomes: { 106: { players: { 0: { price: 1.6, active: true } } } },
    },
  };
  const r = normalizeOdds(f, meta);
  assert.equal(r.selections[0].line, 0.5);
  assert.equal(r.selections[0].comparisons.length, 0);
});
test("pagination and text filters", () => {
  const r = normalizeOdds(fixture(), meta, { limit: 1 });
  assert.equal(r.nextOffset, 1);
  assert.equal(
    normalizeOdds(fixture(), meta, { selectionName: "team a", marketName: "full" }).totalSelections,
    1,
  );
});
test("history sorted chronologically, opening active, latest suspension preserved", () => {
  const h = historyView(
    [
      { price: 1.5, createdAt: "2026-09-23T12:00:00Z", active: false },
      { price: 1.8, createdAt: "2026-09-23T10:00:00Z", active: true },
      { price: 1.9, createdAt: "2026-09-23T09:00:00Z", active: false },
    ],
    { price: 1.6, available: true },
    true,
  );
  assert.equal(h.opening.price, 1.8);
  assert.equal(h.latestRecorded.active, false);
  assert.equal(h.direction, "shortening");
  assert.equal(h.points[0].price, 1.9);
  assert.equal(historyView([], null).direction, "unavailable");
});
test("countries distinguished from international competitions and Paris summer/winter time", () => {
  assert.equal(fixtureView(fixture()).country, "France");
  assert.equal(fixtureView({ ...fixture(), categoryName: "International" }).country, null);
  assert.match(
    fixtureView({ ...fixture(), startTime: "2026-09-23T15:00:00Z" }).startTimeLocal,
    /17:00:00/,
  );
  assert.match(
    fixtureView({ ...fixture(), startTime: "2026-12-23T15:00:00Z" }).startTimeLocal,
    /16:00:00/,
  );
});
test("provider errors and network errors never expose secrets", async () => {
  const c = new OddsClient(env, async () => new Response(env.ODDSPAPI_API_KEY, { status: 403 }));
  await assert.rejects(c.get("odds"), (e) => e.message === "OddsPapi odds: HTTP 403.");
  const n = new OddsClient(env, async () => {
    throw new Error(env.ODDSPAPI_API_KEY);
  });
  await assert.rejects(n.get("odds"), (e) => !e.message.includes(env.ODDSPAPI_API_KEY));
});
test("429 retried and metadata cached with concurrent callers", async () => {
  let count = 0;
  const c = new OddsClient(env, async () => {
    count++;
    return count === 1
      ? Response.json({ error: { retryMs: 1 } }, { status: 429 })
      : Response.json([...meta.values()]);
  });
  const [a, b] = await Promise.all([c.markets(), c.markets()]);
  assert.equal(count, 2);
  assert.equal(a, b);
});
test("search then markets uses real fixture catalogue, rejects past/live, returns labels and comparisons", async () => {
  const paths = [];
  const c = new OddsClient(env, async (url) => {
    const u = new URL(url);
    paths.push(u.pathname);
    if (u.pathname.endsWith("/fixtures"))
      return Response.json([
        fixture(),
        { ...fixture(), fixtureId: "past", startTime: "2000-01-01T00:00:00Z" },
        { ...fixture(), fixtureId: "live", statusId: 1 },
      ]);
    if (u.pathname.endsWith("/markets")) return Response.json([...meta.values()]);
    if (u.pathname.endsWith("/odds")) {
      assert.equal(u.searchParams.has("bookmakers"), false);
      return Response.json(fixture());
    }
    throw new Error("Unexpected endpoint");
  });
  const r = await new Scanner(c).search({
    from: "2099-09-23T00:00:00Z",
    to: "2099-09-24T00:00:00Z",
    includeMarkets: true,
  });
  assert.equal(r.totalEvents, 1);
  assert.equal(r.events[0].selections[0].selection, "Team A");
  assert.deepEqual(paths, ["/v4/fixtures", "/v4/markets", "/v4/odds"]);
});
test("history comparison includes provider-labelled opening/current", async () => {
  const c = new OddsClient(env, async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/markets")) return Response.json([...meta.values()]);
    if (u.pathname.endsWith("/odds")) return Response.json(fixture());
    assert.equal(u.searchParams.get("bookmakers"), "winamax.fr,pinnacle");
    return Response.json({
      bookmakers: {
        "winamax.fr": {
          markets: {
            101: {
              outcomes: {
                101: {
                  players: { 0: [{ price: 1.8, active: true, createdAt: "2026-09-23T09:00:00Z" }] },
                },
              },
            },
          },
        },
      },
    });
  });
  const r = await new Scanner(c).odds("example", { includeHistory: true });
  assert.equal(r.selections[0].movement[0].opening.price, 1.8);
  assert.equal(r.selections[0].movement[0].current.price, 1.4);
});
