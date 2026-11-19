const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const engine = require("../engine.js");
const scoresCSV = fs.readFileSync(path.join(__dirname, "fixtures", "scorecards.csv"), "utf8");
const theftsCSV = fs.readFileSync(path.join(__dirname, "fixtures", "thefts.csv"), "utf8");
const teams = engine.parseScorecards(scoresCSV);
const thefts = engine.parseThefts(theftsCSV, teams);
const states = engine.snapshots(teams, thefts);
const team = (state, id) => state.find(item => item.id === String(id));

test("loads all 21 teams and eight swaps without conflating duplicate names", () => {
  assert.equal(teams.length, 21);
  assert.equal(thefts.length, 8);
  assert.equal(states.length, 9);
  assert.equal(team(teams, 5).players[1].name, "Vieng");
  assert.equal(team(teams, 10).players[0].name, "Vieng");
  assert.equal(team(states[5], 7).players[0].scores[6], 3);
  assert.equal(team(states[5], 21).players[0].scores[6], 8);
});
test("uses maximum per hole, not minimum or sum of individual totals", () => {
  const sample = { players: [{ scores: [1, 8, 1, 8, 1, 8, 1, 8, 1] }, { scores: [8, 1, 8, 1, 8, 1, 8, 1, 8] }] };
  assert.deepEqual(engine.teamScore(sample), { holes: Array(9).fill(8), total: 72 });
  assert.equal(engine.teamScore(team(teams, 12)).total, 64);
});
test("matches the supplied round's team 12 totals at every step", () => {
  assert.deepEqual(states.map(state => engine.teamScore(team(state, 12)).total), [64, 63, 60, 54, 48, 48, 43, 43, 43]);
  assert.equal(team(states[1], 12).players[0].scores[0], 1);
  assert.equal(team(states[1], 21).players[0].scores[5], 5);
});
test("all swaps operate on prior state and preserve the score multiset", () => {
  const multiset = state => state.flatMap(t => t.players.flatMap(p => p.scores)).sort((a, b) => a - b);
  for (let i = 1; i < states.length; i++) {
    const event = thefts[i - 1];
    assert.equal(engine.getCell(states[i], event.stealer), engine.getCell(states[i - 1], event.victim));
    assert.equal(engine.getCell(states[i], event.victim), engine.getCell(states[i - 1], event.stealer));
    assert.deepEqual(multiset(states[i]), multiset(states[0]));
  }
  assert.equal(team(states[7], 12).players[0].scores[7], 1);
  assert.equal(team(states[8], 13).players[1].scores[8], 1);
  assert.equal(team(states[0], 12).players[0].scores[7], 8);
  assert.deepEqual(teams, engine.parseScorecards(scoresCSV));
});
test("a repeated cell passes its received value into the next swap", () => {
  const sequence = engine.parseThefts(theftsCSV.split("\n")[0] + "\n12,1-1,21,1-6\n12,1-1,4,1-1", teams);
  const replay = engine.snapshots(teams, sequence);
  assert.equal(team(replay[2], 4).players[0].scores[0], 1);
  assert.equal(team(replay[2], 12).players[0].scores[0], 4);
});
test("CSV parser supports BOM, blank rows, whitespace and quoted multiline names", () => {
  assert.deepEqual(engine.parseCSV('\uFEFFa,b\r\n,,\r\n "Doe, ""Jo""", "line\nbreak" \r\n'), [["a", "b"], ['Doe, "Jo"', "line\nbreak"]]);
  assert.throws(() => engine.parseCSV('"unclosed'), /Unclosed/);
});
test("invalid inputs show useful errors rather than incomplete scores", () => {
  assert.throws(() => engine.parseScorecards("Team Id,Player Names,1"), /columns/);
  assert.throws(() => engine.parseScorecards(scoresCSV.replace("3,8,2,6", "-1,8,2,6")), /Invalid scorecard/);
  assert.throws(() => engine.parseScorecards(scoresCSV.replace("1,Jeff", "99,Jeff")), /exactly two/);
  assert.throws(() => engine.parseThefts(theftsCSV.replace("12,1-1", "99,1-1"), teams), /Invalid theft/);
  assert.throws(() => engine.parseThefts(theftsCSV.replace("12,1-1", "12,3-1"), teams), /Invalid theft/);
  assert.throws(() => engine.parseThefts(theftsCSV.replace("12,1-1,21", "12,1-1,12"), teams), /different teams/);
});
test("ties share a rank and an empty log keeps the original state", () => {
  const same = [team(teams, 1), { ...team(teams, 1), id: "99" }];
  assert.deepEqual(engine.ranks(same), { 1: 1, 99: 1 });
  assert.equal(engine.parseThefts(theftsCSV.split("\n")[0], teams).length, 0);
  assert.deepEqual(engine.snapshots(teams, []), [teams]);
});
test("standings use ascending total, then numeric ID for stable ties, without mutating input", () => {
  const tied = [{ ...team(teams, 1), id: "10" }, { ...team(teams, 1), id: "2" }];
  const input = [tied[0], team(teams, 18), tied[1]];
  assert.deepEqual(engine.standings(input).map(t => t.id), ["18", "2", "10"]);
  assert.deepEqual(input.map(t => t.id), ["10", "18", "2"]);
  const rank = engine.ranks(input);
  assert.equal(rank["2"], rank["10"]);
});

test("the editable round is valid and every swap preserves its scores", () => {
  const configuredTeams = engine.parseScorecards(fs.readFileSync(path.join(__dirname, "..", "data", "scorecards.csv"), "utf8"));
  const configuredThefts = engine.parseThefts(fs.readFileSync(path.join(__dirname, "..", "data", "thefts.csv"), "utf8"), configuredTeams);
  const configuredStates = engine.snapshots(configuredTeams, configuredThefts);
  const values = state => state.flatMap(t => t.players.flatMap(p => p.scores)).sort((a, b) => a - b);
  assert.equal(configuredStates.length, configuredThefts.length + 1);
  configuredStates.forEach(state => assert.deepEqual(values(state), values(configuredTeams)));
});
