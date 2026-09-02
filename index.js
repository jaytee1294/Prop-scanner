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

/* ────────────────────────────────────────────────────────────────────────
   WEATHER
   Attaches game-time weather to legs for outdoor MLB/NFL games via
   Open-Meteo (free, no API key). Domed and retractable-roof stadiums are
   marked indoor and skipped — we can't know actual roof state from odds
   data alone, so the safe assumption for those is "don't claim weather
   context we don't actually have." This is informational only: it is
   NOT folded into the probability math, since that effect hasn't been
   validated against real outcomes yet (see the track record page).
──────────────────────────────────────────────────────────────────────── */

// lat/lon = home city, approximate (sufficient for hourly forecast purposes).
// indoor: true for fixed domes AND retractable roofs (roof state at game
// time is unknown to us, so these are excluded from weather context).
const VENUES = {
  // MLB
  "New York Yankees": { lat: 40.83, lon: -73.93, indoor: false },
  "Boston Red Sox": { lat: 42.35, lon: -71.10, indoor: false },
  "Toronto Blue Jays": { lat: 43.64, lon: -79.39, indoor: true },
  "Baltimore Orioles": { lat: 39.28, lon: -76.62, indoor: false },
  "Tampa Bay Rays": { lat: 27.77, lon: -82.65, indoor: true },
  "Chicago White Sox": { lat: 41.83, lon: -87.63, indoor: false },
  "Cleveland Guardians": { lat: 41.50, lon: -81.69, indoor: false },
  "Detroit Tigers": { lat: 42.34, lon: -83.05, indoor: false },
  "Kansas City Royals": { lat: 39.05, lon: -94.48, indoor: false },
  "Minnesota Twins": { lat: 44.98, lon: -93.28, indoor: false },
  "Houston Astros": { lat: 29.76, lon: -95.36, indoor: true },
  "Los Angeles Angels": { lat: 33.80, lon: -117.88, indoor: false },
  Athletics: { lat: 38.58, lon: -121.51, indoor: false },
  "Oakland Athletics": { lat: 38.58, lon: -121.51, indoor: false },
  "Seattle Mariners": { lat: 47.59, lon: -122.33, indoor: true },
  "Texas Rangers": { lat: 32.75, lon: -97.08, indoor: true },
  "Atlanta Braves": { lat: 33.89, lon: -84.47, indoor: false },
  "Miami Marlins": { lat: 25.78, lon: -80.22, indoor: true },
  "New York Mets": { lat: 40.76, lon: -73.85, indoor: false },
  "Philadelphia Phillies": { lat: 39.91, lon: -75.17, indoor: false },
  "Washington Nationals": { lat: 38.87, lon: -77.01, indoor: false },
  "Chicago Cubs": { lat: 41.95, lon: -87.66, indoor: false },
  "Cincinnati Reds": { lat: 39.10, lon: -84.51, indoor: false },
  "Milwaukee Brewers": { lat: 43.03, lon: -87.97, indoor: true },
  "Pittsburgh Pirates": { lat: 40.45, lon: -80.01, indoor: false },
  "St. Louis Cardinals": { lat: 38.63, lon: -90.19, indoor: false },
  "Arizona Diamondbacks": { lat: 33.45, lon: -112.07, indoor: true },
  "Colorado Rockies": { lat: 39.76, lon: -104.99, indoor: false },
  "Los Angeles Dodgers": { lat: 34.07, lon: -118.24, indoor: false },
  "San Diego Padres": { lat: 32.71, lon: -117.16, indoor: false },
  "San Francisco Giants": { lat: 37.78, lon: -122.39, indoor: false },
  // NFL
  "Buffalo Bills": { lat: 42.77, lon: -78.79, indoor: false },
  "Miami Dolphins": { lat: 25.96, lon: -80.24, indoor: false },
  "New England Patriots": { lat: 42.09, lon: -71.26, indoor: false },
  "New York Jets": { lat: 40.81, lon: -74.07, indoor: false },
  "New York Giants": { lat: 40.81, lon: -74.07, indoor: false },
  "Baltimore Ravens": { lat: 39.28, lon: -76.62, indoor: false },
  "Cincinnati Bengals": { lat: 39.10, lon: -84.52, indoor: false },
  "Cleveland Browns": { lat: 41.51, lon: -81.70, indoor: false },
  "Pittsburgh Steelers": { lat: 40.45, lon: -80.02, indoor: false },
  "Houston Texans": { lat: 29.68, lon: -95.41, indoor: true },
  "Indianapolis Colts": { lat: 39.76, lon: -86.16, indoor: true },
  "Jacksonville Jaguars": { lat: 30.32, lon: -81.64, indoor: false },
  "Tennessee Titans": { lat: 36.17, lon: -86.77, indoor: false },
  "Denver Broncos": { lat: 39.74, lon: -105.02, indoor: false },
  "Kansas City Chiefs": { lat: 39.05, lon: -94.48, indoor: false },
  "Las Vegas Raiders": { lat: 36.09, lon: -115.18, indoor: true },
  "Los Angeles Chargers": { lat: 33.95, lon: -118.34, indoor: true },
  "Dallas Cowboys": { lat: 32.75, lon: -97.09, indoor: true },
  "Philadelphia Eagles": { lat: 39.90, lon: -75.17, indoor: false },
  "Washington Commanders": { lat: 38.91, lon: -76.86, indoor: false },
  "Chicago Bears": { lat: 41.86, lon: -87.62, indoor: false },
  "Detroit Lions": { lat: 42.34, lon: -83.05, indoor: true },
  "Green Bay Packers": { lat: 44.50, lon: -88.06, indoor: false },
  "Minnesota Vikings": { lat: 44.97, lon: -93.26, indoor: true },
  "Atlanta Falcons": { lat: 33.76, lon: -84.40, indoor: true },
  "Carolina Panthers": { lat: 35.23, lon: -80.85, indoor: false },
  "New Orleans Saints": { lat: 29.95, lon: -90.08, indoor: true },
  "Tampa Bay Buccaneers": { lat: 27.98, lon: -82.50, indoor: false },
  "Arizona Cardinals": { lat: 33.53, lon: -112.26, indoor: true },
  "Los Angeles Rams": { lat: 33.95, lon: -118.34, indoor: true },
  "San Francisco 49ers": { lat: 37.40, lon: -121.97, indoor: false },
  "Seattle Seahawks": { lat: 47.60, lon: -122.33, indoor: false },
};

