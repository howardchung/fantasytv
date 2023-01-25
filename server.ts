import axios from "axios";
import cheerio from "cheerio";

// Contestant data
// https://prod.gatekeeper.us-abc.symphony.edgedatg.com/api/ws/pluto/v1/module/tilegroup/3719769?start=0&size=50&authlevel=0&brand=001&device=001&show=SH559030

// Placement data
// https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)

run();

async function run() {
    const data = await axios.get('https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)');
// Parse table data
// parses HTML
var $ = cheerio.load(data.data);
// the number of columns you want to target on the table, starting from the left column
var number_of_columns = 15;

// targets the specific table with a selector
var html_table = $('span#Call-out_order').parent().next();
// gets table header titles; loops through all th data, and pulls an array of the values
var table_header = html_table.find('th').map(function() {return $(this).text().trim();}).toArray();
// removes columns after the number of columns specified
table_header = table_header.slice(0, number_of_columns);
// gets table cell values; loops through all tr rows
html_table.find('tbody tr').map(function(tr_index) {
  // gets the cells value for the row; loops through each cell and returns an array of values
  const pass = ['turquoise', 'skyblue', 'gold', 'orange', 'limegreen', undefined];
  $(this).find('td').each((i, el) => {
    const isPass = pass.includes($(el).attr('bgcolor'));
    const name = $(el).text().trim();
    if (name) {
        console.log(name, i, isPass);
    }
  });
});
}