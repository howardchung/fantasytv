"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
exports.upsertObject = void 0;
require('dotenv').config();
var axios_1 = require("axios");
var cheerio_1 = require("cheerio");
var express_1 = require("express");
var pg_1 = require("pg");
var cors_1 = require("cors");
// Contestant data
// https://prod.gatekeeper.us-abc.symphony.edgedatg.com/api/ws/pluto/v1/module/tilegroup/3719769?start=0&size=50&authlevel=0&brand=001&device=001&show=SH559030
// Placement data
// https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)
// Episode data
// https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)
var app = (0, express_1["default"])();
app.use((0, cors_1["default"])());
app.all('/refetch', function (req, res) {
    refetch();
});
app.post('/rescore', function (req, res) {
});
app.get('/shows', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var client, result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                client = new pg_1.Client(process.env.POSTGRES_URL);
                return [4 /*yield*/, client.connect()];
            case 1:
                _a.sent();
                return [4 /*yield*/, client.query('SELECT * from show')];
            case 2:
                result = _a.sent();
                return [2 /*return*/, res.json(result.rows)];
        }
    });
}); });
app.get('/contestants', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var client, result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                client = new pg_1.Client(process.env.POSTGRES_URL);
                return [4 /*yield*/, client.connect()];
            case 1:
                _a.sent();
                return [4 /*yield*/, client.query('SELECT * from constestant')];
            case 2:
                result = _a.sent();
                return [2 /*return*/, res.json(result.rows)];
        }
    });
}); });
app.get('/bracket', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var client, result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                client = new pg_1.Client(process.env.POSTGRES_URL);
                return [4 /*yield*/, client.connect()];
            case 1:
                _a.sent();
                return [4 /*yield*/, client.query('SELECT * from bracket')];
            case 2:
                result = _a.sent();
                return [2 /*return*/, res.json(result.rows)];
        }
    });
}); });
app.post('/bracket', function (req, res) {
    // TODO edit bracket
});
app.listen(process.env.PORT || 3000);
function refetch() {
    return __awaiter(this, void 0, void 0, function () {
        var client, data, $, number_of_columns, ep_table, eps, i, html_table, result, week1, i, i;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = new pg_1.Client(process.env.POSTGRES_URL);
                    return [4 /*yield*/, client.connect()];
                case 1:
                    _a.sent();
                    // TODO upsert more shows
                    return [4 /*yield*/, upsertObject(client, 'show', { name: 'The Bachelor', season: 27 }, { name: true, season: true })];
                case 2:
                    // TODO upsert more shows
                    _a.sent();
                    return [4 /*yield*/, axios_1["default"].get('https://en.wikipedia.org/wiki/The_Bachelor_(American_season_27)')];
                case 3:
                    data = _a.sent();
                    $ = cheerio_1["default"].load(data.data);
                    number_of_columns = 15;
                    ep_table = $('span#Episodes').parent().nextAll('table').first();
                    eps = [];
                    ep_table.find('tbody tr').map(function (tr_index) {
                        // gets the cells value for the row; loops through each cell and returns an array of values
                        if (tr_index === 0) {
                            return;
                        }
                        var row = { show_id: 1 };
                        $(this).find('td').each(function (i, el) {
                            if (i === 0) {
                                row['num'] = $(el).text().trim();
                            }
                            else if (i === 1) {
                                row['name'] = $(el).text().trim();
                            }
                            else if (i === 2) {
                                var airdate = $(el).text().split('(')[0].replace(/\xA0/g, ' ');
                                row['airdate'] = new Date(airdate);
                            }
                        });
                        eps.push(row);
                    });
                    i = 0;
                    _a.label = 4;
                case 4:
                    if (!(i < eps.length)) return [3 /*break*/, 7];
                    console.log(eps[i]);
                    return [4 /*yield*/, upsertObject(client, 'episode', eps[i], { show_id: true, num: true })];
                case 5:
                    _a.sent();
                    _a.label = 6;
                case 6:
                    i++;
                    return [3 /*break*/, 4];
                case 7:
                    html_table = $('span#Call-out_order').parent().next('table');
                    result = [];
                    // gets table cell values; loops through all tr rows
                    html_table.find('tbody tr').map(function (tr_index) {
                        // gets the cells value for the row; loops through each cell and returns an array of values
                        var pass = ['turquoise', 'skyblue', 'gold', 'orange', 'limegreen', undefined];
                        $(this).find('td').each(function (i, el) {
                            var isPass = pass.includes($(el).attr('bgcolor'));
                            var name = $(el).text().trim();
                            if (name) {
                                result.push({ show_id: 1, name: name, episode: i + 1, is_on: isPass });
                            }
                        });
                    });
                    week1 = result.filter(function (row) { return row.episode === 1; });
                    i = 0;
                    _a.label = 8;
                case 8:
                    if (!(i < week1.length)) return [3 /*break*/, 11];
                    console.log(week1[i]);
                    return [4 /*yield*/, upsertObject(client, 'contestant', { show_id: 1, name: week1[i].name }, { show_id: true, name: true })];
                case 9:
                    _a.sent();
                    _a.label = 10;
                case 10:
                    i++;
                    return [3 /*break*/, 8];
                case 11:
                    i = 0;
                    _a.label = 12;
                case 12:
                    if (!(i < result.length)) return [3 /*break*/, 15];
                    console.log(result[i]);
                    return [4 /*yield*/, upsertObject(client, 'raw_contestant_status', result[i], { show_id: true, name: true, episode: true })];
                case 13:
                    _a.sent();
                    _a.label = 14;
                case 14:
                    i++;
                    return [3 /*break*/, 12];
                case 15: return [2 /*return*/];
            }
        });
    });
}
function upsertObject(postgres, table, object, conflict) {
    return __awaiter(this, void 0, void 0, function () {
        var columns, values, query, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    columns = Object.keys(object);
                    values = Object.values(object);
                    query = "INSERT INTO ".concat(table, " (").concat(columns.map(function (c) { return "\"".concat(c, "\""); }).join(','), ")\n    VALUES (").concat(values.map(function (_, i) { return '$' + (i + 1); }).join(','), ")\n    ON CONFLICT (").concat(Object.keys(conflict)
                        .map(function (k) { return "\"".concat(k, "\""); })
                        .join(','), ")\n    DO UPDATE SET ").concat(Object.keys(object)
                        .map(function (c) { return "\"".concat(c, "\" = EXCLUDED.\"").concat(c, "\""); })
                        .join(','), "\n    RETURNING *");
                    return [4 /*yield*/, postgres.query(query, values)];
                case 1:
                    result = _a.sent();
                    return [2 /*return*/, result];
            }
        });
    });
}
exports.upsertObject = upsertObject;
