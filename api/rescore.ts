import * as cheerio from "cheerio";
import { writeFileSync } from "node:fs";
import type { Client } from "pg";
import {
  getDBClient,
  getScoredPicks,
  loadShowsConfig,
  upsertObject,
  withTransaction,
} from "./util.ts";

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

export async function refetch() {
  const client = await getDBClient();
  const shows = loadShowsConfig();

  for (const { name, season, url, imagesUrl } of shows) {
    const [resp, imgMap] = await Promise.all([
      fetch(url),
      fetchContestantImages(imagesUrl),
    ]);
    const data = await resp.text();
    writeFileSync("/tmp/" + url.split("/").at(-1), data);

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
  ep_table.find("tbody tr.module-episode-list-row").map((_tr_index, el) => {
    const row: any = { show_id: showId };
    $(el)
      .find("td")
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
  html_table.find("tbody tr").map((_tr_index, el) => {
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
      console.log("raw_contestant_status", result[i]);
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
      console.log("contestant", fullName, name, week);
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
  table
    .find("tr")
    .slice(1)
    .each((_, tr) => {
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

export async function rescore() {
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
