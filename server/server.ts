import express from "express";
import { Client, type QueryResult } from "pg";
import cors from "cors";
import * as cheerio from "cheerio";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { OAuth2Client, type TokenPayload } from "google-auth-library";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client();
// Fallback Season 27 defaults when a show has no episodes/contestants yet
const DEFAULT_WEEKS = 10;
const SCORING_PRESETS: Record<
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

// Verifies the Google ID token from the client and records the account
async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (process.env.NODE_ENV !== "production" && token === "test-alice") {
    res.locals.uid = "test-alice";
    next();
    return;
  }
  // Without an audience, tokens issued to any Google app would be accepted
  if (!googleClientId) {
    res.status(500).json({ error: "GOOGLE_CLIENT_ID is not set" });
    return;
  }
  let decoded: TokenPayload | undefined;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: googleClientId,
    });
    decoded = ticket.getPayload();
  } catch (e) {}
  if (!decoded) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  const client = await getDBClient();
  await upsertObject(
    client,
    "account",
    {
      uid: decoded.sub,
      name: decoded.name || "",
      email: decoded.email || "",
      img: decoded.picture || "",
    },
    { uid: true },
  );
  res.locals.uid = decoded.sub;
  next();
}

const dbUrl =
  (process.env.DATABASE_URL || "postgres://localhost:5432") + "/fantasytv";
// Declared before the top-level awaits below, so requests served during startup can use it
let singleClient: Promise<Client> | null = null;

const app = express();
app.use(express.static("./build"));
app.use(cors());
app.use(express.json());
app.all("/rescore", async (req, res) => {
  await rescore();
  res.json({});
});
async function resolveLeagueId(
  client: Client,
  req: express.Request,
): Promise<number> {
  const raw = Number(req.query.league);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  const latest = await client.query(
    "SELECT id FROM league ORDER BY id DESC LIMIT 1",
  );
  return latest.rows[0]?.id ?? 1;
}

async function getShowIdForLeague(
  client: Client,
  leagueId: number,
): Promise<number | null> {
  const res = await client.query("SELECT show_id FROM league WHERE id = $1", [
    leagueId,
  ]);
  return res.rows[0]?.show_id ?? null;
}

