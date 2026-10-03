import express from "express";
import { Client, type QueryResult } from "pg";
import cors from "cors";
import bodyParser from "body-parser";
import * as cheerio from "cheerio";
import { writeFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

// Only the project ID is needed to verify ID tokens, no service account
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });

// Verifies the Firebase ID token from the client and records the account
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
  let decoded: DecodedIdToken;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  const client = await getDBClient();
  await upsertObject(
    client,
    "account",
    {
      uid: decoded.uid,
      name: decoded.name || "",
      email: decoded.email || "",
      img: decoded.picture || "",
    },
    { uid: true },
  );
  res.locals.uid = decoded.uid;
  next();
}

const dbUrl =
  (process.env.DATABASE_URL || "postgres://localhost:5432") + "/fantasytv";

const app = express();
app.use(express.static("./build"));
app.use(cors());
app.use(bodyParser.json());
app.all("/refetch", async (req, res) => {
  await refetch();
  res.json({});
});
app.all("/rescore", async (req, res) => {
  await rescore();
  res.json({});
});
app.get("/shows", async (req, res) => {
  const client = await getDBClient();
  const result = await client.query("SELECT * from show");
  return res.json(result.rows);
});
app.get("/contestants", async (req, res) => {
  const client = await getDBClient();
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
  const result = await client.query("SELECT * from episode");
  return res.json(result.rows);
});
app.get("/contestantStatus", async (req, res) => {
  // Join the data to get the clean contestant status, currently not stored in table but we have one
  res.json(await getContestantStatus());
});
app.get("/picks", requireAuth, async (req, res) => {
  // TODO filter by league
  // TODO return whether pick is editable
  const client = await getDBClient();
  const result = await client.query(
    `SELECT * from pick WHERE uid = $1 AND league_id = 1`,
    [res.locals.uid],
  );
  res.json(result.rows);
});
app.post("/picks", requireAuth, async (req, res) => {
  // TODO validate
  // TODO only allow setting picks that aren't locked
  const client = await getDBClient();
  // console.log(req.body);
  for (let i = 0; i < req.body.length; i++) {
    // Only take known fields, since upsertObject uses keys as column names
    const { episode_id, contestant_id, is_on } = req.body[i];
    const isPickEditable = true;
    const pick = {
      league_id: 1,
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
  res.json({});
});
app.get("/leaderboard", async (req, res) => {
  // TODO pass in league id
  const client = await getDBClient();
  const leagueId = 1;
  const result = await client.query(
    `SELECT * from league_account WHERE league_id = $1`,
    [leagueId],
  );
  res.json(result.rows);
});
// TODO allow admins to set unlocks
app.post("/league", async (req, res) => {
  const client = await getDBClient();
  // TODO accept show param
  const showId = 1;
  const admins: string[] = [];
  await upsertObject(client, "league", { show_id: showId, admin_uids: admins });
});
app.listen(process.env.PORT || 3000);

await refetch();
await rescore();

async function getContestantStatus() {
  const client = await getDBClient();
  const contestantStatus = await client.query(`
  SELECT contestant.id as contestant_id, 
  episode.id as episode_id,
  is_on
  FROM raw_contestant_status
  LEFT JOIN contestant on contestant.name = raw_contestant_status.name
  LEFT JOIN episode on raw_contestant_status.episode = episode.num AND raw_contestant_status.show_id = episode.show_id
`);
  return contestantStatus.rows;
}

// TODO pass in show to refetch
async function refetch() {
  const client = new Client(dbUrl);
  await client.connect();

  const showResult = await upsertObject(
    client,
    "show",
    { name: "The Bachelor", season: 27 },
    { name: true, season: true },
  );
  const showId = showResult.rows[0].id;

  // Create default league for show
  const leagueResult = await upsertObject(
    client,
    "league",
    { id: 1, show_id: showId, admin_uids: [] },
    { id: true },
  );
  // console.log('league', leagueResult);

  const url = "https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)";
  let resp = await fetch(
    url,
  );
  const data = await resp.text();
  writeFileSync('./data/' + url.split('/').at(-1), data);
  
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
  for (let i = 0; i < eps.length; i++) {
    console.log(eps[i]);
    await upsertObject(client, "episode", eps[i], { show_id: true, num: true });
  }

  // targets the specific table with a selector
  var html_table = $("h2#Call-out_order").parent().next("table");
  // gets table header titles; loops through all th data, and pulls an array of the values
  // var table_header = html_table.find('th').map(function() {return $(this).text().trim();}).toArray();
  // removes columns after the number of columns specified
  // table_header = table_header.slice(0, number_of_columns);

  const result: any[] = [];
  // gets table cell values; loops through all tr rows
  html_table.find("tbody tr").map((tr_index, el) => {
    // gets the cells value for the row; loops through each cell and returns an array of values
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
  // Insert ep 1 people into contestants table
  // This endpoint returns only the current cast (but has images for each)
  // resp = await fetch(
  //   "https://prod.gatekeeper.us-abc.symphony.edgedatg.com/api/ws/pluto/v1/module/tilegroup/3719769?start=0&size=50&authlevel=0&brand=001&device=001&show=SH559030",
  // );
  // const contData = await resp.json();
  // const imgMap: { [key: string]: string } = {};
  // contData.tiles.forEach((tile: any) => {
  //   if (tile.person?.type === "Bachelorette") {
  //     imgMap[tile.person?.firstname.trim()] = tile.images?.[0].value;
  //   }
  // });
  // // console.log(imgMap);
  // const week1 = result.filter((row) => row.episode === 1);
  // for (let i = 0; i < week1.length; i++) {
  //   console.log('contestant', week1[i]);
  //   await upsertObject(
  //     client,
  //     "contestant",
  //     { show_id: 1, name: week1[i].name, img: imgMap[week1[i].name] },
  //     { show_id: true, name: true },
  //   );
  // }
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

  // Elimination week for each contestant, from the Contestants table
  // The call-out order uses short names (e.g. "Kaity", "Viktoria E."), so match full names to those
  const shortNames = result
    .filter((row) => row.episode === 1)
    .map((row) => row.name);
  const eliminations = parseEliminations($);
  for (let i = 0; i < eliminations.length; i++) {
    const { fullName, week } = eliminations[i];
    const name = matchShortName(fullName, shortNames);
    console.log('contestant', fullName, name, week);
    await upsertObject(
      client,
      "contestant",
      { show_id: showId, name, eliminated_week: week },
      { show_id: true, name: true },
    );
  }
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
    const row: string[] = [];
    const cells = $(tr).find("td").toArray();
    for (let col = 0; col < headers.length; col++) {
      if (pending[col]?.rows > 0) {
        row.push(pending[col].text);
        pending[col].rows--;
        continue;
      }
      const cell = cells.shift();
      if (!cell) {
        break;
      }
      $(cell).find("sup").remove();
      const text = $(cell).text().trim();
      const span = Number($(cell).attr("rowspan") || 1);
      if (span > 1) {
        pending[col] = { text, rows: span - 1 };
      }
      row.push(text);
    }
    grid.push(row);
  });

  const outcomes = grid.map((row) => row[outcomeCol]);
  const weeks = outcomes
    .map((o) => Number(o.match(/Week (\d+)/)?.[1]))
    .filter((w) => w);
  // The runner-up goes out in the finale, the week after the last regular elimination
  const finaleWeek = Math.max(...weeks) + 1;
  return grid.map((row, i) => {
    const outcome = outcomes[i];
    let week: number | null = Number(outcome.match(/Week (\d+)/)?.[1]) || null;
    if (/runner/i.test(outcome)) {
      week = finaleWeek;
    }
    return { fullName: row[nameCol], week };
  });
}

// e.g. 'Kaitlyn "Kaity" Biggar' -> "Kaity", "Viktoria Eichner" -> "Viktoria E."
function matchShortName(fullName: string, shortNames: string[]) {
  const nickname = fullName.match(/"(.+)"/)?.[1];
  const parts = fullName.replace(/".+"/, "").split(/\s+/).filter(Boolean);
  const first = nickname || parts[0];
  const last = parts.at(-1) || "";
  const match = shortNames.find((short) => {
    const [shortFirst, initial] = short.split(" ");
    return (
      shortFirst === first && (!initial || last.startsWith(initial[0]))
    );
  });
  return match || first;
}

const multiplier = [0, 0, 1, 2, 3, 4, 5, 6, 7, 10, 15, 20];
const expected = [30, 20, 17, 14, 11, 9, 7, 4, 4, 3, 2, 1];
async function rescore() {
  // TODO implement scoring
  const client = new Client(dbUrl);
  await client.connect();
  const check = await client.query(`
  SELECT contestant.id as contestant_id, 
  episode.id as episode_id,
  raw_contestant_status.is_on as answer,
  episode.num,
  pick.is_on as guess,
  pick.uid
  FROM raw_contestant_status
  LEFT JOIN contestant on contestant.name = raw_contestant_status.name
  LEFT JOIN episode on raw_contestant_status.episode = episode.num AND raw_contestant_status.show_id = episode.show_id
  JOIN pick on episode.id = pick.episode_id AND contestant.id = pick.contestant_id AND pick.league_id = 1;
`);
  console.log(check.rows);
  // TODO picking semantics
  // Either we pick "who will be on this episode"
  // If so we need to add an extra dummy "winner" at the end
  // Matches up with is_on db state and green state we display on table
  // Or we pick "who survives this episode"
  // This doesn't match up with the is_on state so scoring is a bit more complicated since we need to compute whether the contestant advanced
  const scores: { [uid: string]: number } = {};
  for (let i = 0; i < check.rows.length; i++) {
    const uid = check.rows[i].uid;
    scores[uid] ??= 0;
    // Options:
    // Limit the number of picks made per week (prevent people from just picking everyone)
    // Apply a penalty for picking incorrectly (doubly affects people who pick an incorrect, e.g. picking 3 right is better as picking 4 and getting 1 wrong)
    // Maybe penalize half value for an incorrect pick?
    // Multiply episode value by % correct
    // TODO need to match up with next episode is_on
    if (check.rows[i].guess === check.rows[i].answer) {
      scores[uid] += multiplier[check.rows[i].num - 1];
    }
  }
  console.log(scores);
  for (const [uid, score] of Object.entries(scores)) {
    await upsertObject(
      client,
      "league_account",
      { league_id: 1, uid, score },
      { league_id: true, uid: true },
    );
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
  // console.log(query);
  const result = await postgres.query(query, values);
  return result;
}

let singleClient: Client = null as any;

export async function getDBClient() {
  if (singleClient) {
    return singleClient;
  }
  singleClient = new Client(dbUrl);
  await singleClient.connect();
  return singleClient;
}