const WEATHER_SPORTS = new Set(["baseball_mlb", "americanfootball_nfl"]);

function getVenue(homeTeam, sportKey) {
  if (!WEATHER_SPORTS.has(sportKey)) return null;
  return VENUES[homeTeam] || null;
}

/** Fetch forecast for a venue and pick the hour closest to game time. Returns null on any failure — weather is a nice-to-have, never worth failing a scan over. */
async function fetchEventWeather(venue, commenceTimeIso) {
  try {
    const gameDate = new Date(commenceTimeIso);
    const dateStr = gameDate.toISOString().slice(0, 10);
    const params = new URLSearchParams({
      latitude: venue.lat,
      longitude: venue.lon,
      hourly: "temperature_2m,precipitation_probability,windspeed_10m",
      temperature_unit: "fahrenheit",
      windspeed_unit: "mph",
      timezone: "UTC",
      start_date: dateStr,
      end_date: dateStr,
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const times = data?.hourly?.time;
    if (!times || !times.length) return null;
    const targetMs = gameDate.getTime();
    let closestIdx = 0;
    let closestDiff = Infinity;
    times.forEach((t, i) => {
      const diff = Math.abs(new Date(t + "Z").getTime() - targetMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIdx = i;
      }
    });
    return {
      tempF: data.hourly.temperature_2m[closestIdx],
      windMph: data.hourly.windspeed_10m[closestIdx],
      precipProb: data.hourly.precipitation_probability[closestIdx],
    };
  } catch {
    return null;
  }
}

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
    const weatherText = leg.weather
      ? ` Game-time weather: ${Math.round(leg.weather.tempF)}°F, wind ${Math.round(leg.weather.windMph)}mph, ${Math.round(leg.weather.precipProb)}% precip chance — outdoor venue (informational only, not factored into the probability above).`
      : "";
    lines.push(
      `• ${leg.player} ${leg.side} ${leg.point ?? ""} ${marketLabel(leg.market)} (${leg.matchup}) — best price ${leg.bestAmerican > 0 ? "+" : ""}${leg.bestAmerican} at ${leg.bestBook}, ${leg.numBooks} books quoting it${
        leg.devigged
          ? `, de-vigged true probability ${(leg.trueProb * 100).toFixed(1)}% (${edgePct}% ${leg.edge >= 0 ? "better" : "worse"} than the market's own implied price)`
          : " (single-sided market — probability is vig-inclusive, not de-vigged)"
      }.${movementText}${weatherText}`
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

        const venue = getVenue(oddsData.home_team, sportKey);
        if (venue && !venue.indoor) {
          const weather = await fetchEventWeather(venue, oddsData.commence_time);
          if (weather) legs.forEach((l) => (l.weather = weather));
        }

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
<title>Longshot Board</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230d1720'/%3E%3Ctext x='16' y='23' font-family='Georgia,serif' font-size='20' font-weight='700' fill='%23f0a84e' text-anchor='middle'%3EL%3C/text%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet" />
<style>
:root{
  --ink:#0d1720; --ink-raised:#15222c; --ink-raised-2:#1b2b38;
  --hairline:#24343f; --hairline-bright:#37505f;
  --amber:#f0a84e; --amber-deep:#b97a2e; --amber-dim:#8a6640;
  --green:#7fcf9e; --red:#d97a6c;
  --text:#f1ece0; --text-dim:#8fa1ab;
  --serif:"Fraunces",Georgia,serif; --sans:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",monospace;
}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--ink);color:var(--text);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--amber)}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

.board{max-width:900px;margin:0 auto;padding:40px 20px 90px}

/* header: masthead + ticker line, no isolated giant stat block */
.masthead{display:flex;align-items:center;gap:12px}
.mark{width:34px;height:34px;flex-shrink:0;border-radius:7px;background:linear-gradient(155deg,var(--amber) 0%,var(--amber-deep) 100%);display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-weight:700;font-size:1.15rem;color:#12202a}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(1.7rem,4.6vw,2.35rem);margin:0;letter-spacing:-.01em}
.ticker{margin:14px 0 4px;color:var(--text-dim);font-size:.86rem;font-family:var(--mono);display:flex;flex-wrap:wrap;gap:6px 14px}
.ticker b{color:var(--amber);font-weight:600}
.dek{color:var(--text-dim);max-width:58ch;margin:14px 0 0;font-size:.95rem}
.dek a{white-space:nowrap}

/* controls: command-bar feel */
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:26px;padding:16px 18px;background:var(--ink-raised);border:1px solid var(--hairline);border-radius:10px}
.control-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sport-chip{position:relative;display:inline-flex;align-items:center;gap:7px;padding:6px 13px 6px 11px;border:1px solid var(--hairline-bright);border-radius:99px;font-size:.82rem;cursor:pointer;color:var(--text-dim);user-select:none;background:transparent;transition:background .15s,color .15s,border-color .15s}
.sport-chip .dot{width:6px;height:6px;border-radius:50%;background:var(--hairline-bright);transition:background .15s}
.sport-chip.active{border-color:var(--amber-deep);color:var(--text);background:rgba(240,168,78,.12)}
.sport-chip.active .dot{background:var(--amber)}
.control-target{display:flex;align-items:center;gap:8px}
.control-target label{font-size:.8rem;color:var(--text-dim)}
#target-odds{background:var(--ink);border:1px solid var(--hairline-bright);color:var(--amber);font-family:var(--mono);font-size:.88rem;padding:7px 10px;border-radius:6px;width:88px}
.scan-btn{background:var(--amber);color:#17222a;border:none;font-family:var(--sans);font-weight:600;font-size:.88rem;padding:10px 20px;border-radius:7px;cursor:pointer;margin-left:auto;box-shadow:0 1px 0 rgba(0,0,0,.2),0 0 0 1px rgba(240,168,78,.35);transition:transform .1s,box-shadow .15s}
.scan-btn:hover{box-shadow:0 1px 0 rgba(0,0,0,.2),0 0 20px rgba(240,168,78,.35),0 0 0 1px rgba(240,168,78,.5)}
.scan-btn:active{transform:translateY(1px)}
.scan-btn:disabled{opacity:.55;cursor:progress;box-shadow:none}
.scan-meta{color:var(--text-dim);font-size:.76rem;font-family:var(--mono)}

.results{margin-top:8px}
.empty-state{color:var(--text-dim);padding:56px 20px;text-align:center;border:1px dashed var(--hairline);border-radius:10px;margin-top:20px}

/* result rows: left accent bar, not identical bordered cards */
.parlay-row{display:flex;gap:18px;padding:20px 4px 20px 18px;border-left:2px solid var(--hairline);border-bottom:1px solid var(--hairline);position:relative}
.parlay-row.top{border-left:3px solid var(--amber);background:linear-gradient(90deg,rgba(240,168,78,.07),transparent 60%)}
.rank{font-family:var(--mono);font-weight:600;font-size:.95rem;color:var(--text-dim);width:26px;flex-shrink:0;padding-top:3px}
.parlay-row.top .rank{color:var(--amber)}
.parlay-body{flex:1;min-width:0}
.parlay-row.top h3{font-size:1.35rem}
h3{font-family:var(--serif);font-weight:600;font-size:1.1rem;margin:0 0 10px;color:var(--text)}
.leg-list{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:3px}
.leg-list li{font-size:.85rem;color:var(--text-dim)}
.leg-list li b{color:var(--text);font-weight:500}
.toggle-detail{background:none;border:none;color:var(--amber);font-size:.8rem;cursor:pointer;padding:0;font-family:var(--sans);font-weight:500}
.parlay-detail{display:none;margin-top:12px;padding:14px 16px;background:var(--ink-raised);border-radius:8px;border:1px solid var(--hairline);white-space:pre-line;font-size:.84rem;color:var(--text-dim)}
.parlay-detail.open{display:block}
.parlay-figures{text-align:right;flex-shrink:0;padding-top:2px}
.odds-figure{font-family:var(--mono);font-weight:600;font-size:1.3rem;color:var(--amber)}
.parlay-row.top .odds-figure{font-size:1.7rem}
.ev-tag{display:inline-block;margin-top:6px;font-size:.72rem;font-family:var(--mono);padding:2px 7px;border-radius:4px}
.ev-tag.pos{color:var(--green);background:rgba(127,207,158,.1)}
.ev-tag.neg{color:var(--red);background:rgba(217,122,108,.1)}

.board-foot{margin-top:36px;color:var(--text-dim);font-size:.78rem;max-width:65ch;line-height:1.6}

@media (max-width:620px){
  .parlay-row{padding-left:12px;gap:12px}
  .parlay-figures{text-align:left}
}
</style>
</head>
<body>
<div class="board">
<header>
<div class="masthead"><div class="mark">L</div><h1>Longshot Board</h1></div>
<p class="ticker" id="ticker-line"><span>Live player-prop scan · press Scan market to start</span></p>
<p class="dek">Pulls live prop lines, de-vigs every two-sided market for a true probability estimate, then ranks parlays near your target price by modeled edge — not by which one simply pays the most. <a href="/history">Track record & grade picks →</a></p>
</header>

<section class="controls">
<div class="control-group" id="sport-toggles" aria-label="Sports to include"></div>
<div class="control-target"><label for="target-odds">Target</label><input type="text" id="target-odds" value="+1000" /></div>
<button id="scan-btn" class="scan-btn">Scan market</button>
</section>
<p class="scan-meta" id="scan-meta" style="margin-top:10px"></p>

<main id="results" class="results" aria-live="polite"><p class="empty-state">Press "Scan market" to pull today's props and build the board.</p></main>

<footer class="board-foot"><p>Modeled EV assumes independent legs and de-vigged consensus pricing. Longshot parlays are volume products for sportsbooks — even the best-ranked combo here is very likely still negative EV. Treat this as a research ranking, not a guarantee.</p></footer>
</div>

<script>
const sportTogglesEl=document.getElementById("sport-toggles"),resultsEl=document.getElementById("results"),scanBtn=document.getElementById("scan-btn"),scanMetaEl=document.getElementById("scan-meta"),tickerEl=document.getElementById("ticker-line"),targetOddsInput=document.getElementById("target-odds");
let activeSports=new Set();

async function loadSports(){
  const sports=await fetch("/api/sports").then(r=>r.json());
  sportTogglesEl.innerHTML="";
  sports.forEach(({key,label})=>{
    activeSports.add(key);
    const chip=document.createElement("span");
    chip.className="sport-chip active";
    chip.innerHTML='<span class="dot"></span>'+label;
    chip.dataset.key=key;
    chip.addEventListener("click",()=>{
      if(activeSports.has(key)){activeSports.delete(key);chip.classList.remove("active")}
      else{activeSports.add(key);chip.classList.add("active")}
    });
    sportTogglesEl.appendChild(chip);
  });
}

function parseTargetOdds(raw){const n=parseInt(raw.replace(/[^0-9-]/g,""),10);return Number.isFinite(n)?Math.abs(n):1000}
function formatAmerican(n){return n>0?"+"+n:""+n}
function escapeHtml(str){const div=document.createElement("div");div.textContent=str;return div.innerHTML}

function renderParlays(parlays){
  resultsEl.innerHTML="";
  if(!parlays.length){
    resultsEl.innerHTML='<p class="empty-state">No combos landed near that target with the current pool. Try widening the target odds or adding more sports.</p>';
    return;
  }
  parlays.forEach((p,i)=>{
    const row=document.createElement("article");
    row.className="parlay-row"+(i===0?" top":"");
    const legsHtml=p.legs.map(l=>'<li><b>'+escapeHtml(l.player)+'</b> '+escapeHtml(l.side+' '+(l.point??''))+'</li>').join("");
    const evPct=(p.evPerDollar*100).toFixed(1);
    const evClass=p.evPerDollar>=-0.05?"pos":"neg";
    row.innerHTML=
      '<div class="rank">'+String(i+1).padStart(2,"0")+'</div>'+
      '<div class="parlay-body">'+
        '<h3>'+p.legs.length+'-leg parlay</h3>'+
        '<ul class="leg-list">'+legsHtml+'</ul>'+
        '<button class="toggle-detail">Show research</button>'+
        '<div class="parlay-detail">'+escapeHtml(p.explanation)+'</div>'+
      '</div>'+
      '<div class="parlay-figures">'+
        '<div class="odds-figure">'+formatAmerican(p.combinedAmerican)+'</div>'+
        '<div class="ev-tag '+evClass+'">'+(evPct>=0?"+":"")+evPct+'% EV</div>'+
      '</div>';
    row.querySelector(".toggle-detail").addEventListener("click",(e)=>{
      const detail=row.querySelector(".parlay-detail");
      const open=detail.classList.toggle("open");
      e.target.textContent=open?"Hide research":"Show research";
    });
    resultsEl.appendChild(row);
  });
}

async function scan(){
  if(!activeSports.size){scanMetaEl.textContent="Select at least one sport.";return}
  scanBtn.disabled=true;scanBtn.textContent="Scanning…";
  resultsEl.innerHTML='<p class="empty-state">Pulling live prop lines and building combos…</p>';
  const target=parseTargetOdds(targetOddsInput.value);
  const sportsParam=[...activeSports].join(",");
  try{
    const res=await fetch("/api/scan?sports="+sportsParam+"&target="+target);
    const data=await res.json();
    if(data.error){
      resultsEl.innerHTML='<p class="empty-state">'+escapeHtml(data.error)+'</p>';
      tickerEl.innerHTML='<span>—</span>';
      return;
    }
    if(data.message){resultsEl.innerHTML='<p class="empty-state">'+escapeHtml(data.message)+'</p>'}
    else{renderParlays(data.parlays)}
    const count=data.parlays?data.parlays.length:0;
    const scanned=data.scanned||{};
    tickerEl.innerHTML='<span><b>'+count+'</b> parlays found</span><span>'+(scanned.events??0)+' events scanned</span><span>'+(scanned.legsFound??0)+' legs found</span>'+(data.cached?'<span>cached</span>':'<span>live</span>');
    scanMetaEl.textContent="";
  }catch(err){
    resultsEl.innerHTML='<p class="empty-state">Scan failed: '+escapeHtml(err.message)+'</p>';
  }finally{
    scanBtn.disabled=false;scanBtn.textContent="Scan market";
  }
}

scanBtn.addEventListener("click",scan);
loadSports();
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230d1720'/%3E%3Ctext x='16' y='23' font-family='Georgia,serif' font-size='20' font-weight='700' fill='%23f0a84e' text-anchor='middle'%3EL%3C/text%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet" />
<style>
:root{
  --ink:#0d1720; --ink-raised:#15222c; --hairline:#24343f; --hairline-bright:#37505f;
  --amber:#f0a84e; --amber-deep:#b97a2e;
  --green:#7fcf9e; --red:#d97a6c;
  --text:#f1ece0; --text-dim:#8fa1ab;
  --serif:"Fraunces",Georgia,serif; --sans:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",monospace;
}
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;background:var(--ink);color:var(--text);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--amber);font-size:.85rem}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

.board{max-width:900px;margin:0 auto;padding:40px 20px 90px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(1.6rem,4.4vw,2.1rem);margin:14px 0 20px}
h2{font-family:var(--serif);font-size:1.05rem;font-weight:600;margin:34px 0 14px;color:var(--text)}

/* calibration strip: one continuous ticker row, not a grid of identical boxes */
.calibration{display:flex;flex-wrap:wrap;gap:0;background:var(--ink-raised);border:1px solid var(--hairline);border-radius:10px;overflow:hidden}
.calibration .cell{flex:1;min-width:140px;padding:16px 18px;border-right:1px solid var(--hairline)}
.calibration .cell:last-child{border-right:none}
.cell .num{font-family:var(--mono);font-weight:600;font-size:1.35rem;color:var(--amber)}
.cell .lbl{color:var(--text-dim);font-size:.75rem;margin-top:4px}
.empty-state{color:var(--text-dim);padding:22px 4px}

.pick-row{display:flex;gap:14px;padding:16px 4px 16px 14px;border-left:2px solid var(--hairline);border-bottom:1px solid var(--hairline)}
.pick-row.win{border-left-color:var(--green)}
.pick-row.loss{border-left-color:var(--red)}
.pick-row.push{border-left-color:var(--amber-deep)}
.pick-body{flex:1;min-width:0}
.pick-meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--text-dim);font-size:.78rem;font-family:var(--mono);margin-bottom:8px}
.leg-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--hairline);font-size:.87rem}
.leg-row:first-of-type{border-top:none}
.leg-btns{display:flex;gap:6px;flex-shrink:0}
.leg-btns button{background:none;border:1px solid var(--hairline-bright);color:var(--text-dim);font-size:.72rem;padding:4px 10px;border-radius:99px;cursor:pointer;font-family:var(--sans)}
.leg-btns button.active-win{border-color:var(--green);color:var(--green);background:rgba(127,207,158,.1)}
.leg-btns button.active-loss{border-color:var(--red);color:var(--red);background:rgba(217,122,108,.1)}
.leg-btns button.active-push{border-color:var(--amber-deep);color:var(--amber);background:rgba(240,168,78,.1)}
.save-btn{margin-top:12px;background:var(--amber);color:#17222a;border:none;font-weight:600;font-size:.82rem;padding:8px 16px;border-radius:7px;cursor:pointer;font-family:var(--sans)}
.result-tag{font-family:var(--mono);font-size:.72rem;padding:2px 8px;border-radius:4px;flex-shrink:0;align-self:flex-start}
.result-tag.win{color:var(--green);background:rgba(127,207,158,.1)}
.result-tag.loss{color:var(--red);background:rgba(217,122,108,.1)}
.result-tag.push{color:var(--amber);background:rgba(240,168,78,.1)}
</style>
</head>
<body>
<div class="board">
<p><a href="/">← Back to board</a></p>
<h1>Track record</h1>
<div class="calibration" id="stats-grid"><p class="empty-state">Loading…</p></div>
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
    [s.gradedCount, "Graded picks"],
    [fmtPct(s.hitRate), "Hit rate"],
    [fmtPct(s.avgModeledProbability), "Avg modeled probability"],
    [fmtPct(s.avgEvPerDollar), "Avg modeled EV"],
    [fmtPct(s.realizedEvPerDollar), "Realized EV per $1"],
  ].map(([num,lbl]) => '<div class="cell"><div class="num">'+num+'</div><div class="lbl">'+lbl+'</div></div>').join("");
}

async function loadUngraded(){
  const picks = await fetch("/api/picks?status=ungraded&limit=15").then(r=>r.json());
  const el = document.getElementById("ungraded-list");
  if(!picks.length){ el.innerHTML = '<p class="empty-state">Nothing to grade — everything logged so far is graded, or no scans have run yet.</p>'; return; }
  el.innerHTML = "";
  picks.forEach(pick => {
    const row = document.createElement("div");
    row.className = "pick-row";
    const legsHtml = pick.legs.map(l =>
      '<div class="leg-row"><span>'+escapeHtml(l.player+" "+l.side+" "+(l.point??"")+" — "+l.matchup)+'</span>'+
      '<span class="leg-btns" data-leg="'+l.id+'">'+
        '<button data-call="win">Win</button><button data-call="loss">Loss</button><button data-call="push">Push</button>'+
      '</span></div>'
    ).join("");
    row.innerHTML = '<div class="pick-body"><div class="pick-meta"><span>'+new Date(pick.generatedAt).toLocaleString()+'</span><span>'+fmtAmerican(pick.combinedAmerican)+'</span><span>modeled '+fmtPct(pick.trueProbability)+'</span></div>'+legsHtml+'<button class="save-btn">Save grade</button></div>';
    const calls = {};
    row.querySelectorAll(".leg-btns").forEach(group => {
      const legId = group.dataset.leg;
      group.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          calls[legId] = btn.dataset.call;
          group.querySelectorAll("button").forEach(b => b.className = "");
          btn.className = "active-" + btn.dataset.call;
        });
      });
    });
    row.querySelector(".save-btn").addEventListener("click", async () => {
      if(!Object.keys(calls).length){ alert("Mark at least one leg first."); return; }
      await fetch("/api/picks/"+pick.id+"/grade", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({legResults: calls}) });
      loadUngraded(); loadStats(); loadGraded();
    });
    el.appendChild(row);
  });
}

async function loadGraded(){
  const picks = await fetch("/api/picks?status=graded&limit=15").then(r=>r.json());
  const el = document.getElementById("graded-list");
  if(!picks.length){ el.innerHTML = '<p class="empty-state">Nothing graded yet.</p>'; return; }
  el.innerHTML = picks.map(pick =>
    '<div class="pick-row '+pick.result+'"><div class="pick-body"><div class="pick-meta"><span>'+new Date(pick.generatedAt).toLocaleString()+'</span><span>'+fmtAmerican(pick.combinedAmerican)+'</span><span>modeled '+fmtPct(pick.trueProbability)+'</span><span>'+pick.legs.length+' legs</span></div></div><span class="result-tag '+pick.result+'">'+pick.result.toUpperCase()+'</span></div>'
  ).join("");
}

loadStats(); loadUngraded(); loadGraded();
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`Prop scanner running on port ${PORT}`);
});