app.get("/leagues", async (req, res) => {
  const client = await getDBClient();
  const result = await client.query(
    `SELECT league.id, league.name, league.show_id, show.name AS show_name, show.season, show.lead, show.poster,
            EXISTS (SELECT 1 FROM episode WHERE episode.show_id = league.show_id) AS has_episodes,
            (SELECT MAX(airdate) FROM episode WHERE episode.show_id = league.show_id) AS latest_airdate
     FROM league
     LEFT JOIN show ON show.id = league.show_id
     ORDER BY league.id`,
  );
  return res.json(result.rows);
});
app.get("/shows", async (req, res) => {
  const client = await getDBClient();
  if (req.query.league !== undefined) {
    const showId = await getShowIdForLeague(
      client,
      await resolveLeagueId(client, req),
    );
    const result = showId
      ? await client.query("SELECT * from show WHERE id = $1", [showId])
      : { rows: [] };
    return res.json(result.rows);
  }
  const result = await client.query(
    `SELECT show.*,
            (SELECT id FROM league WHERE league.show_id = show.id ORDER BY id ASC LIMIT 1) AS default_league_id,
            EXISTS (SELECT 1 FROM episode WHERE episode.show_id = show.id) AS has_episodes,
            (SELECT MAX(airdate) FROM episode WHERE episode.show_id = show.id) AS latest_airdate
     FROM show
     ORDER BY has_episodes ASC, latest_airdate DESC NULLS LAST, show.id DESC`,
  );
  return res.json(result.rows);
});
app.get("/contestants", async (req, res) => {
  const client = await getDBClient();
  if (req.query.league !== undefined) {
    const showId = await getShowIdForLeague(
      client,
      await resolveLeagueId(client, req),
    );
    const result = showId
      ? await client.query("SELECT * from contestant WHERE show_id = $1", [
          showId,
        ])
      : { rows: [] };
    return res.json(result.rows);
  }
  const result = await client.query("SELECT * from contestant");
  return res.json(result.rows);
});
app.get("/bracket", async (req, res) => {
  const client = await getDBClient();
  const result = await client.query("SELECT * from bracket");
  return res.json(result.rows);
});
app.get("/episodes", async (req, res) => {
  const client = await getDBClient();
  let result;
  if (req.query.league !== undefined) {
    const showId = await getShowIdForLeague(
      client,
      await resolveLeagueId(client, req),
    );
    result = showId
      ? await client.query(
          "SELECT * from episode WHERE show_id = $1 ORDER BY num",
          [showId],
        )
      : { rows: [] };
  } else {
    result = await client.query("SELECT * from episode ORDER BY num");
  }
  const rows = result.rows.map((ep) => {
    const lockMs = ep.airdate ? getEpisodeLockTimeMs(ep.airdate) : null;
    const revealMs = ep.airdate ? getEpisodeRevealTimeMs(ep.airdate) : null;
    return {
      ...ep,
      lock_time: lockMs !== null ? new Date(lockMs).toISOString() : null,
      locked: lockMs !== null ? Date.now() >= lockMs : false,
      revealed: revealMs !== null ? Date.now() >= revealMs : false,
    };
  });
  return res.json(rows);
});
app.get("/config", async (req, res) => {
  const client = await getDBClient();
  const leagueId = await resolveLeagueId(client, req);
  const showId = await getShowIdForLeague(client, leagueId);
  res.json(await getShowScoringConfig(client, showId));
});
app.get("/contestantStatus", async (req, res) => {
  // Join the data to get the clean contestant status, currently not stored in table but we have one
  const client = await getDBClient();
  const showId =
    req.query.league !== undefined
      ? await getShowIdForLeague(client, await resolveLeagueId(client, req))
      : undefined;
  res.json(await getContestantStatus(showId));
});
app.get("/picks", requireAuth, async (req, res) => {
  const client = await getDBClient();
  const leagueId = await resolveLeagueId(client, req);
  const result = await client.query(
    `SELECT * from pick WHERE uid = $1 AND league_id = $2`,
    [res.locals.uid, leagueId],
  );
  res.json(result.rows);
});
app.post("/picks", requireAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    res.status(400).json({ error: "Expected an array of picks" });
    return;
  }
  const client = await getDBClient();
  const leagueId = await resolveLeagueId(client, req);
  const txResult = await withTransaction(client, async () => {
    const showId = await getShowIdForLeague(client, leagueId);
    if (!showId) {
      return { error: `Unknown league ${leagueId}` };
    }
    const [epRes, contRes] = await Promise.all([
      client.query("SELECT id, name, airdate FROM episode WHERE show_id = $1", [
        showId,
      ]),
      client.query(
        "SELECT id, eliminated_week FROM contestant WHERE show_id = $1",
        [showId],
      ),
    ]);

    const epInfoById = new Map<
      number,
      { weekNum: number; locked: boolean }
    >();
    for (const ep of epRes.rows) {
      const match = ep.name?.match(/Week (\d+)/);
      if (match) {
        epInfoById.set(ep.id, {
          weekNum: Number(match[1]),
          locked: ep.airdate ? isEpisodeLocked(ep.airdate) : false,
        });
      }
    }
    const elimByContId = new Map<number, number | null>();
    for (const c of contRes.rows) {
      elimByContId.set(c.id, c.eliminated_week);
    }

    const sanitized: { episode_id: number; contestant_id: number; is_on: boolean }[] = [];
    for (const item of req.body) {
      const episode_id = Number(item?.episode_id);
      const contestant_id = Number(item?.contestant_id);
      const is_on = Boolean(item?.is_on);
      if (!Number.isInteger(episode_id) || !Number.isInteger(contestant_id)) {
        return { error: "Invalid episode_id or contestant_id" };
      }
      const epInfo = epInfoById.get(episode_id);
      if (!epInfo) {
        return { error: `Unknown or non-week episode ${episode_id}` };
      }
      if (epInfo.locked) {
        return {
          error: `Picks for Week ${epInfo.weekNum} are locked (8:00 PM PT on airdate)`,
        };
      }
      const weekNum = epInfo.weekNum;
      const elimWeek = elimByContId.get(contestant_id);
      if (elimWeek === undefined) {
        return { error: `Unknown contestant ${contestant_id}` };
      }
      if (is_on && elimWeek !== null && elimWeek < weekNum) {
        return {
          error: `Contestant ${contestant_id} was eliminated before Week ${weekNum}`,
        };
      }
      sanitized.push({ episode_id, contestant_id, is_on });
    }

    for (const { episode_id, contestant_id, is_on } of sanitized) {
      const pick = {
        league_id: leagueId,
        uid: res.locals.uid,
        episode_id,
        contestant_id,
        is_on,
      };
      await upsertObject(client, "pick", pick, {
        league_id: true,
        episode_id: true,
        uid: true,
        contestant_id: true,
      });
    }
    const updated = await client.query(
      `SELECT * from pick WHERE uid = $1 AND league_id = $2`,
      [res.locals.uid, leagueId],
    );
    return { rows: updated.rows };
  });

  if ("error" in txResult) {
    res.status(400).json({ error: txResult.error });
    return;
  }
  res.json(txResult.rows);
});
app.get("/leaderboard", async (req, res) => {
  const client = await getDBClient();
  const leagueId = await resolveLeagueId(client, req);
  const [accountsRes, scoredRows] = await Promise.all([
    client.query(
      `SELECT league_account.uid, league_account.score, account.name, account.img
       FROM league_account
       LEFT JOIN account ON account.uid = league_account.uid
       WHERE league_account.league_id = $1
       ORDER BY league_account.score DESC, account.name ASC`,
      [leagueId],
    ),
    getScoredPicks(client, leagueId),
  ]);
  const weeklyByUid: Record<string, Record<number, number>> = {};
  for (const row of scoredRows) {
    weeklyByUid[row.uid] ??= {};
    weeklyByUid[row.uid][row.episode_id] =
      (weeklyByUid[row.uid][row.episode_id] ?? 0) + row.points;
  }
  const rows = accountsRes.rows.map((row) => ({
    ...row,
    weekly_scores: weeklyByUid[row.uid] ?? {},
  }));
  res.json(rows);
});
// TODO allow admins to set unlocks
app.post("/league", async (req, res) => {
  res.status(403).json({ error: "League creation is disabled" });
  return;
  const showId = Number(req.body?.show_id ?? req.query.show_id);
  if (!Number.isInteger(showId) || showId <= 0) {
    res.status(400).json({ error: "Invalid or missing show_id" });
    return;
  }
  const client = await getDBClient();
  const showRes = await client.query("SELECT id FROM show WHERE id = $1", [
    showId,
  ]);
  if (showRes.rows.length === 0) {
    res.status(404).json({ error: `Unknown show ${showId}` });
    return;
  }
  const name = req.body?.name || "Default";
  const admins: string[] = Array.isArray(req.body?.admin_uids)
    ? req.body.admin_uids
    : [];
  const result = await upsertObject(client, "league", {
    show_id: showId,
    name,
    admin_uids: admins,
  });
  res.json(result.rows[0]);
});
const port = process.env.PORT || 3000;
const keyFile = process.env.SSL_KEY_FILE;
const certFile = process.env.SSL_CERT_FILE;
if (keyFile && certFile && existsSync(keyFile) && existsSync(certFile)) {
  https
    .createServer(
      { key: readFileSync(keyFile), cert: readFileSync(certFile) },
      app,
    )
    .listen(port);
} else {
  app.listen(port);
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

await rescore();
scheduleDailyRescore();

function getPacificParts(date: Date) {
  const map: Record<string, number> = {};
  for (const p of pacificFormatter.formatToParts(date)) {
    if (p.type !== "literal") {
      map[p.type] = Number(p.value);
    }
  }
  return map;
}

function pacificTimeToUtcMs(
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

function getEpisodePacificTimeMs(airdate: Date | string, hour: number): number {
  const d = new Date(airdate);
  return pacificTimeToUtcMs(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    hour,
    0,
    0,
  );
}

function getEpisodeLockTimeMs(airdate: Date | string): number {
  return getEpisodePacificTimeMs(airdate, 20);
}

function getEpisodeRevealTimeMs(airdate: Date | string): number {
  return getEpisodePacificTimeMs(airdate, 22);
}

function isEpisodeLocked(airdate: Date | string, now = Date.now()): boolean {
  return now >= getEpisodeLockTimeMs(airdate);
}

function msUntilNext10pmPacific(now = new Date()): number {
  const pt = getPacificParts(now);
  const addDays = pt.hour >= 22 ? 1 : 0;
  const targetMs = pacificTimeToUtcMs(pt.year, pt.month, pt.day + addDays, 22);
  return Math.max(1000, targetMs - now.getTime());
}

function scheduleDailyRescore() {
  const delay = msUntilNext10pmPacific();
  setTimeout(async () => {
    try {
      await rescore();
    } catch (err) {
      console.error("Daily rescore failed:", err);
    } finally {
      scheduleDailyRescore();
    }
  }, delay);
}

async function getContestantStatus(showId?: number | null) {
  if (showId === null) {
    return [];
  }
  const client = await getDBClient();
  const params: any[] = [];
  const where =
    showId !== undefined ? `WHERE raw_contestant_status.show_id = $1` : "";
  if (showId !== undefined) {
    params.push(showId);
  }
  const contestantStatus = await client.query(
    `
  SELECT contestant.id as contestant_id, 
  episode.id as episode_id,
  is_on
  FROM raw_contestant_status
  LEFT JOIN contestant on contestant.name = raw_contestant_status.name AND contestant.show_id = raw_contestant_status.show_id
  LEFT JOIN episode on raw_contestant_status.episode = episode.num AND raw_contestant_status.show_id = episode.show_id
  ${where}
`,
    params,
  );
  return contestantStatus.rows;
}

type ShowConfig = {
  name: string;
  season: number;
  url: string;
  imagesUrl?: string;
  weeks?: number;
};

function loadShowsConfig(): ShowConfig[] {
  return JSON.parse(readFileSync("./shows.json", "utf8"));
}

async function withTransaction<T>(
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

// Fetches cast images from the configured show imagesUrl (best-effort)
async function fetchContestantImages(
  imagesUrl?: string,
): Promise<{ [key: string]: string }> {
  const imgMap: { [key: string]: string } = {};
  if (!imagesUrl) {
    return imgMap;
  }
  try {
    const resp = await fetch(imagesUrl);
    if (!resp.ok) {
      return imgMap;
    }
    const contData: any = await resp.json();
    for (const tile of contData.tiles ?? []) {
      if (tile.person?.type === "Bachelorette") {
        const firstName = tile.person?.firstname?.trim();
        const imgUrl = tile.images?.[0]?.value;
        if (firstName && imgUrl) {
          imgMap[firstName] = imgUrl;
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch contestant images:", err);
  }
  return imgMap;
}

async function refetch() {
  const client = await getDBClient();
  const shows = loadShowsConfig();

  for (const { name, season, url, imagesUrl } of shows) {
    const [resp, imgMap] = await Promise.all([
      fetch(url),
      fetchContestantImages(imagesUrl),
    ]);
    const data = await resp.text();
    writeFileSync("./data/" + url.split("/").at(-1), data);

    const showId = await withTransaction(client, async () => {
      const showResult = await upsertObject(
        client,
        "show",
        { name, season },
        { name: true, season: true },
      );
      const id: number = showResult.rows[0].id;

      // Create default league for show if it doesn't already exist
      const existingLeague = await client.query(
        "SELECT id FROM league WHERE show_id = $1 LIMIT 1",
        [id],
      );
      if (existingLeague.rows.length === 0) {
        const defaultLeagueName = `${name}${season ? ` Season ${season}` : ""} (Default)`;
        await upsertObject(client, "league", {
          show_id: id,
          name: defaultLeagueName,
          admin_uids: [],
        });
      }

      return id;
    });

    await parseAndUpsertShowData(client, showId, data, imgMap);
  }
}

async function parseAndUpsertShowData(
  client: Client,
  showId: number,
  data: string,
  imgMap: { [key: string]: string } = {},
) {
  // Parse table data
  var $ = cheerio.load(data);

  // upsert episodes
  let ep_table = $("h2#Episodes").parent().nextAll("table").first();
  const eps: any[] = [];
  ep_table.find("tbody tr.module-episode-list-row").map((tr_index, el) => {
    // gets the cells value for the row; loops through each cell and returns an array of values
    // if (tr_index === 0) {
    //   // Skip header
    //   return;
    // }
    const row: any = { show_id: showId };
    $(el).find("td")
      .each((i, el) => {
        if (i === 0) {
          row["num"] = $(el).text().trim();
        } else if (i === 1) {
          row["name"] = $(el).text().trim();
        } else if (i === 2) {
          const airdate = $(el).text().split("(")[0].replace(/\xA0/g, " ");
          row["airdate"] = new Date(airdate);
        }
      });
      console.log(row);
      eps.push(row);
  });
  // targets the specific table with a selector
  var html_table = $("h2#Call-out_order").parent().next("table");
  const result: any[] = [];
  // gets table cell values; loops through all tr rows
  html_table.find("tbody tr").map((tr_index, el) => {
    const pass = [
      "turquoise",
      "skyblue",
      "gold",
      "orange",
      "limegreen",
      "thistle",
      undefined,
    ];
    $(el)
      .find("td")
      .each((i, el) => {
        const isPass = pass.includes($(el).attr("bgcolor"));
        for (const e of $(el).contents()) {
          const name = $(e).text().trim();
          // TODO Probably should check the name belongs to a contestant on the current season
          if (name) {
            const row = { show_id: showId, name, episode: i + 1, is_on: isPass };
            result.push(row);
          }
        }
      });
  });

  // Elimination week for each contestant, from the Contestants table
  // The call-out order uses short names (e.g. "Kaity", "Viktoria E."), so match full names to those
  const shortNames = result
    .filter((row) => row.episode === 1)
    .map((row) => row.name);
  const eliminations = parseEliminations($);
  const lead = parseLead($);
  const poster = parsePoster($);

  await withTransaction(client, async () => {
    if (lead || poster) {
      await client.query(
        "UPDATE show SET lead = COALESCE($1, lead), poster = COALESCE($2, poster) WHERE id = $3",
        [lead, poster, showId],
      );
    }
    for (let i = 0; i < eps.length; i++) {
      console.log(eps[i]);
      await upsertObject(client, "episode", eps[i], { show_id: true, num: true });
    }

    // Clear old rows so names from earlier parses don't linger
    await client.query("DELETE FROM raw_contestant_status WHERE show_id = $1", [
      showId,
    ]);
    for (let i = 0; i < result.length; i++) {
      console.log('raw_contestant_status', result[i]);
      await upsertObject(client, "raw_contestant_status", result[i], {
        show_id: true,
        name: true,
        episode: true,
      });
    }

    for (let i = 0; i < eliminations.length; i++) {
      const { fullName, week } = eliminations[i];
      const name = matchShortName(fullName, shortNames);
      const img = imgMap[name];
      console.log('contestant', fullName, name, week);
      await upsertObject(
        client,
        "contestant",
        { show_id: showId, name, eliminated_week: week },
        { show_id: true, name: true },
      );
      if (img) {
        await client.query(
          "UPDATE contestant SET img = $1 WHERE show_id = $2 AND name = $3 AND img IS NULL",
          [img, showId, name],
        );
      }
    }
  });
}

function parseLead($: ReturnType<typeof cheerio.load>): string | null {
  let lead: string | null = null;
  $("table.infobox tr").each((_, tr) => {
    const th = $(tr).find("th").first().text().trim();
    if (/^starring$/i.test(th)) {
      const td = $(tr).find("td").first().clone();
      td.find("sup").remove();
      const text = td.text().trim();
      if (text) {
        lead = text;
      }
    }
  });
  return lead;
}

function parsePoster($: ReturnType<typeof cheerio.load>): string | null {
  const src = $("table.infobox td.infobox-image img")
    .first()
    .attr("src")
    ?.trim();
  if (!src) {
    return null;
  }
  return src.startsWith("//") ? `https:${src}` : src;
}

function parseEliminations($: ReturnType<typeof cheerio.load>) {
  const table = $("h2#Contestants").parent().nextAll("table").first();
  const headers = table
    .find("tr")
    .first()
    .find("th")
    .map((_, el) => $(el).text().trim())
    .toArray() as unknown as string[];
  const nameCol = headers.indexOf("Name");
  const outcomeCol = headers.indexOf("Outcome");

  // Expand rowspans, since contestants eliminated the same week share one Outcome cell
  const grid: string[][] = [];
  const pending: { [col: number]: { text: string; rows: number } } = {};
  table.find("tr").slice(1).each((_, tr) => {
    const cells = $(tr).find("td").toArray();
    if (cells.length === 0) {
      return;
    }
    const row: string[] = [];
    let col = 0;
    while (col < headers.length) {
      if (pending[col]?.rows > 0) {
        row[col] = pending[col].text;
        pending[col].rows--;
        col++;
        continue;
      }
      const cell = cells.shift();
      if (!cell) {
        break;
      }
      $(cell).find("sup").remove();
      const text = $(cell).text().trim();
      const rowSpan = parseInt($(cell).attr("rowspan") || "1", 10) || 1;
      const colSpan = parseInt($(cell).attr("colspan") || "1", 10) || 1;
      for (let c = 0; c < colSpan && col + c < headers.length; c++) {
        if (rowSpan > 1) {
          pending[col + c] = { text, rows: rowSpan - 1 };
        }
        row[col + c] = text;
      }
      col += colSpan;
    }
    grid.push(row);
  });

  const outcomes = grid.map((row) => row[outcomeCol] ?? "");
  const weeks = outcomes
    .map((o) => Number(o.match(/Week (\d+)/)?.[1]))
    .filter((w) => w);
  // The runner-up goes out in the finale, the week after the last regular elimination
  const finaleWeek = Math.max(...weeks) + 1;
  return grid
    .map((row, i) => {
      const outcome = outcomes[i];
      let week: number | null = Number(outcome.match(/Week (\d+)/)?.[1]) || null;
      if (/runner/i.test(outcome)) {
        week = finaleWeek;
      }
      return { fullName: row[nameCol], week };
    })
    .filter((entry) => Boolean(entry.fullName));
}

// e.g. 'Kaitlyn "Kaity" Biggar' -> "Kaity", "Viktoria Eichner" -> "Viktoria E.", "Alli Jo Hinkes" -> "Alli Jo"
function matchShortName(fullName: string, shortNames: string[]) {
  const nickname = fullName.match(/"(.+)"/)?.[1];
  const parts = fullName.replace(/".+"/, "").split(/\s+/).filter(Boolean);
  const first = nickname || parts[0];
  const given = nickname || parts.slice(0, -1).join(" ") || first;
  const last = parts.at(-1) || "";
  const match = shortNames.find((short) => {
    const initialMatch = short.match(/^(.+)\s+([A-Z])\.$/);
    if (initialMatch) {
      return (
        (initialMatch[1] === given || initialMatch[1] === first) &&
        last.startsWith(initialMatch[2])
      );
    }
    return short === given || short === first;
  });
  return match || first;
}

async function getShowScoringConfig(
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

async function getScoredPicks(client: Client, leagueId: number) {
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

async function rescore() {
  await refetch();
  const client = await getDBClient();
  await withTransaction(client, async () => {
    const leaguesRes = await client.query("SELECT id FROM league");
    for (const { id: leagueId } of leaguesRes.rows) {
      const scoredRows = await getScoredPicks(client, leagueId);
      // TODO picking semantics
      // Either we pick "who will be on this episode"
      // If so we need to add an extra dummy "winner" at the end
      // Matches up with is_on db state and green state we display on table
      // Or we pick "who survives this episode"
      // This doesn't match up with the is_on state so scoring is a bit more complicated since we need to compute whether the contestant advanced
      const scores: { [uid: string]: number } = {};
      for (const row of scoredRows) {
        scores[row.uid] = (scores[row.uid] ?? 0) + row.points;
      }
      console.log(`league ${leagueId}`, scores);
      for (const [uid, score] of Object.entries(scores)) {
        await upsertObject(
          client,
          "league_account",
          { league_id: leagueId, uid, score },
          { league_id: true, uid: true },
        );
      }
    }
  });
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
  // console.log(query);
  const result = await postgres.query(query, values);
  return result;
}

export function getDBClient() {
  // Cache the promise so concurrent first calls share one connection
  singleClient ??= (async () => {
    const client = new Client(dbUrl);
    await client.connect();
    return client;
  })();
  return singleClient;
}
