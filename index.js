import express from "express";
import fs from "fs";

/* ────────────────────────────────────────────────────────────────────────
   ODDS MATH
──────────────────────────────────────────────────────────────────────── */

function americanToDecimal(american) {
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}
function decimalToAmerican(decimal) {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}
function americanToImpliedProb(american) {
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}
function devigTwoWay(americanA, americanB) {
  const pA = americanToImpliedProb(americanA);
  const pB = americanToImpliedProb(americanB);
  const overround = pA + pB;
  return { trueProbA: pA / overround, trueProbB: pB / overround, overround };
}
function combineDecimalOdds(arr) {
  return arr.reduce((a, d) => a * d, 1);
}
function combineProbabilities(arr) {
  return arr.reduce((a, p) => a * p, 1);
}
function expectedValuePerDollar(trueProb, decimalOdds) {
  return trueProb * (decimalOdds - 1) + (1 - trueProb) * -1;
}

/* ────────────────────────────────────────────────────────────────────────
   SPORTS / MARKET CONFIG
   Coverage drifts as books add/drop markets — verify against
   https://the-odds-api.com/sports-odds-data/betting-markets.html if a
   sport comes back empty.
──────────────────────────────────────────────────────────────────────── */

const SPORTS = {
  americanfootball_nfl: {
    label: "NFL",
    markets: [
      "player_pass_tds", "player_pass_yds", "player_pass_completions",
      "player_pass_interceptions", "player_rush_yds", "player_reception_yds",
      "player_receptions", "player_anytime_td",
    ],
  },
  basketball_nba: {
    label: "NBA",
    markets: [
      "player_points", "player_rebounds", "player_assists", "player_threes",
      "player_blocks", "player_steals", "player_points_rebounds_assists",
    ],
  },
  baseball_mlb: {
    label: "MLB",
    markets: [
      "batter_home_runs", "batter_hits", "batter_total_bases",
      "batter_rbis", "batter_stolen_bases", "pitcher_strikeouts",
    ],
  },
  icehockey_nhl: {
    label: "NHL",
    markets: ["player_points", "player_goals", "player_assists", "player_shots_on_goal"],
  },
  basketball_wnba: {
    label: "WNBA",
    markets: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  },
};

const DEFAULT_REGIONS = process.env.ODDS_API_REGIONS || "us";
const MAX_EVENTS_PER_SPORT = 6;

/* ────────────────────────────────────────────────────────────────────────
   ODDS API CLIENT
──────────────────────────────────────────────────────────────────────── */

const BASE_URL = "https://api.the-odds-api.com/v4";

class OddsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OddsApiError";
    this.status = status;
  }
}

function requireKey() {
  const key = process.env.ODDS_API_KEY;
  if (!key || key === "your_key_here") {
    throw new OddsApiError(
      "ODDS_API_KEY is not set. Add it as an environment variable.",
      401
    );
  }
  return key;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OddsApiError(`Odds API request failed (${res.status}): ${body}`, res.status);
  }
  return res.json();
}

async function listEvents(sportKey) {
  const key = requireKey();
  const params = new URLSearchParams({ apiKey: key });
  return getJson(`${BASE_URL}/sports/${sportKey}/events?${params.toString()}`);
}

async function getEventPlayerProps(sportKey, eventId, markets, regions) {
  const key = requireKey();
  const params = new URLSearchParams({
    apiKey: key,
    regions,
    markets: markets.join(","),
    oddsFormat: "american",
    dateFormat: "iso",
  });
  return getJson(`${BASE_URL}/sports/${sportKey}/events/${eventId}/odds?${params.toString()}`);
}

/* ────────────────────────────────────────────────────────────────────────
   NORMALIZE ODDS -> DE-VIGGED LEGS
──────────────────────────────────────────────────────────────────────── */

const ONE_SIDED_MARKETS = new Set(["player_anytime_td", "player_1st_td", "player_last_td"]);

// Books known for tight, efficient pricing get more weight in the de-vig
// average — a sharp book's price reflects sharper market consensus than a
// slower-to-move retail book, so it's a better estimate of true probability.
const SHARP_BOOK_WEIGHT = 3;
const SHARP_BOOKS = new Set(["Pinnacle", "Circa Sports", "BetOnline.ag"]);

function legKey(market, player, point) {
  return `${market}::${player}::${point}`;
}

