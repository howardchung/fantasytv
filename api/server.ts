import express from "express";
import type { Client } from "pg";
import cors from "cors";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { rescore } from "./rescore.ts";
import {
  getDBClient,
  getPacificParts,
  getScoredPicks,
  getShowIdForLeague,
  getShowScoringConfig,
  pacificTimeToUtcMs,
  upsertObject,
  withTransaction,
} from "./util.ts";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client();

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

const app = express();
app.use(express.static("./build"));
app.use(cors());
app.use(express.json());
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

app.get("/api/leagues", async (req, res) => {
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
app.get("/api/shows", async (req, res) => {
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
app.get("/api/contestants", async (req, res) => {
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
app.get("/api/bracket", async (req, res) => {
  const client = await getDBClient();
  const result = await client.query("SELECT * from bracket");
  return res.json(result.rows);
});
app.get("/api/episodes", async (req, res) => {
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
app.get("/api/config", async (req, res) => {
  const client = await getDBClient();
  const leagueId = await resolveLeagueId(client, req);
  const showId = await getShowIdForLeague(client, leagueId);
  res.json(await getShowScoringConfig(client, showId));
});
app.get("/api/contestantStatus", async (req, res) => {
  // Join the data to get the clean contestant status, currently not stored in table but we have one
  const client = await getDBClient();
  const showId =
    req.query.league !== undefined
      ? await getShowIdForLeague(client, await resolveLeagueId(client, req))
      : undefined;
  res.json(await getContestantStatus(showId));
});
app.get("/api/picks", requireAuth, async (req, res) => {
  const client = await getDBClient();
  const leagueId = await resolveLeagueId(client, req);
  const result = await client.query(
    `SELECT * from pick WHERE uid = $1 AND league_id = $2`,
    [res.locals.uid, leagueId],
  );
  res.json(result.rows);
});
app.post("/api/picks", requireAuth, async (req, res) => {
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
app.get("/api/leaderboard", async (req, res) => {
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
app.post("/api/league", async (req, res) => {
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
function msUntilNext9pmPacific(now = new Date()): number {
  const pt = getPacificParts(now);
  const addDays = pt.hour >= 21 ? 1 : 0;
  const targetMs = pacificTimeToUtcMs(pt.year, pt.month, pt.day + addDays, 21);
  return Math.max(1000, targetMs - now.getTime());
}

function scheduleDailyRescore() {
  const delay = msUntilNext9pmPacific();
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

if (!process.env.VERCEL) {
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
  scheduleDailyRescore();
}

export default app;

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
