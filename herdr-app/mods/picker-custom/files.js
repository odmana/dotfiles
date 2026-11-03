// Ours: files for the picker, so cmd-p opens files as well as tabs. The listing, fuzzy match and
// opening came from the old file finder mod (since removed); the opening matches the Files panel.
import { exec, run, spaces, panes, focused, shared, setShared } from "herdr";

export const LIMIT = 50000;

// The folder you're in: in a file, diff or graph tab, that tab's folder (shared "tab-views");
// else the focused terminal's, else the space's. As the tab bar's Graph button works it out.
export function here() {
  const f = focused(), space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal && ["file-tab", "diff-tab", "git-graph"].includes(pane.mod)) {
    const rec = (shared("tab-views") ?? {})[f.tab];
    if (rec?.cwd) return { cwd: rec.cwd, on: rec.on ?? null };
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// { root, on, files, total }: the repo's files (tracked and untracked, minus ignored ones) from its
// top folder, else every file under the folder (skipping .git and node_modules), up to LIMIT.
export async function listFiles() {
  const { cwd, on } = here();
  if (!cwd) return null;
  const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off"];
  const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const root = top?.code === 0 ? top.stdout.trim() : cwd;
  let list;
  const git = top?.code === 0 ? await exec("git", [...READ, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, on }) : null;
  if (git?.code === 0) list = [...new Set(git.stdout.split("\0").filter(Boolean))];
  else {
    const r = await exec("sh", ["-c", `find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print | head -n ${LIMIT}`], { cwd: root, on });
    if (r.code !== 0) return null;
    list = r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
  }
  return { root, on, files: list.slice(0, LIMIT), total: list.length };
}

// Fuzzy match: every query character in order. Scores favour matches in the file name, at the
// start of a word (after / . _ - or a lower-to-upper change) and runs of consecutive characters.
// Returns { score, hits } (hit positions in path) or null.
export function match(path, query) {
  if (!query) return { score: 0, hits: [] };
  const lower = path.toLowerCase(), base = path.lastIndexOf("/") + 1;
  let at = 0;
  for (const c of query) { at = lower.indexOf(c, at); if (at < 0) return null; at++; }
  const hits = [];
  let score = 0, prev = -2, from = 0;
  const inName = (() => { let i = base; for (const c of query) { i = lower.indexOf(c, i); if (i < 0) return false; i++; } return true; })();
  if (inName) from = base;
  for (const c of query) {
    let i = lower.indexOf(c, from);
    const start = (j) => j === 0 || "/._- ".includes(path[j - 1]) || (path[j] !== lower[j] && path[j - 1] === path[j - 1].toLowerCase());
    if (i !== prev + 1 && !start(i)) {
      for (let j = lower.indexOf(c, i + 1); j >= 0 && j < i + 40; j = lower.indexOf(c, j + 1)) if (start(j)) { i = j; break; }
    }
    hits.push(i);
    score += 1;
    if (i === prev + 1) score += 5;
    if (start(i)) score += 4;
    if (i >= base) score += 2;
    prev = i; from = i + 1;
  }
  if (lower.slice(base).startsWith(query)) score += 10;
  if (lower.slice(base) === query || lower.slice(base).split(".")[0] === query) score += 15;
  return { score: score - path.length * 0.02, hits };
}

// The best `count` matches for a query, best first.
export function best(files, query, count) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const found = [];
  for (const path of files) { const m = match(path, q); if (m) found.push({ path, ...m }); }
  found.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return found.slice(0, count);
}

// Open as a file tab, or go to the tab already showing it. The tab is recorded in shared
// "tab-views" (as the Files panel does) before `done` runs, since closing the picker ends this copy.
export function openFile(cx, root, on, path, done) {
  const file = `${root}/${path}`, view = `file:${on ?? ""}:${file}`, name = path.split("/").pop();
  const all = () => spaces().flatMap((s) => s.tabs), views = shared("tab-views") ?? {};
  const open = all().find((t) => (views[t.id]?.view ?? views[t.id]) === view);
  if (open) { run("tab.select", { id: open.id }); return done(); }
  const before = new Set(all().map((t) => t.id));
  run("tab.new", { space: focused()?.space, name, mod: "file-tab", props: { file, on } });
  cx.spawn(async (cx) => {
    for (let i = 0; i < 40; i++) {
      const made = all().find((t) => !before.has(t.id) && t.name === name);
      if (made) {
        const ids = new Set(all().map((t) => t.id)), now = shared("tab-views") ?? {};
        setShared("tab-views", { ...Object.fromEntries(Object.entries(now).filter(([id]) => ids.has(id))), [made.id]: { view, cwd: root, on } });
        break;
      }
      await cx.sleep(50);
    }
    done();
  });
}