function normalizeEventOdds(eventData, sportKey, sportLabel) {
  const { id: eventId, commence_time, home_team, away_team, bookmakers = [] } = eventData;
  const grouped = new Map();

  for (const book of bookmakers) {
    for (const market of book.markets || []) {
      for (const outcome of market.outcomes || []) {
        const player = outcome.description || outcome.name;
        const side = ["Over", "Under"].includes(outcome.name) ? outcome.name : "Yes";
        const key = legKey(market.key, player, outcome.point ?? "NA");
        if (!grouped.has(key)) {
          grouped.set(key, { market: market.key, player, point: outcome.point ?? null, sides: {} });
        }
        const entry = grouped.get(key);
        if (!entry.sides[side]) entry.sides[side] = [];
        entry.sides[side].push({ book: book.title, american: outcome.price });
      }
    }
  }

  const legs = [];

  for (const { market, player, point, sides } of grouped.values()) {
    const oneSided = ONE_SIDED_MARKETS.has(market);
    for (const side of Object.keys(sides)) {
      const quotes = sides[side];
      const opposite = side === "Over" ? sides["Under"] : side === "Under" ? sides["Over"] : null;
      const best = quotes.reduce((a, b) => (a.american > b.american ? a : b));

      let trueProb;
      let devigged = false;
      if (!oneSided && opposite && opposite.length) {
        // Only pair a book's price against THAT SAME book's opposite-side price.
        // Pairing across different books (the old fallback) can mismatch a
        // generous book's price against a stingy book's opposite price and
        // produce a fabricated "edge" that isn't real.
        const pairedTrueProbs = [];
        for (const q of quotes) {
          const oppForBook = opposite.find((o) => o.book === q.book);
          if (!oppForBook) continue;
          const { trueProbA, overround } = devigTwoWay(q.american, oppForBook.american);
          // A real two-sided market's implied probabilities sum to slightly
          // ABOVE 100% (that's the vig). A sum outside ~98%-130% means these
          // two prices aren't real complements of each other — reject the pairing
          // rather than let it produce a fabricated probability.
          if (overround < 0.98 || overround > 1.3) continue;
          const weight = SHARP_BOOKS.has(q.book) ? SHARP_BOOK_WEIGHT : 1;
          pairedTrueProbs.push({ trueProbA, weight });
        }
        if (pairedTrueProbs.length) {
          const totalWeight = pairedTrueProbs.reduce((a, p) => a + p.weight, 0);
          trueProb = pairedTrueProbs.reduce((a, p) => a + p.trueProbA * p.weight, 0) / totalWeight;
          devigged = true;
        } else {
          // No single book quoted both sides — can't de-vig reliably, fall back to raw implied.
          trueProb = americanToImpliedProb(best.american);
        }
      } else {
        trueProb = americanToImpliedProb(best.american);
      }

      const impliedBest = americanToImpliedProb(best.american);
      // Sanity clamp: a real de-vig shift this large on a liquid market is
      // implausible and more likely a data/pairing issue than a true edge.
      const MAX_PLAUSIBLE_SWING = 0.10;
      let suspect = false;
      if (devigged && Math.abs(trueProb - impliedBest) > MAX_PLAUSIBLE_SWING) {
        trueProb = impliedBest;
        devigged = false;
        suspect = true;
      }

      legs.push({
        id: `${eventId}:${market}:${player}:${side}:${point}`,
        sport: sportKey, sportLabel, eventId, commenceTime: commence_time,
        matchup: `${away_team} @ ${home_team}`,
        market, player, side, point,
        bestAmerican: best.american, bestBook: best.book, numBooks: quotes.length,
        impliedProbBest: impliedBest,
        trueProb, devigged, suspect,
        edge: trueProb - impliedBest,
      });
    }
  }
  return legs;
}

/* ────────────────────────────────────────────────────────────────────────
   LINE MOVEMENT TRACKING
   Persists each leg's opening price/probability to disk (Railway volume at
   /data) and compares it against the current scan on every subsequent scan.
   A line moving without an obvious news reason is often sharp money — a
   signal this app otherwise wouldn't see from a single snapshot.
   This is a heuristic nudge, not a validated predictive signal: it's
   surfaced in the research text and given a modest ranking boost, but it
   never overrides the de-vigged probability math.
──────────────────────────────────────────────────────────────────────── */

const HISTORY_PATH = process.env.LINE_HISTORY_PATH || "/data/line-history.json";
const MEANINGFUL_PROB_MOVE = 0.03; // 3 probability points — below this we call it noise

let historyWriteWarned = false;

function loadLineHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveLineHistory(history) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  } catch (err) {
    if (!historyWriteWarned) {
      console.warn(`Line history not persisted (${err.message}) — movement tracking disabled until this is fixed.`);
      historyWriteWarned = true;
    }
  }
}

/**
 * Mutates each leg with a `movement` field (null on first sighting) and
 * persists updated opening/latest prices to disk. Stale entries (games
 * that have already started) are pruned so the file doesn't grow forever.
 */
function applyLineMovement(legs) {
  const now = Date.now();
  const history = loadLineHistory();

  for (const key of Object.keys(history)) {
    const commence = Date.parse(history[key].commenceTime);
    if (!Number.isNaN(commence) && commence < now) delete history[key];
  }

  for (const leg of legs) {
    const existing = history[leg.id];
    if (!existing) {
      history[leg.id] = {
        commenceTime: leg.commenceTime,
        openingAmerican: leg.bestAmerican,
        openingTrueProb: leg.trueProb,
        firstSeen: new Date(now).toISOString(),
        scans: 1,
      };
      leg.movement = null;
    } else {
      existing.scans += 1;
      const deltaProb = leg.trueProb - existing.openingTrueProb;
      leg.movement = {
        openingAmerican: existing.openingAmerican,
        openingTrueProb: existing.openingTrueProb,
        deltaAmerican: leg.bestAmerican - existing.openingAmerican,
        deltaProb,
        scans: existing.scans,
        significant: Math.abs(deltaProb) >= MEANINGFUL_PROB_MOVE,
      };
    }
  }

  saveLineHistory(history);
  return legs;
}

