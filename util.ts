import { readFileSync } from "node:fs";
import path from "node:path";
import { Client, type QueryResult } from "pg";

export type ShowConfig = {
  name: string;
  season: number;
  url: string;
  imagesUrl?: string;
  weeks?: number;
};

// Fallback Season 27 defaults when a show has no episodes/contestants yet
export const DEFAULT_WEEKS = 10;
export const SCORING_PRESETS: Record<
  number,
  { expected: number[]; multiplier: number[] }
> = {
  6: {
    expected: [14, 10, 7, 4, 2, 1],
    multiplier: [2, 3, 4, 7, 15, 31],
  },
  7: {
    expected: [16, 12, 9, 6, 4, 2, 1],
    multiplier: [2, 3, 4, 6, 9, 17, 35],
  },
  8: {
    expected: [18, 14, 10, 7, 4, 3, 2, 1],
    multiplier: [2, 3, 4, 5, 10, 13, 20, 40],
  },
  9: {
    expected: [18, 15, 12, 9, 7, 4, 3, 2, 1],
    multiplier: [2, 2, 3, 4, 5, 10, 13, 20, 40],
  },
  10: {
    expected: [20, 17, 14, 11, 9, 7, 4, 3, 2, 1],
    multiplier: [2, 2, 3, 4, 5, 6, 11, 14, 22, 44],
  },
  11: {
    expected: [22, 19, 16, 13, 11, 9, 7, 4, 3, 2, 1],
    multiplier: [2, 2, 3, 3, 4, 5, 7, 12, 16, 24, 48],
  },
  12: {
    expected: [24, 21, 18, 15, 13, 11, 9, 7, 4, 3, 2, 1],
    multiplier: [2, 2, 3, 3, 4, 5, 6, 7, 13, 17, 26, 53],
  },
};

const dbUrl =
  process.env.DATABASE_URL || "postgres://localhost:5432/fantasytv";
let singleClient: Promise<Client> | null = null;

export function getDBClient() {
  // Cache the promise so concurrent first calls share one connection
  singleClient ??= (async () => {
    const client = new Client(dbUrl);
    await client.connect();
    return client;
  })();
  return singleClient;
}

export async function withTransaction<T>(
  client: Client,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function upsertObject(
  postgres: Client,
  table: string,
  object: any,
  conflict?: any,
): Promise<QueryResult<any>> {
  const columns = Object.keys(object);
  const values = Object.values(object);
  const conflictQ = conflict
    ? `
  ON CONFLICT (${Object.keys(conflict)
    .map((k) => `"${k}"`)
    .join(",")})
  DO UPDATE SET ${Object.keys(object)
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(",")}
  `
    : "";
  let query = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(",")})
    VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")})
    ${conflictQ}
    RETURNING *`;
  const result = await postgres.query(query, values);
  return result;
}

export function loadShowsConfig(): ShowConfig[] {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "shows.json"), "utf8"),
  );
}

export async function getShowIdForLeague(
  client: Client,
  leagueId: number,
): Promise<number | null> {
  const res = await client.query("SELECT show_id FROM league WHERE id = $1", [
    leagueId,
  ]);
  return res.rows[0]?.show_id ?? null;
}

export async function getShowScoringConfig(
  client: Client,
  showId: number | null,
): Promise<{ expected: number[]; multiplier: number[] }> {
  if (!showId) {
    return SCORING_PRESETS[DEFAULT_WEEKS];
  }
  const showRes = await client.query(
    "SELECT name, season FROM show WHERE id = $1",
    [showId],
  );
  const show = showRes.rows[0];
  if (!show) {
    return SCORING_PRESETS[DEFAULT_WEEKS];
  }
  const config = loadShowsConfig().find(
    (s) => s.name === show.name && s.season === Number(show.season),
  );
  const weeks = config?.weeks ?? DEFAULT_WEEKS;
  return SCORING_PRESETS[weeks] ?? SCORING_PRESETS[DEFAULT_WEEKS];
}

export async function getScoredPicks(client: Client, leagueId: number) {
  const showId = await getShowIdForLeague(client, leagueId);
  const { multiplier } = await getShowScoringConfig(client, showId);
  const check = await client.query(
    `SELECT pick.contestant_id,
            pick.episode_id,
            episode.name AS episode_name,
            episode.num,
            contestant.eliminated_week,
            pick.is_on AS guess,
            pick.uid
     FROM pick
     JOIN episode ON episode.id = pick.episode_id
     JOIN contestant ON contestant.id = pick.contestant_id
     WHERE pick.league_id = $1`,
    [leagueId],
  );
  return check.rows.map((row) => {
    const weekNum = Number(row.episode_name?.match(/Week (\d+)/)?.[1]);
    const survived =
      row.eliminated_week === null ||
      (weekNum >= 1 && row.eliminated_week > weekNum);
    const mult = weekNum >= 1 ? (multiplier[weekNum - 1] ?? 0) : 0;
    const points = row.guess === true ? (survived ? mult : -mult) : 0;
    return { ...row, points };
  });
}

const pacificFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function getPacificParts(date: Date) {
  const map: Record<string, number> = {};
  for (const p of pacificFormatter.formatToParts(date)) {
    if (p.type !== "literal") {
      map[p.type] = Number(p.value);
    }
  }
  return map;
}

export function pacificTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): number {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let targetMs = desiredUtc + 8 * 3600_000;
  for (let i = 0; i < 2; i++) {
    const p = getPacificParts(new Date(targetMs));
    const shownUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour % 24,
      p.minute,
      p.second,
    );
    targetMs += desiredUtc - shownUtc;
  }
  return targetMs;
}
