# Turkey Putt — The scorecard shuffle

A pure HTML/CSS/JavaScript mini golf score replay. No build, packages, accounts, or backend required. All resources use relative paths, including on a GitHub Pages project site.

## Publish on GitHub Pages

1. Push these files to the repository's `main` branch.
2. Open **Settings > Pages**, choose **Deploy from a branch**, select **main** and **/ (root)**, and save.
3. Open the published Pages URL after deployment finishes.

## Update the round

Edit or replace the CSVs in `data/`, keeping their filenames and headers:

- `scorecards.csv`: `Team Id,Player Names,1,2,3,4,5,6,7,8,9`. Include exactly two rows per team, with player 1 first and player 2 second. Blank separator rows are optional. Scores must be nonnegative whole numbers.
- `thefts.csv`: `Team Stealing,Stealing Hole (player-hole#),Team Stolen From,Stolen Hole (player-hole#)`. A row such as `12,1-1,21,1-6` swaps team 12's player 1 / hole 1 with team 21's player 1 / hole 6.

Names may repeat, including on different teams. Identity is team ID plus player order, never name. CSV quoted fields, escaped quotes, CRLF/LF, and blank rows are supported. Invalid data displays a visible error instead of partial scores.

The team score for each hole is the **higher** of the two players' scores. The team total is the sum of those nine values; lower totals rank first and tied totals share a rank. Thefts are two-way swaps applied sequentially, including when a cell is swapped repeatedly.

## Replay controls

The replay autoplays once, stopping after the final steal. Use play/pause, previous/next, the speed selector, or the timeline slider to inspect any state. Scrubbing pauses playback. The featured pair of scorecards keeps both swapped cells visible, with two flying scores and updated totals; all teams remain visible in the grid below. The final steal in the supplied data exchanges two `1` scores, so it correctly leaves both values unchanged.

Reduced-motion preferences disable autoplay and flying-score animations; manual timeline controls still work. Playback also pauses when the tab is hidden.

## Local preview and tests

Serve this folder over HTTP rather than opening `index.html` directly, since browsers restrict CSV fetching from local files. For example, with Python installed:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000`. To check a nested deployment, open the repository subdirectory when serving its parent directory.

The scoring engine tests use only Node's built-in test runner (no installation):

```powershell
node --test tests\engine.test.cjs
```
