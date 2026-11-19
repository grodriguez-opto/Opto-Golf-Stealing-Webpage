(function (root) {
  "use strict";
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    text = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else if (quoted || field.trim() === "") { quoted = !quoted; }
        else { throw new Error("Unexpected quote in CSV data."); }
      } else if (char === "," && !quoted) {
        row.push(field.trim()); field = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = []; field = "";
        if (char === "\r" && text[i + 1] === "\n") i++;
      } else { field += char; }
    }
    if (quoted) throw new Error("Unclosed quoted field in CSV data.");
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }
  function parseScorecards(text) {
    const rows = parseCSV(text), header = rows.shift();
    if (!header || header.length !== 11 || header[0].toLowerCase() !== "team id" ||
        header[1].toLowerCase() !== "player names" ||
        header.slice(2).some((value, i) => value !== String(i + 1))) {
      throw new Error("Scorecards must have columns: Team Id, Player Names, 1, 2, 3, 4, 5, 6, 7, 8, 9.");
    }
    const teams = [];
    for (const [index, row] of rows.entries()) {
      if (row.length !== 11 || !/^\d+$/.test(row[0]) || !Number.isSafeInteger(Number(row[0])) || !row[1] ||
          row.slice(2).some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        throw new Error(`Invalid scorecard at data row ${index + 1}. Use a numeric team ID, a name, and nine nonnegative integer scores.`);
      }
      const id = String(Number(row[0]));
      let team = teams.find(item => item.id === id);
      if (!team) { team = { id, players: [] }; teams.push(team); }
      team.players.push({ name: row[1], scores: row.slice(2).map(Number) });
      if (team.players.length > 2) throw new Error(`Team ${id} has more than two players.`);
    }
    if (!teams.length) throw new Error("The scorecards CSV has no teams.");
    for (const team of teams) {
      if (team.players.length !== 2) throw new Error(`Team ${team.id} must have exactly two players.`);
    }
    return teams.sort((a, b) => Number(a.id) - Number(b.id));
  }
  function parseThefts(text, teams) {
    const rows = parseCSV(text), header = rows.shift();
    const expected = ["team stealing", "stealing hole (player-hole#)", "team stolen from", "stolen hole (player-hole#)"];
    if (!header || header.length !== 4 || header.some((value, i) => value.toLowerCase() !== expected[i])) {
      throw new Error("The theft log must have the four supplied Team Stealing / Stealing Hole / Team Stolen From / Stolen Hole columns.");
    }
    function cell(teamId, coordinate, rowNumber) {
      const match = /^([12])-([1-9])$/.exec(coordinate);
      const id = /^\d+$/.test(teamId) ? String(Number(teamId)) : "";
      if (!match || !teams.some(team => team.id === id)) {
        throw new Error(`Invalid theft at data row ${rowNumber}: use an existing team ID and a player-hole coordinate such as 1-6.`);
      }
      return { teamId: id, player: Number(match[1]) - 1, hole: Number(match[2]) - 1 };
    }
    return rows.map((row, i) => {
      if (row.length !== 4) throw new Error(`Theft data row ${i + 1} must have four fields.`);
      const stealer = cell(row[0], row[1], i + 1), victim = cell(row[2], row[3], i + 1);
      if (stealer.teamId === victim.teamId) throw new Error(`Theft data row ${i + 1} must involve two different teams.`);
      return { stealer, victim };
    });
  }
  function clone(teams) {
    return teams.map(team => ({ id: team.id, players: team.players.map(player => ({ name: player.name, scores: [...player.scores] })) }));
  }
  function teamScore(team) {
    const holes = team.players[0].scores.map((score, hole) => Math.max(score, team.players[1].scores[hole]));
    return { holes, total: holes.reduce((sum, score) => sum + score, 0) };
  }
  function getCell(teams, cell) {
    return teams.find(team => team.id === cell.teamId).players[cell.player].scores[cell.hole];
  }
  function snapshots(teams, thefts) {
    const states = [clone(teams)];
    for (const theft of thefts) {
      const state = clone(states[states.length - 1]);
      const first = state.find(team => team.id === theft.stealer.teamId);
      const second = state.find(team => team.id === theft.victim.teamId);
      const value = getCell(state, theft.stealer);
      first.players[theft.stealer.player].scores[theft.stealer.hole] = getCell(state, theft.victim);
      second.players[theft.victim.player].scores[theft.victim.hole] = value;
      states.push(state);
    }
    return states;
  }
  function ranks(teams) {
    const totals = teams.map(team => teamScore(team).total).sort((a, b) => a - b);
    return Object.fromEntries(teams.map(team => [team.id, totals.indexOf(teamScore(team).total) + 1]));
  }
  function standings(teams) {
    return [...teams].sort((a, b) => teamScore(a).total - teamScore(b).total || Number(a.id) - Number(b.id));
  }
  const api = { parseCSV, parseScorecards, parseThefts, snapshots, teamScore, getCell, ranks, standings };
  root.GolfReplay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