/* ────────────────────────────────────────────────────────────────────────
   PARLAY BUILDER
──────────────────────────────────────────────────────────────────────── */

const DEFAULT_OPTIONS = {
  targetAmericanOdds: 1000, toleranceLow: 700, toleranceHigh: 1600,
  minLegs: 3, maxLegs: 6, minBooksPerLeg: 2,
  minTrueProb: 0.12, maxTrueProb: 0.72,
  allowSameEventLegs: false, iterations: 8000, resultCount: 10,
};

function combinedAmerican(legs) {
  const decimal = combineDecimalOdds(legs.map((l) => americanToDecimal(l.bestAmerican)));
  return { decimal, american: decimalToAmerican(decimal) };
}

function movementBoost(leg) {
  if (!leg.movement || !leg.movement.significant || leg.movement.deltaProb <= 0) return 1;
  // Modest, capped boost — this is a heuristic nudge, not a validated edge.
  return 1 + Math.min(leg.movement.deltaProb * 4, 0.4);
}

function pickWeightedByEdge(pool, rng) {
  const weights = pool.map((l) => (Math.max(l.edge, 0) * 20 + 1) * movementBoost(l));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function buildParlays(allLegs, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rng = Math.random;
  const pool = allLegs.filter(
    (l) => !l.suspect && l.numBooks >= opts.minBooksPerLeg && l.trueProb >= opts.minTrueProb && l.trueProb <= opts.maxTrueProb
  );

  const seen = new Set();
  const results = [];

  for (let i = 0; i < opts.iterations && pool.length >= opts.minLegs; i++) {
    const legCount = opts.minLegs + Math.floor(rng() * (opts.maxLegs - opts.minLegs + 1));
    const combo = [];
    const usedEvents = new Set();
    let attempts = 0;

    while (combo.length < legCount && attempts < legCount * 15) {
      attempts++;
      const candidate = pickWeightedByEdge(pool, rng);
      if (combo.some((l) => l.id === candidate.id)) continue;
      if (!opts.allowSameEventLegs && usedEvents.has(candidate.eventId)) continue;
      combo.push(candidate);
      usedEvents.add(candidate.eventId);
    }
    if (combo.length < opts.minLegs) continue;

    const { american } = combinedAmerican(combo);
    if (american < opts.toleranceLow || american > opts.toleranceHigh) continue;

    const key = combo.map((l) => l.id).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const trueProb = combineProbabilities(combo.map((l) => l.trueProb));
    const decimal = combineDecimalOdds(combo.map((l) => americanToDecimal(l.bestAmerican)));
    const ev = expectedValuePerDollar(trueProb, decimal);

    results.push({
      legs: combo.sort((a, b) => b.edge - a.edge),
      combinedAmerican: american, combinedDecimal: decimal,
      trueProbability: trueProb, evPerDollar: ev,
      avgBooksPerLeg: combo.reduce((a, l) => a + l.numBooks, 0) / combo.length,
      allDevigged: combo.every((l) => l.devigged),
    });
  }

  results.sort((a, b) => {
    if (Math.abs(a.evPerDollar - b.evPerDollar) > 0.005) return b.evPerDollar - a.evPerDollar;
    return Math.abs(a.combinedAmerican - opts.targetAmericanOdds) - Math.abs(b.combinedAmerican - opts.targetAmericanOdds);
  });

  return results.slice(0, opts.resultCount);
}

function marketLabel(marketKey) {
  return marketKey.replace(/^player_|^batter_|^pitcher_/, "").replace(/_/g, " ");
}

function explainParlay(parlay) {
  const lines = [];
  lines.push(
    `${parlay.legs.length}-leg parlay at +${parlay.combinedAmerican} (fair-ish odds ${(1 / parlay.trueProbability).toFixed(1)}:1 based on de-vigged leg probabilities).`
  );
  lines.push(
    `Estimated true hit probability: ${(parlay.trueProbability * 100).toFixed(1)}%. Modeled EV: ${parlay.evPerDollar >= 0 ? "+" : ""}${(parlay.evPerDollar * 100).toFixed(1)}% per $1 staked — ${parlay.evPerDollar >= -0.05 ? "close to fair for a longshot parlay" : "still carries the standard sportsbook hold; treat as entertainment-weighted, not a value bet"}.`
  );
  for (const leg of parlay.legs) {
    const edgePct = (leg.edge * 100).toFixed(1);
    let movementText;
    if (!leg.movement) {
      movementText = " First scan tracking this line — no movement history yet.";
    } else if (leg.movement.significant) {
      const pts = (Math.abs(leg.movement.deltaProb) * 100).toFixed(1);
      const dir = leg.movement.deltaProb > 0 ? "toward" : "away from";
      movementText = ` Line has moved ${dir} this side by ${pts} probability points since it opened at ${leg.movement.openingAmerican > 0 ? "+" : ""}${leg.movement.openingAmerican} (${leg.movement.scans} scans tracked) — possible sharp money.`;
    } else {
      movementText = ` Line steady since it opened at ${leg.movement.openingAmerican > 0 ? "+" : ""}${leg.movement.openingAmerican} (${leg.movement.scans} scans tracked, no meaningful movement).`;
    }
    lines.push(
      `• ${leg.player} ${leg.side} ${leg.point ?? ""} ${marketLabel(leg.market)} (${leg.matchup}) — best price ${leg.bestAmerican > 0 ? "+" : ""}${leg.bestAmerican} at ${leg.bestBook}, ${leg.numBooks} books quoting it${
        leg.devigged
          ? `, de-vigged true probability ${(leg.trueProb * 100).toFixed(1)}% (${edgePct}% ${leg.edge >= 0 ? "better" : "worse"} than the market's own implied price)`
          : " (single-sided market — probability is vig-inclusive, not de-vigged)"
      }.${movementText}`
    );
  }
  lines.push(
    "Caveat: EV assumes legs are independent. Legs are kept to one per game specifically to avoid correlation this model can't measure — treat same-game stacks with extra skepticism if you build them manually."
  );
  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────────────────────
   RESULTS TRACKING
   Every fresh scan logs its top parlays to disk. There's no free box-score
   API wired in here, so grading is manual — you (or whoever) mark each leg
   win/loss/push after the game. What this buys you: a calibration report
   comparing the model's stated probability against what actually happened,
   which is the only real way to know if "de-vigged 55%" means anything.
──────────────────────────────────────────────────────────────────────── */

const PICKS_LOG_PATH = process.env.PICKS_LOG_PATH || "/data/picks-log.json";
const MAX_LOGGED_PICKS = 500; // keep the file bounded; oldest picks drop off

let picksWriteWarned = false;

function loadPicksLog() {
  try {
    return JSON.parse(fs.readFileSync(PICKS_LOG_PATH, "utf8"));
  } catch {
    return [];
  }
}

function savePicksLog(picks) {
  try {
    fs.writeFileSync(PICKS_LOG_PATH, JSON.stringify(picks));
  } catch (err) {
    if (!picksWriteWarned) {
      console.warn(`Picks log not persisted (${err.message}) — results tracking disabled until this is fixed.`);
      picksWriteWarned = true;
    }
  }
}

function logPicks(parlays) {
  const picks = loadPicksLog();
  const now = new Date().toISOString();
  parlays.forEach((p, i) => {
    picks.push({
      id: `${Date.now()}_${i}`,
      generatedAt: now,
      combinedAmerican: p.combinedAmerican,
      trueProbability: p.trueProbability,
      evPerDollar: p.evPerDollar,
      legs: p.legs.map((l) => ({
        id: l.id, player: l.player, side: l.side, point: l.point, market: l.market,
        matchup: l.matchup, bestAmerican: l.bestAmerican, trueProb: l.trueProb,
        devigged: l.devigged, commenceTime: l.commenceTime,
      })),
      graded: false,
      result: null,
      legResults: {},
      gradedAt: null,
    });
  });
  const trimmed = picks.slice(-MAX_LOGGED_PICKS);
  savePicksLog(trimmed);
}

/** Overall parlay result from per-leg win/loss/push calls. Pushes are dropped (standard parlay rule); the parlay wins only if every remaining leg wins. */
function gradeParlayResult(legResults, legIds) {
  const calls = legIds.map((id) => legResults[id]).filter(Boolean);
  if (calls.length < legIds.length) return null; // not fully graded yet
  const active = calls.filter((c) => c !== "push");
  if (!active.length) return "push"; // everything pushed
  if (active.includes("loss")) return "loss";
  return "win";
}

function computeTrackRecord() {
  const picks = loadPicksLog().filter((p) => p.graded);
  if (!picks.length) {
    return { gradedCount: 0, hitRate: null, avgModeledProbability: null, avgEvPerDollar: null, realizedEvPerDollar: null };
  }
  const wins = picks.filter((p) => p.result === "win").length;
  const decided = picks.filter((p) => p.result === "win" || p.result === "loss");
  const hitRate = decided.length ? wins / decided.length : null;
  const avgModeledProbability = picks.reduce((a, p) => a + p.trueProbability, 0) / picks.length;
  const avgEvPerDollar = picks.reduce((a, p) => a + p.evPerDollar, 0) / picks.length;
  // Realized EV: what actually happened, using each pick's own payout multiple on wins.
  const realizedEvPerDollar =
    decided.reduce((a, p) => {
      const decimal = americanToDecimal(p.combinedAmerican);
      return a + (p.result === "win" ? decimal - 1 : -1);
    }, 0) / (decided.length || 1);
  return { gradedCount: picks.length, decidedCount: decided.length, hitRate, avgModeledProbability, avgEvPerDollar, realizedEvPerDollar };
}

/* ────────────────────────────────────────────────────────────────────────
   SERVER
──────────────────────────────────────────────────────────────────────── */

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { key: null, timestamp: 0, data: null };

async function scanSports(sportKeys) {
  const allLegs = [];
  const scanned = { events: 0, sportsWithData: [], errors: [] };

  for (const sportKey of sportKeys) {
    const config = SPORTS[sportKey];
    if (!config) continue;

    let events;
    try {
      events = await listEvents(sportKey);
    } catch (err) {
      scanned.errors.push({ sport: sportKey, stage: "listEvents", message: err.message, status: err.status });
      continue;
    }
    if (!events || !events.length) continue;

    const eventsToPull = events.slice(0, MAX_EVENTS_PER_SPORT);
    let sportHadLegs = false;

    for (const event of eventsToPull) {
      try {
        const oddsData = await getEventPlayerProps(sportKey, event.id, config.markets, DEFAULT_REGIONS);
        const legs = normalizeEventOdds(oddsData, sportKey, config.label);
        if (legs.length) sportHadLegs = true;
        allLegs.push(...legs);
        scanned.events++;
      } catch (err) {
        scanned.errors.push({ sport: sportKey, eventId: event.id, stage: "getEventPlayerProps", message: err.message });
      }
    }
    if (sportHadLegs) scanned.sportsWithData.push(config.label);
  }
  return { allLegs, scanned };
}

app.use(express.json());

app.get("/api/scan", async (req, res) => {
  const requestedSports = (req.query.sports ? req.query.sports.split(",") : Object.keys(SPORTS)).filter((s) => SPORTS[s]);
  const targetOdds = Number(req.query.target) || 1000;
  const forceRefresh = req.query.refresh === "true";
  const cacheKey = `${requestedSports.sort().join(",")}::${targetOdds}`;
  const isFresh = cache.key === cacheKey && Date.now() - cache.timestamp < CACHE_TTL_MS;

  if (isFresh && !forceRefresh) return res.json({ ...cache.data, cached: true });

  try {
    const { allLegs, scanned } = await scanSports(requestedSports);
    applyLineMovement(allLegs);
    if (!allLegs.length) {
      const authError = scanned.errors.find((e) => e.status === 401);
      return res.status(200).json({
        parlays: [], scanned,
        message: authError
          ? "No ODDS_API_KEY configured — set it as an environment variable."
          : "No player-prop legs came back for the requested sports right now (off-slate day, or books haven't posted props yet).",
      });
    }
    const parlays = buildParlays(allLegs, { targetAmericanOdds: targetOdds });
    const withExplanations = parlays.map((p) => ({ ...p, explanation: explainParlay(p) }));
    logPicks(parlays);
    const payload = { parlays: withExplanations, scanned: { ...scanned, legsFound: allLegs.length }, generatedAt: new Date().toISOString() };
    cache = { key: cacheKey, timestamp: Date.now(), data: payload };
    res.json({ ...payload, cached: false });
  } catch (err) {
    const status = err instanceof OddsApiError ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sports", (req, res) => {
  res.json(Object.entries(SPORTS).map(([key, v]) => ({ key, label: v.label })));
});

app.get("/api/picks", (req, res) => {
  const status = req.query.status || "ungraded";
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  let picks = loadPicksLog();
  if (status === "ungraded") picks = picks.filter((p) => !p.graded);
  else if (status === "graded") picks = picks.filter((p) => p.graded);
  picks = picks.slice(-limit).reverse();
  res.json(picks);
});

app.post("/api/picks/:id/grade", (req, res) => {
  const { legResults } = req.body || {};
  if (!legResults || typeof legResults !== "object") {
    return res.status(400).json({ error: "Body must include legResults: { legId: 'win'|'loss'|'push' }" });
  }
  const picks = loadPicksLog();
  const pick = picks.find((p) => p.id === req.params.id);
  if (!pick) return res.status(404).json({ error: "Pick not found" });

  const legIds = pick.legs.map((l) => l.id);
  const validCalls = ["win", "loss", "push"];
  for (const [legId, call] of Object.entries(legResults)) {
    if (!legIds.includes(legId) || !validCalls.includes(call)) {
      return res.status(400).json({ error: `Invalid legId or result: ${legId} -> ${call}` });
    }
    pick.legResults[legId] = call;
  }

  const result = gradeParlayResult(pick.legResults, legIds);
  if (result) {
    pick.result = result;
    pick.graded = true;
    pick.gradedAt = new Date().toISOString();
  }
  savePicksLog(picks);
  res.json(pick);
});

app.get("/api/track-record", (req, res) => {
  res.json(computeTrackRecord());
});

app.get("/", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Longshot Board — Prop Parlay Scanner</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
:root{--ink:#0f1b22;--panel:#16262f;--hairline:#2c414c;--amber:#e8a33d;--amber-dim:#a97a33;--green:#6fbf8b;--red:#c96a5c;--text:#ede9df;--text-muted:#8fa3ac;--serif:"Fraunces",Georgia,serif;--sans:"IBM Plex Sans",system-ui,sans-serif}
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;background:var(--ink);color:var(--text);font-family:var(--sans);line-height:1.5}
.board{max-width:880px;margin:0 auto;padding:48px 24px 80px}
.board-head{display:flex;justify-content:space-between;align-items:flex-end;gap:32px;border-bottom:1px solid var(--hairline);padding-bottom:28px}
.eyebrow{color:var(--amber);font-size:.85rem;margin:0 0 10px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(2.2rem,5vw,3.2rem);margin:0 0 14px;letter-spacing:-.01em}
.sub{color:var(--text-muted);max-width:52ch;margin:0;font-size:.98rem}
.board-head-stat{display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0}
.stat-number{font-family:var(--serif);font-size:3rem;font-variant-numeric:tabular-nums;color:var(--amber);line-height:1}
.stat-label{color:var(--text-muted);font-size:.8rem;margin-top:6px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:18px;padding:24px 0;border-bottom:1px solid var(--hairline)}
.control-group{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sport-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--hairline);border-radius:4px;font-size:.85rem;cursor:pointer;color:var(--text-muted);user-select:none}
.sport-chip.active{border-color:var(--amber-dim);color:var(--text);background:rgba(232,163,61,.08)}
.control-target label{font-size:.85rem;color:var(--text-muted)}
#target-odds{background:var(--panel);border:1px solid var(--hairline);color:var(--amber);font-family:var(--sans);font-variant-numeric:tabular-nums;font-size:.9rem;padding:7px 10px;border-radius:4px;width:90px}
.scan-btn{background:var(--amber);color:#17222a;border:none;font-family:var(--sans);font-weight:600;font-size:.9rem;padding:10px 20px;border-radius:4px;cursor:pointer;margin-left:auto}
.scan-btn:disabled{opacity:.6;cursor:progress}
.scan-meta{color:var(--text-muted);font-size:.78rem}
.results{padding-top:8px}
.empty-state{color:var(--text-muted);padding:60px 0;text-align:center}
.parlay-row{display:grid;grid-template-columns:56px 1fr auto;gap:20px;align-items:start;padding:22px 0;border-bottom:1px solid var(--hairline)}
.rank{font-family:var(--serif);font-size:2.1rem;color:var(--amber-dim);line-height:1}
.parlay-main h3{margin:0 0 4px;font-family:var(--serif);font-size:1.2rem;font-weight:600}
.parlay-legs-preview{color:var(--text-muted);font-size:.88rem;margin:0 0 10px}
.parlay-detail{display:none;margin-top:10px;padding:14px 16px;background:var(--panel);border-radius:4px;border:1px solid var(--hairline);white-space:pre-line;font-size:.86rem;color:var(--text-muted)}
.parlay-detail.open{display:block}
.toggle-detail{background:none;border:none;color:var(--amber);font-size:.82rem;cursor:pointer;padding:0;font-family:var(--sans)}
.parlay-figures{text-align:right;flex-shrink:0}
.odds-figure{font-family:var(--serif);font-size:1.5rem;font-variant-numeric:tabular-nums;color:var(--amber)}
.ev-tag{display:inline-block;margin-top:6px;font-size:.75rem;padding:3px 8px;border-radius:3px}
.ev-tag.pos{color:var(--green);border:1px solid rgba(111,191,139,.4)}
.ev-tag.neg{color:var(--red);border:1px solid rgba(201,106,92,.4)}
.board-foot{margin-top:40px;color:var(--text-muted);font-size:.78rem;max-width:65ch}
@media (max-width:620px){.board-head{flex-direction:column;align-items:flex-start}.board-head-stat{align-items:flex-start}.parlay-row{grid-template-columns:40px 1fr}.parlay-figures{grid-column:1/-1;text-align:left;margin-top:6px}}
</style>
</head>
<body>
<div class="board">
<header class="board-head">
<div class="board-head-text">
<p class="eyebrow">Today's slate, ranked by modeled edge</p>
<h1>Longshot Board</h1>
<p class="sub">Pulls live player-prop lines, de-vigs every two-sided market to estimate true probability, then assembles parlays near your target price and ranks them by expected value — not just by which one pays the most.</p>
<p class="sub"><a href="/history" style="color:var(--amber)">Track record & grade picks →</a></p>
</div>
<div class="board-head-stat" id="headline-stat"><span class="stat-number">—</span><span class="stat-label">parlays found</span></div>
</header>
<section class="controls">
<div class="control-group" id="sport-toggles" aria-label="Sports to include"></div>
<div class="control-group control-target"><label for="target-odds">Target odds</label><input type="text" id="target-odds" value="+1000" /></div>
<button id="scan-btn" class="scan-btn">Scan market</button>
<span class="scan-meta" id="scan-meta"></span>
</section>
<main id="results" class="results" aria-live="polite"><p class="empty-state">Press "Scan market" to pull today's props and build the board.</p></main>
<footer class="board-foot"><p>Modeled EV assumes independent legs and de-vigged consensus pricing. Longshot parlays are volume products for sportsbooks — even the best-ranked combo here is very likely still negative EV. Treat this as a research ranking, not a guarantee.</p></footer>
</div>
<script>
const sportTogglesEl=document.getElementById("sport-toggles"),resultsEl=document.getElementById("results"),scanBtn=document.getElementById("scan-btn"),scanMetaEl=document.getElementById("scan-meta"),headlineStatEl=document.querySelector("#headline-stat .stat-number"),targetOddsInput=document.getElementById("target-odds");
let activeSports=new Set();
async function loadSports(){const sports=await fetch("/api/sports").then(r=>r.json());sportTogglesEl.innerHTML="";sports.forEach(({key,label})=>{activeSports.add(key);const chip=document.createElement("span");chip.className="sport-chip active";chip.textContent=label;chip.dataset.key=key;chip.addEventListener("click",()=>{if(activeSports.has(key)){activeSports.delete(key);chip.classList.remove("active")}else{activeSports.add(key);chip.classList.add("active")}});sportTogglesEl.appendChild(chip)})}
function parseTargetOdds(raw){const n=parseInt(raw.replace(/[^0-9-]/g,""),10);return Number.isFinite(n)?Math.abs(n):1000}
function formatAmerican(n){return n>0?"+"+n:""+n}
function escapeHtml(str){const div=document.createElement("div");div.textContent=str;return div.innerHTML}
function renderParlays(parlays){resultsEl.innerHTML="";if(!parlays.length){resultsEl.innerHTML='<p class="empty-state">No combos landed near that target with the current pool. Try widening the target odds or adding more sports.</p>';return}
parlays.forEach((p,i)=>{const row=document.createElement("article");row.className="parlay-row";const legsPreview=p.legs.map(l=>(l.player+" "+l.side+" "+(l.point??"")).trim()).join(" · ");const evPct=(p.evPerDollar*100).toFixed(1);const evClass=p.evPerDollar>=-0.05?"pos":"neg";row.innerHTML='<div class="rank">'+(i+1)+'</div><div class="parlay-main"><h3>'+p.legs.length+'-leg parlay</h3><p class="parlay-legs-preview">'+legsPreview+'</p><button class="toggle-detail">Show research</button><div class="parlay-detail">'+escapeHtml(p.explanation)+'</div></div><div class="parlay-figures"><div class="odds-figure">'+formatAmerican(p.combinedAmerican)+'</div><div class="ev-tag '+evClass+'">'+(evPct>=0?"+":"")+evPct+'% EV</div></div>';row.querySelector(".toggle-detail").addEventListener("click",(e)=>{const detail=row.querySelector(".parlay-detail");const open=detail.classList.toggle("open");e.target.textContent=open?"Hide research":"Show research"});resultsEl.appendChild(row)})}
async function scan(){if(!activeSports.size){scanMetaEl.textContent="Select at least one sport.";return}
scanBtn.disabled=true;scanBtn.textContent="Scanning…";resultsEl.innerHTML='<p class="empty-state">Pulling live prop lines and building combos…</p>';
const target=parseTargetOdds(targetOddsInput.value);const sportsParam=[...activeSports].join(",");
try{const res=await fetch("/api/scan?sports="+sportsParam+"&target="+target);const data=await res.json();
if(data.error){resultsEl.innerHTML='<p class="empty-state">'+escapeHtml(data.error)+'</p>';headlineStatEl.textContent="—";return}
if(data.message){resultsEl.innerHTML='<p class="empty-state">'+escapeHtml(data.message)+'</p>'}else{renderParlays(data.parlays)}
headlineStatEl.textContent=data.parlays?data.parlays.length:"0";const scanned=data.scanned||{};scanMetaEl.textContent=(scanned.events??0)+" events scanned · "+(scanned.legsFound??0)+" legs found"+(data.cached?" · cached":"")
}catch(err){resultsEl.innerHTML='<p class="empty-state">Scan failed: '+escapeHtml(err.message)+'</p>'}finally{scanBtn.disabled=false;scanBtn.textContent="Scan market"}}
scanBtn.addEventListener("click",scan);loadSports();
</script>
</body>
</html>`;

app.get("/history", (req, res) => {
  res.type("html").send(HISTORY_HTML);
});

const HISTORY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Track Record — Longshot Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
:root{--ink:#0f1b22;--panel:#16262f;--hairline:#2c414c;--amber:#e8a33d;--amber-dim:#a97a33;--green:#6fbf8b;--red:#c96a5c;--text:#ede9df;--text-muted:#8fa3ac;--serif:"Fraunces",Georgia,serif;--sans:"IBM Plex Sans",system-ui,sans-serif}
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;background:var(--ink);color:var(--text);font-family:var(--sans);line-height:1.5}
.board{max-width:880px;margin:0 auto;padding:48px 24px 80px}
.eyebrow{color:var(--amber);font-size:.85rem;margin:0 0 10px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(1.8rem,5vw,2.6rem);margin:0 0 20px}
a{color:var(--amber)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;padding:20px 0;border-bottom:1px solid var(--hairline);margin-bottom:24px}
.stat{background:var(--panel);border:1px solid var(--hairline);border-radius:4px;padding:14px}
.stat-num{font-family:var(--serif);font-size:1.6rem;color:var(--amber);font-variant-numeric:tabular-nums}
.stat-label{color:var(--text-muted);font-size:.78rem;margin-top:4px}
h2{font-family:var(--serif);font-size:1.2rem;margin:32px 0 12px}
.pick-card{background:var(--panel);border:1px solid var(--hairline);border-radius:4px;padding:16px;margin-bottom:14px}
.pick-head{display:flex;justify-content:space-between;color:var(--text-muted);font-size:.8rem;margin-bottom:10px}
.leg-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--hairline)}
.leg-name{font-size:.9rem}
.leg-btns{display:flex;gap:6px}
.leg-btns button{background:none;border:1px solid var(--hairline);color:var(--text-muted);font-size:.75rem;padding:4px 10px;border-radius:3px;cursor:pointer;font-family:var(--sans)}
.leg-btns button.active-win{border-color:var(--green);color:var(--green)}
.leg-btns button.active-loss{border-color:var(--red);color:var(--red)}
.leg-btns button.active-push{border-color:var(--amber-dim);color:var(--amber)}
.save-btn{margin-top:12px;background:var(--amber);color:#17222a;border:none;font-weight:600;font-size:.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:var(--sans)}
.empty-state{color:var(--text-muted);padding:20px 0}
.result-tag{font-size:.78rem;padding:2px 8px;border-radius:3px}
.result-tag.win{color:var(--green);border:1px solid rgba(111,191,139,.4)}
.result-tag.loss{color:var(--red);border:1px solid rgba(201,106,92,.4)}
.result-tag.push{color:var(--amber);border:1px solid rgba(232,163,61,.4)}
</style>
</head>
<body>
<div class="board">
<p class="eyebrow"><a href="/">← Back to board</a></p>
<h1>Track Record</h1>
<div class="stats-grid" id="stats-grid"><p class="empty-state">Loading…</p></div>
<h2>Ungraded picks</h2>
<div id="ungraded-list"><p class="empty-state">Loading…</p></div>
<h2>Recently graded</h2>
<div id="graded-list"><p class="empty-state">Loading…</p></div>
</div>
<script>
function fmtPct(x){return x==null?"—":(x*100).toFixed(1)+"%"}
function fmtAmerican(n){return n>0?"+"+n:""+n}
function escapeHtml(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML}

async function loadStats(){
  const s = await fetch("/api/track-record").then(r=>r.json());
  const grid = document.getElementById("stats-grid");
  if(!s.gradedCount){ grid.innerHTML = '<p class="empty-state">No graded picks yet — grade some below once games finish.</p>'; return; }
  grid.innerHTML = [
    ["Graded picks", s.gradedCount],
    ["Hit rate", fmtPct(s.hitRate)],
    ["Avg modeled probability", fmtPct(s.avgModeledProbability)],
    ["Avg modeled EV", fmtPct(s.avgEvPerDollar)],
    ["Realized EV per $1", fmtPct(s.realizedEvPerDollar)],
  ].map(([label,val]) => '<div class="stat"><div class="stat-num">'+val+'</div><div class="stat-label">'+label+'</div></div>').join("");
}

async function loadUngraded(){
  const picks = await fetch("/api/picks?status=ungraded&limit=15").then(r=>r.json());
  const el = document.getElementById("ungraded-list");
  if(!picks.length){ el.innerHTML = '<p class="empty-state">Nothing to grade — everything logged so far is graded, or no scans have run yet.</p>'; return; }
  el.innerHTML = "";
  picks.forEach(pick => {
    const card = document.createElement("div");
    card.className = "pick-card";
    const legsHtml = pick.legs.map(l => 
      '<div class="leg-row"><span class="leg-name">'+escapeHtml(l.player+" "+l.side+" "+(l.point??"")+" — "+l.matchup)+'</span>'+
      '<span class="leg-btns" data-leg="'+l.id+'">'+
        '<button data-call="win">Win</button><button data-call="loss">Loss</button><button data-call="push">Push</button>'+
      '</span></div>'
    ).join("");
    card.innerHTML = '<div class="pick-head"><span>'+new Date(pick.generatedAt).toLocaleString()+'</span><span>'+fmtAmerican(pick.combinedAmerican)+' · modeled '+fmtPct(pick.trueProbability)+'</span></div>'+legsHtml+'<button class="save-btn">Save grade</button>';
    const calls = {};
    card.querySelectorAll(".leg-btns").forEach(group => {
      const legId = group.dataset.leg;
      group.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          calls[legId] = btn.dataset.call;
          group.querySelectorAll("button").forEach(b => b.className = "");
          btn.className = "active-" + btn.dataset.call;
        });
      });
    });
    card.querySelector(".save-btn").addEventListener("click", async () => {
      if(!Object.keys(calls).length){ alert("Mark at least one leg first."); return; }
      await fetch("/api/picks/"+pick.id+"/grade", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({legResults: calls}) });
      loadUngraded(); loadStats(); loadGraded();
    });
    el.appendChild(card);
  });
}

async function loadGraded(){
  const picks = await fetch("/api/picks?status=graded&limit=15").then(r=>r.json());
  const el = document.getElementById("graded-list");
  if(!picks.length){ el.innerHTML = '<p class="empty-state">Nothing graded yet.</p>'; return; }
  el.innerHTML = picks.map(pick => 
    '<div class="pick-card"><div class="pick-head"><span>'+new Date(pick.generatedAt).toLocaleString()+'</span>'+
    '<span class="result-tag '+pick.result+'">'+pick.result.toUpperCase()+'</span></div>'+
    '<div style="color:var(--text-muted);font-size:.85rem">'+fmtAmerican(pick.combinedAmerican)+' · modeled '+fmtPct(pick.trueProbability)+' · '+pick.legs.length+' legs</div></div>'
  ).join("");
}

loadStats(); loadUngraded(); loadGraded();
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`Prop scanner running on port ${PORT}`);
});

