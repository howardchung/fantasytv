require('dotenv').config();
import axios from "axios";
import cheerio from "cheerio";
import express from 'express';
import {Client, QueryResult} from 'pg';
import cors from 'cors';
import bodyParser from 'body-parser';

// TODO implement firebase login

const app = express();
app.use(express.static('./build'));
app.use(cors());
app.use(bodyParser.json());
app.all('/refetch', async (req, res) => {
  await refetch();
  res.json({});
});
app.all('/rescore', async (req, res) => {
  await rescore();
  res.json({});
});
app.get('/shows', async (req, res) => {
  const client = await getDBClient();
  const result = await client.query('SELECT * from show');
  return res.json(result.rows);
});
app.get('/contestants', async (req, res) => {
  const client = await getDBClient();
  const result = await client.query('SELECT * from contestant');
  return res.json(result.rows);
});
app.get('/bracket', async (req, res) => {
  const client = await getDBClient();
  const result = await client.query('SELECT * from bracket');
  return res.json(result.rows);
});
app.get('/episodes', async (req, res) => {
  const client = await getDBClient();
  const result = await client.query('SELECT * from episode');
  return res.json(result.rows);
});
app.get('/contestantStatus', async (req, res) => {
// Join the data to get the clean contestant status, currently not stored in table but we have one
res.json(await getContestantStatus());
});
app.get('/picks', async (req, res) => {
  // TODO filter by real user id and league
  // TODO return whether pick is editable
  const client = await getDBClient();
  const result = await client.query(`SELECT * from pick WHERE uid = 'asdf' AND league_id = 1`);
  res.json(result.rows);
});
app.post('/picks', async (req, res) => {
  // TODO allow setting user ID + validate
  // TODO only allow setting picks that aren't locked
  const client = await getDBClient();
  // console.log(req.body);
  for(let i = 0; i < req.body.length; i++) {
    const pick = req.body[i];
    const isPickEditable = true;
    pick.uid = 'asdf';
    pick.league_id = 1;
    await upsertObject(client, 'pick', pick, { league_id: true, episode_id: true, uid: true, contestant_id: true});
  }
});
app.get('/leaderboard', async (req, res) => {
  // TODO pass in league id
  const client = await getDBClient();
  const leagueId = 1;
  const result = await client.query(`SELECT * from league_account WHERE league_id = $1`, [leagueId]);
  res.json(result.rows);
});
// TODO allow admins to set unlocks
app.post('/league', async (req, res) => {
  const client = await getDBClient();
  // TODO accept show param
  const showId = 1;
  const admins: string[] = [];
  await upsertObject(client, 'league', {show_id: showId, admin_uids: admins});
});
app.listen(process.env.PORT || 3000);

if (process.env.NODE_ENV === 'development') {
  rescore();
  // refetch();
}

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
  const client = new Client(process.env.POSTGRES_URL)
  await client.connect();

  // Create default user
  await upsertObject(client, 'account', {uid: 'asdf', img: '', email: ''}, {uid: true});

const showResult = await upsertObject(client, 'show', { name: 'The Bachelor', season: 27 }, { name: true, season: true });
const showId = showResult.rows[0].id;
// Create default league for show
await upsertObject(client, 'league', {id: 1, show_id: showId, admin_uids: []}, {id: true});

const data = await axios.get('https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)');
// Parse table data
var $ = cheerio.load(data.data);

// upsert episodes
let ep_table = $('span#Episodes').parent().nextAll('table').first();
const eps: any[] = [];
ep_table.find('tbody tr').map(function(tr_index) {
  // gets the cells value for the row; loops through each cell and returns an array of values
  if (tr_index === 0) {
    return;
  }
  const row: any = {show_id: showId};
  $(this).find('td').each((i, el) => {
    if (i === 0) {
      row['num'] = $(el).text().trim();
    } else if (i === 1) {
      row['name'] = $(el).text().trim();
    } else if (i === 2) {
      const airdate = $(el).text().split('(')[0].replace(/\xA0/g,' ');
      row['airdate'] = new Date(airdate);
    }
  });
  eps.push(row);
});
for (let i = 0; i < eps.length; i++) {
  console.log(eps[i]);
  await upsertObject(client, 'episode', eps[i], {show_id: true, num: true});
}

// targets the specific table with a selector
var html_table = $('span#Call-out_order').parent().next('table');
// gets table header titles; loops through all th data, and pulls an array of the values
// var table_header = html_table.find('th').map(function() {return $(this).text().trim();}).toArray();
// removes columns after the number of columns specified
// table_header = table_header.slice(0, number_of_columns);

