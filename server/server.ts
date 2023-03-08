require('dotenv').config();
import axios from "axios";
import cheerio from "cheerio";
import express from 'express';
import {Client, QueryResult} from 'pg';
import cors from 'cors';

// Contestant data
// https://prod.gatekeeper.us-abc.symphony.edgedatg.com/api/ws/pluto/v1/module/tilegroup/3719769?start=0&size=50&authlevel=0&brand=001&device=001&show=SH559030

// Placement data
// https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)

// Episode data
// https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)

const app = express();
app.use(cors());
app.all('/refetch', (req, res) => {
  refetch();
});
app.post('/rescore', (req, res) => {

});
app.get('/shows', async (req, res) => {
  const client = new Client(process.env.POSTGRES_URL)
  await client.connect();
  const result = await client.query('SELECT * from show');
  return res.json(result.rows);
});
app.get('/contestants', async (req, res) => {
  const client = new Client(process.env.POSTGRES_URL)
  await client.connect();
  const result = await client.query('SELECT * from constestant');
  return res.json(result.rows);
});
app.get('/bracket', async (req, res) => {
  const client = new Client(process.env.POSTGRES_URL)
  await client.connect();
  const result = await client.query('SELECT * from bracket');
  return res.json(result.rows);
});
app.post('/bracket', (req, res) => {
  // TODO edit bracket
}); 
app.listen(process.env.PORT || 3000)

async function refetch() {
  const client = new Client(process.env.POSTGRES_URL)
  await client.connect();
  // TODO upsert more shows
await upsertObject(client, 'show', { name: 'The Bachelor', season: 27 }, { name: true, season: true });
const data = await axios.get('https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)');
// Parse table data
// parses HTML
var $ = cheerio.load(data.data);
// the number of columns you want to target on the table, starting from the left column
var number_of_columns = 15;

// upsert episodes
let ep_table = $('span#Episodes').parent().nextAll('table').first();
const eps: any[] = [];
ep_table.find('tbody tr').map(function(tr_index) {
  // gets the cells value for the row; loops through each cell and returns an array of values
  if (tr_index === 0) {
    return;
  }
  const row: any = {show_id: 1};
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
  const pass = ['turquoise', 'skyblue', 'gold', 'orange', 'limegreen', undefined];
  $(this).find('td').each((i, el) => {
    const isPass = pass.includes($(el).attr('bgcolor'));
    const name = $(el).text().trim();
    if (name) {
      result.push({ show_id: 1, name, episode: i + 1, is_on: isPass });
    }
  });
});
// Insert ep 1 people into contestants table
// TODO get contestant images
const week1 = result.filter(row => row.episode === 1);
for (let i = 0; i < week1.length; i++) {
  console.log(week1[i]);
  await upsertObject(client, 'contestant', { show_id: 1, name: week1[i].name}, { show_id: true, name: true })
}
for (let i = 0; i < result.length; i++) {
  console.log(result[i]);
  await upsertObject(client, 'raw_contestant_status', result[i], {show_id: true, name: true, episode: true});
}
// TODO Join the data to get the clean contestant status
}

export async function upsertObject(
  postgres: Client,
  table: string,
  object: any,
  conflict: any
): Promise<QueryResult<any>> {
  const columns = Object.keys(object);
  const values = Object.values(object);
  let query = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(',')})
    VALUES (${values.map((_, i) => '$' + (i + 1)).join(',')})
    ON CONFLICT (${Object.keys(conflict)
      .map((k) => `"${k}"`)
      .join(',')})
    DO UPDATE SET ${Object.keys(object)
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(',')}
    RETURNING *`;
  // console.log(query);
  const result = await postgres.query(query, values);
  return result;
}