const result: any[] = [];
// gets table cell values; loops through all tr rows
html_table.find('tbody tr').map(function(tr_index) {
  // gets the cells value for the row; loops through each cell and returns an array of values
  const pass = ['turquoise', 'skyblue', 'gold', 'orange', 'limegreen', 'thistle', undefined];
  $(this).find('td').each((i, el) => {
    const isPass = pass.includes($(el).attr('bgcolor'));
    const name = ($(el).contents().filter(function(){ 
      return this.nodeType == 3; 
    })[0] as any).nodeValue.trim();
    if (name) {
      result.push({ show_id: showId, name, episode: i + 1, is_on: isPass });
    }
  });
});
// Insert ep 1 people into contestants table
const contData = await axios.get('https://prod.gatekeeper.us-abc.symphony.edgedatg.com/api/ws/pluto/v1/module/tilegroup/3719769?start=0&size=50&authlevel=0&brand=001&device=001&show=SH559030');
const imgMap: {[key: string]: string} = {};
contData.data.tiles.forEach((tile: any) => {
  if (tile.person?.type === 'Bachelorette') {
    imgMap[tile.person?.firstname.trim()] = tile.images?.[0].value;
  }
});
// console.log(imgMap);
const week1 = result.filter(row => row.episode === 1);
for (let i = 0; i < week1.length; i++) {
  // console.log(week1[i]);
  await upsertObject(client, 'contestant', { show_id: 1, name: week1[i].name, img: imgMap[week1[i].name]}, { show_id: true, name: true })
}
for (let i = 0; i < result.length; i++) {
  // console.log(result[i]);
  await upsertObject(client, 'raw_contestant_status', result[i], {show_id: true, name: true, episode: true});
}
}

const multiplier = [0, 0, 1, 2, 3, 4, 5, 6, 7, 10, 15, 20];
const expected = [30, 20, 17, 14, 11, 9, 7, 4, 4, 3, 2, 1];
async function rescore() {
  // TODO implement scoring
  const client = new Client(process.env.POSTGRES_URL)
  await client.connect();
  const check = await client.query(`
  SELECT contestant.id as contestant_id, 
  episode.id as episode_id,
  raw_contestant_status.is_on as answer,
  episode.num,
  pick.is_on as guess
  FROM raw_contestant_status
  LEFT JOIN contestant on contestant.name = raw_contestant_status.name
  LEFT JOIN episode on raw_contestant_status.episode = episode.num AND raw_contestant_status.show_id = episode.show_id
  JOIN pick on episode.id = pick.episode_id AND contestant.id = pick.contestant_id AND pick.league_id = 1 AND pick.uid = 'asdf';
`);
  console.log(check.rows);
  // TODO picking semantics
  // Either we pick "who will be on this episode"
  // If so we need to add an extra dummy "winner" at the end
  // Matches up with is_on db state and green state we display on table
  // Or we pick "who survives this episode"
  // This doesn't match up with the is_on state so scoring is a bit more complicated since we need to compute whether the contestant advanced
  let score = 0;
  for (let i = 0; i < check.rows.length; i++) {
    // Options:
    // Limit the number of picks made per week (prevent people from just picking everyone)
    // Apply a penalty for picking incorrectly (doubly affects people who pick an incorrect, e.g. picking 3 right is better as picking 4 and getting 1 wrong) 
    // Maybe penalize half value for an incorrect pick?
    // Multiply episode value by % correct
    // TODO need to match up with next episode is_on
    if (check.rows[i].guess === check.rows[i].answer) {
      score += multiplier[check.rows[i].num - 1];
    }
  }
  console.log(score);
  await upsertObject(client, 'league_account', {league_id: 1, uid: 'asdf', score}, {league_id: true, uid: true});
}

export async function upsertObject(
  postgres: Client,
  table: string,
  object: any,
  conflict?: any
): Promise<QueryResult<any>> {
  const columns = Object.keys(object);
  const values = Object.values(object);
  const conflictQ = conflict ? `
  ON CONFLICT (${Object.keys(conflict)
    .map((k) => `"${k}"`)
    .join(',')})
  DO UPDATE SET ${Object.keys(object)
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(',')}
  ` : '';
  let query = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(',')})
    VALUES (${values.map((_, i) => '$' + (i + 1)).join(',')})
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
  singleClient = new Client(process.env.POSTGRES_URL);
  await singleClient.connect();
  return singleClient;
}