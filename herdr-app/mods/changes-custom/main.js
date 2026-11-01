import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, Popover } from "gpui-base";
import { loadIcons, fileIcon } from "./fileicons.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, run, shared, setShared, openOverlay, nextCommand } from "herdr";

// Which folder the panel shows. A focused file or diff tab has no folder of its own: use the one it
// was opened from (recorded in shared "tab-views"), else what this space showed last. Remembered per
// space, so landing on a file/diff tab in another space never keeps the previous space's folder.
const lastBySpace = {};
function location() {
  const f = focused(), mine = f?.pane && panes().find(p => p.pane === f.pane);
  if (mine && !mine.terminal && (mine.mod === "file-tab" || mine.mod === "diff-tab" || mine.mod === "git-graph")) {
    const rec = (shared("tab-views") ?? {})[f.tab];
    if (rec?.cwd) return { cwd: rec.cwd, on: rec.on ?? null, space: f.space };
    if (lastBySpace[f.space]) return lastBySpace[f.space];
  }
  const now = here();
  if (now.space) lastBySpace[now.space] = now;
  return now;
}
function here() {
  const f = focused(), space = spaces().find(s => s.id === f?.space) ?? spaces().find(s => s.active);
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
// Opening a file or diff as a tab: if it's open in any tab already, go there; else make one.
// shared("tab-views") maps tab id -> what it shows. A new tab shows up in spaces() a moment
// after tab.new returns, so it's recorded once it appears.
const pending = new Set();
function openTab(cx, mod, name, view, tabProps, where) {
  if (pending.has(view)) return;
  const all = () => spaces().flatMap(s => s.tabs), views = shared("tab-views") ?? {};
  const open = all().find(t => (views[t.id]?.view ?? views[t.id]) === view);
  if (open) return run("tab.select", { id: open.id });
  const before = new Set(all().map(t => t.id));
  pending.add(view);
  run("tab.new", { space: focused()?.space, name, mod, props: tabProps });
  cx.spawn(async cx => {
    try {
      for (let i = 0; i < 40; i++) {
        const made = all().find(t => !before.has(t.id) && t.name === name);
        if (made) {
          const ids = new Set(all().map(t => t.id)), now = shared("tab-views") ?? {};
          setShared("tab-views", { ...Object.fromEntries(Object.entries(now).filter(([id]) => ids.has(id))), [made.id]: { view, cwd: where.cwd, on: where.on } });
          return;
        }
        await cx.sleep(50);
      }
    } finally { pending.delete(view); }
  });
}
const key = () => JSON.stringify(location());
// Review scopes (from vytasgavelis/herdr-reviewer): what the working tree is compared against.
// shared("changes.scope") maps "<machine>:<repo>" -> { scope, ref, label }; diff tabs read it to follow.
const SCOPE = "changes.scope";
// A commit's age, short, as the Git Graph shows it: "now", "12m", "3h", "6d", "Oct 3", "Mar 2025".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ago(seconds) {
  if (!seconds) return "";
  const s = Date.now() / 1000 - seconds;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  const d = new Date(seconds * 1000);
  return d.getFullYear() === new Date().getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's empty tree: "before" a root commit
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    loadIcons(cx);
    this.tree = localStorage.getItem("view") === "tree"; this.collapsed = new Set();
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // Staged / Changes sections (Uncommitted only): which are folded, which row the pointer is on.
    this.foldedSections = new Set(); this.hovered = null;
    // Discards wait for the confirm dialog, which runs "changes-custom.discard".
    cx.spawn(async (cx) => { for (;;) { if (await nextCommand() === "discard") this.discardNow(cx); } });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // Forget the previous repo's list, diff, message and notes.
  reset() {
    this.sections = null; this.pendingDiscard = null;
    this.root = null; this.files = []; this.open = null;
    this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    this.again = false;
    const { cwd, on } = location(), context = key();
    // Another folder: keep what's shown until it's known to be another repo (a file or diff tab
    // follows its repo's folder, so focusing one usually lands in the same repo; clearing would flash).
    if (context !== this.context) this.context = context;
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0 || top.stdout.trim() !== this.root || (on ?? null) !== (this.on ?? null)) this.reset();
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const hasHead = (await git(["rev-parse", "--verify", "HEAD"])).code === 0;
        // The scopes this repo offers, and the one in use (remembered per repo).
        const info = hasHead ? await this.scopes(git) : { branch: null, base: null, last: null, merge: null };
        const repoKey = `${on ?? ""}:${root}`;
        let scope = (shared(SCOPE) ?? {})[repoKey]?.scope ?? (info.merge ? "branch" : "work");
        if (scope === "branch" && !info.merge) scope = "work";
        if (scope !== "work" && scope !== "branch" && !scope.startsWith("commit:")) scope = "work"; // e.g. the old "last"
        // "commit:<hash>": only that commit's changes (its parent -> it). Gone (rebased) -> Uncommitted.
        const picked = scope.startsWith("commit:") ? info.commits.find((c) => c.hash === scope.slice(7)) : null;
        if (scope.startsWith("commit:") && !picked) scope = "work";
        const ref = scope === "branch" ? info.merge : picked ? picked.before : "HEAD", to = picked ? picked.hash : null;
        const range = to ? [ref, to] : [ref];
        // Files: what differs from the scope's ref, plus untracked files and conflicts from the status.
        const stats = {}, changed = new Map();
        const results = hasHead ? [await git(["diff", ...range, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        if (hasHead) {
          const names = await git(["diff", ...range, "--name-status", "-z", "--no-renames"]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0");
          for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) changed.set(parts[i + 1], parts[i][0]);
        }
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of to ? [] : entries) {
          const xy = entry.slice(0, 2), path = entry.slice(3);
          if (xy === "??") changed.set(path, "?");
          else if (xy.includes("U") || xy === "AA" || xy === "DD") changed.set(path, "U");
          else if (!hasHead) changed.set(path, xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M");
        }
        const files = [];
        for (const [path, s0] of [...changed.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 1000)) {
          const fresh = s0 === "?", st = fresh ? "A" : s0 === "D" || s0 === "A" || s0 === "U" ? s0 : "M";
          files.push({ path, status: st, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        // Uncommitted: also split into what's staged (index vs HEAD) and what isn't (working tree vs
        // index, plus untracked files and conflicts). A file can be in both.
        let sections = null;
        if (scope === "work" && hasHead) {
          const [cached, work] = await Promise.all([git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), git(["diff", "--numstat", "-z", "--no-renames"])]);
          const numstat = (r) => {
            const out = {};
            for (const entry of r.code === 0 ? r.stdout.split("\0") : []) {
              const [a, d, ...parts] = entry.split("\t");
              if (parts.length) out[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
            }
            return out;
          };
          const sStats = numstat(cached), uStats = numstat(work), staged = [], unstaged = [];
          const letter = (c) => c === "A" || c === "D" ? c : "M";
          for (const entry of entries) {
            const x = entry[0], y = entry[1], path = entry.slice(3);
            if (x === "?") unstaged.push({ path, status: "A", fresh: true, add: 0, del: 0 });
            else if (x === "U" || y === "U" || entry.startsWith("AA") || entry.startsWith("DD")) unstaged.push({ path, status: "U", conflict: true, ...(uStats[path] ?? { add: 0, del: 0 }) });
            else {
              if (x !== " ") staged.push({ path, status: letter(x), ...(sStats[path] ?? { add: 0, del: 0 }) });
              if (y !== " ") unstaged.push({ path, status: letter(y), ...(uStats[path] ?? { add: 0, del: 0 }) });
            }
          }
          const byPath = (a, b) => a.path.localeCompare(b.path);
          sections = { staged: staged.sort(byPath).slice(0, 1000), unstaged: unstaged.sort(byPath).slice(0, 1000) };
        }
        if (key() !== context) return;
        this.sections = sections;
        this.root = root; this.on = on; this.hasHead = hasHead; this.files = files; this.limited = changed.size > 1000; this.error = null;
        // A picked commit's message: subject plus its long description (body), shown where the commit box is.
        const body = picked ? await git(["show", "-s", "--format=%b", picked.hash]) : null;
        if (key() !== context) return;
        this.picked = picked ? { short: picked.short, subject: picked.subject, body: body?.code === 0 ? body.stdout.trim() : "" } : null;
        this.scope = scope; this.scopeInfo = info;
        this.publishScope(repoKey, scope, ref, to);
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); if (this.again) this.refresh(cx); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    if (!this.root) return;
    openTab(cx, "diff-tab", path.split("/").pop() + " (diff)", `diff:${this.on ?? ""}:${this.root}/${path}`, { root: this.root, path, on: this.on ?? null }, { cwd: location().cwd ?? this.root, on: this.on ?? null });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        // Something staged: commit just that. Nothing staged: commit everything (as before).
        const onlyStaged = Boolean(this.sections?.staged.length);
        for (const args of onlyStaged ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // ---- staging ----

  // Runs git commands that change the index or working tree, then shows the result.
  mutate(commands, cx) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of commands) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { if (key() === context) this.note = String(e.message ?? e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stage(files, cx) {
    if (files.length) this.mutate([["add", "-A", "--", ...files.map((f) => f.path)]], cx);
  }

  unstage(files, cx) {
    if (files.length) this.mutate([["restore", "--staged", "--", ...files.map((f) => f.path)]], cx);
  }

  // Asks first; the confirm dialog runs "changes-custom.discard", which lands in discardNow.
  discardFiles(files) {
    files = files.filter((f) => !f.conflict);
    if (!files.length) return;
    const fresh = files.filter((f) => f.fresh).length, one = files.length === 1;
    this.pendingDiscard = { root: this.root, on: this.on, files };
    openOverlay({ mod: "confirm", kind: "dialog", width: 440, height: 190, props: {
      title: one ? `Discard changes to ${files[0].path.split("/").pop()}?` : `Discard changes to ${files.length} files?`,
      detail: `Unstaged changes are lost${fresh ? `, and ${fresh === files.length ? (one ? "this new file is" : "these new files are") : `${fresh} new file${fresh > 1 ? "s are" : " is"}`} deleted` : ""}. Staged changes stay. This can't be undone.`,
      command: { name: "changes-custom.discard" } } });
  }

  discardNow(cx) {
    const p = this.pendingDiscard;
    this.pendingDiscard = null;
    if (!p || p.root !== this.root || (p.on ?? null) !== (this.on ?? null)) return;
    const fresh = p.files.filter((f) => f.fresh).map((f) => f.path), tracked = p.files.filter((f) => !f.fresh).map((f) => f.path);
    this.mutate([...(tracked.length ? [["restore", "--worktree", "--", ...tracked]] : []), ...(fresh.length ? [["clean", "-f", "-q", "--", ...fresh]] : [])], cx);
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // What this repo can be reviewed against: its branch, the base branch (origin/HEAD, else main,
  // else master), the merge base with it (null when on the base itself), and HEAD's short hash
  // when it has a parent. From vytasgavelis/herdr-reviewer.
  async scopes(git) {
    const out = async (args) => { const r = await git(args); return r.code === 0 ? r.stdout.trim() : null; };
    const branch = await out(["rev-parse", "--abbrev-ref", "HEAD"]);
    let base = null;
    { const h = await out(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]); if (h) base = h.replace(/^refs\/remotes\/origin\//, ""); }
    if (!base) for (const b of ["main", "master"]) { if (await out(["rev-parse", "--verify", "-q", `refs/heads/${b}`]) !== null) { base = b; break; } }
    let merge = null;
    if (base && branch !== base) {
      const baseRef = (await out(["rev-parse", "--verify", "-q", `refs/heads/${base}`])) !== null ? base : `origin/${base}`;
      merge = await out(["merge-base", baseRef, "HEAD"]);
      if (merge && (await out(["rev-parse", "HEAD"])) === merge) merge = null;
    }
    // The branch's commits since it left the base (on the base itself: the latest), newest first, at most 20.
    // `before` is what a commit is compared from: its parent, or the empty tree for a root commit.
    const log = await out(["log", "-n", "20", "--format=%H%x1f%h%x1f%P%x1f%s%x1f%ct%x1e", ...(merge ? [`${merge}..HEAD`] : ["HEAD"])]);
    const commits = (log ?? "").split("\x1e").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [hash, short, parents, subject, ct] = l.split("\x1f");
      return { hash, short, subject, at: Number(ct) || 0, before: parents ? `${hash}~1` : EMPTY_TREE };
    });
    return { branch, base, merge, commits };
  }

  scopeLabel(scope = this.scope) {
    if (scope.startsWith("commit:")) return `Commit ${scope.slice(7, 14)}`;
    return scope === "branch" ? `vs ${this.scopeInfo?.base}` : "Uncommitted";
  }

  // Tells diff tabs of this repo what to compare against (only when it changed).
  // The scope in words, for messages to an agent.
  scopeWords(scope = this.scope) {
    const i = this.scopeInfo ?? {};
    if (scope === "branch") return `all changes on branch ${i.branch} since it left ${i.base} (merge base ${(i.merge ?? "").slice(0, 7)}), committed or not`;
    if (scope.startsWith("commit:")) return `only the changes of commit ${scope.slice(7, 14)}${this.picked?.subject ? ` ("${this.picked.subject}")` : ""}`;
    return "uncommitted changes";
  }

  // ---- review: draft comments made in diff tabs, kept in shared "review.drafts" per repo and scope ----
  draftKey() { return `${this.on ?? ""}:${this.root}:${this.scope}`; }
  drafts() { return this.root ? (shared("review.drafts") ?? {})[this.draftKey()] ?? [] : []; }
  discard() {
    const all = { ...(shared("review.drafts") ?? {}) };
    delete all[this.draftKey()];
    setShared("review.drafts", all);
  }
  // A file's change in words, for a whole-file comment: "added, binary".
  describe(path) {
    const f = this.files.find((f) => f.path === path);
    if (!f) return "no longer changed";
    const what = f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "U" ? "conflict" : "modified";
    return f.binary ? `${what}, binary` : f.add || f.del ? `${what}, +${f.add} −${f.del}` : what;
  }
  // Every comment, with the lines it was made on, as one review message for the send dialog.
  submit() {
    const comments = this.drafts();
    if (!comments.length) return;
    const list = [...comments].sort((a, b) => a.path.localeCompare(b.path) || (a.whole ? -1 : 0) - (b.whole ? -1 : 0) || (a.from?.number ?? -1) - (b.from?.number ?? -1));
    const parts = list.map((c) => {
      if (c.whole) return `### ${c.path}, whole file (${this.describe(c.path)})\n\nComment: ${c.text}`;
      const span = c.from.number === c.to.number ? `line ${c.from.number}` : `lines ${c.from.number}-${c.to.number}`;
      const body = c.quote ?? `${String(c.from.number).padStart(5)} ${c.from.kind} ${c.from.text}`;
      return `### ${c.path}, ${span}\n${body}\n\nComment: ${c.text}`;
    });
    const n = list.length, title = `Review · ${n} comment${n > 1 ? "s" : ""}`;
    const context = `Code review of ${this.root}${this.on ? ` (on ${this.on})` : ""}: ${this.scopeWords()}. ${n} comment${n > 1 ? "s" : ""}. Line numbers are new-file numbers; "-" lines are removed.\n\n${parts.join("\n\n")}`;
    openOverlay({ mod: "send-dialog", kind: "dialog", width: 680, height: 560, props: { title, context, clear: this.draftKey() } });
  }

  publishScope(repoKey, scope, ref, to) {
    const all = shared(SCOPE) ?? {}, next = { scope, ref, to, label: this.scopeLabel(scope), words: this.scopeWords(scope) };
    if (JSON.stringify(all[repoKey]) !== JSON.stringify(next)) setShared(SCOPE, { ...all, [repoKey]: next });
  }

  setScope(scope, cx) {
    this.choosingScope = false;
    if (!this.root || scope === this.scope) { cx.notify(); return; }
    const repoKey = `${this.on ?? ""}:${this.root}`, all = shared(SCOPE) ?? {};
    setShared(SCOPE, { ...all, [repoKey]: { ...(all[repoKey] ?? {}), scope } });
    this.scope = scope; this.files = [];
    this.refresh(cx); cx.notify();
  }

  // A select-looking box with the scope's name; its popover lists the scopes the repo offers.
  scopePicker(t) {
    const i = this.scopeInfo ?? {};
    const commits = i.commits ?? [];
    const options = [
      { scope: "work", label: "Uncommitted", detail: "working tree vs HEAD", ok: true },
      { scope: "branch", label: i.base ? `vs ${i.base}` : "vs base branch", detail: i.merge ? `everything on ${i.branch} since it left ${i.base}` : i.base ? `on ${i.base} itself` : "no main or master branch", ok: Boolean(i.merge) },
      ...commits.map((c, n) => ({ scope: `commit:${c.hash}`, label: c.subject, when: ago(c.at),
        ok: true, first: n === 0 })),
    ];
    const box = h_flex().id("scope-box").h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(this.choosingScope ? t.accent : t.border).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("Compare against: uncommitted changes, the whole branch, or from a commit on it")
      .child(div().text_size(12).child(this.scopeLabel())).child(svg("mods/changes-custom/chevron-down.svg").size(11).text_color(t.dim));
    return Popover.new("scope").open(Boolean(this.choosingScope)).on_open_change((open, cx) => { this.choosingScope = open; cx.notify(); })
      .trigger(box)
      // A fixed height (rows are ~48px, the heading ~26px), so the inner list has something to scroll in.
      .content(div().relative().mt(4).w(360).h(Math.min(420, 2 * 50 + commits.length * 32 + (commits.length ? 26 : 0) + 14)).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().overflow_hidden()
        .child(v_flex().id("scope-list").size_full().overflow_y_scroll().p(6).gap(2).children(options.flatMap((o) => [
        ...(o.first ? [div().px(10).pt(8).pb(2).text_size(10).text_color(t.dim).child(i.merge ? `COMMITS ON ${String(i.branch).toUpperCase()}` : "RECENT COMMITS")] : []),
        // The chosen scope is a filled row (no tick).
        h_flex().id(`scope-${o.scope}`).px(10).py(7).gap(10).items_center().rounded(6)
          .when(o.scope === this.scope, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
          .when(o.ok && o.scope !== this.scope, (e) => e.hover((s) => s.bg(t.hover)))
          .when(o.ok, (e) => e.cursor_pointer().on_click((_e, cx) => this.setScope(o.scope, cx))).when(!o.ok, (e) => e.opacity(0.5))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12).truncate().child(o.label)).when(Boolean(o.detail), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(o.detail))))
          .when(Boolean(o.when), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(o.when)))])))
        .child(Scrollbar.vertical("scope-list").absolute().inset_0()));
  }

  statusColor(f, t) { return f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked; }

  // One changed file. List view shows its folder dimmed before the name; tree view indents it.
  fileRow(f, t, depth, section = null) {
    const parts = f.path.split("/"), name = parts.pop(), id = `${section ?? "all"}:${f.path}`, hovered = section && this.hovered === id;
    return h_flex().id(`change-${id}`).h(28).flex_none().pl(depth === null ? 8 : 8 + depth * 16 + 18).pr(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(14).flex_none().text_size(11).text_color(this.statusColor(f, t)).child(f.status))
      .child(fileIcon(f.path, false, false, 14, "mods/files-custom/file.svg", t.muted))
      .child(h_flex().flex_1().min_w(0).when(depth === null && parts.length > 0, (e) => e.child(div().text_color(t.dim).truncate().child(parts.join("/") + "/"))).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(Boolean(this.counts?.[f.path]), (e) => e.child(h_flex().h(18).px(5).gap(3).flex_none().items_center().rounded(4).bg(t.accent + "33").text_size(10)
        .tooltip(`${this.counts[f.path]} draft comment${this.counts[f.path] > 1 ? "s" : ""}`).child(svg("mods/changes-custom/comment.svg").size(10)).child(String(this.counts[f.path]))))
      .when(Boolean(section), (e) => e.on_hover((on, cx) => { if (on) this.hovered = id; else if (this.hovered === id) this.hovered = null; cx.notify(); }))
      .when(hovered, (e) => e.children(this.actions(section, [f], t, `f-${id}`)))
      .when(!hovered && f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(!hovered && f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // A section's buttons, for one file or all of them: Changes has discard and stage, Staged has unstage.
  actions(section, files, t, id) {
    const all = files.length !== 1 || id.startsWith("s-");
    const icon = (key, path, tip, action) => div().id(`${id}-${key}`).flex_none().p(3).rounded(4).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(`mods/changes-custom/${path}.svg`).size(13));
    if (section === "staged") return [icon("unstage", "minus", all ? "Unstage all" : "Unstage", (cx) => this.unstage(files, cx))];
    return [
      ...(files.some((f) => !f.conflict) ? [icon("discard", "discard", all ? "Discard all changes…" : "Discard changes…", () => this.discardFiles(files))] : []),
      icon("stage", "plus", all ? "Stage all" : "Stage", (cx) => this.stage(files, cx)),
    ];
  }

  // The Staged and Changes sections, each foldable, as a list or a tree.
  sectionRows(t) {
    const out = [];
    for (const [section, title] of [["staged", "Staged"], ["unstaged", "Changes"]]) {
      const files = this.sections[section];
      if (section === "staged" && !files.length) continue;
      const open = !this.foldedSections.has(section);
      out.push(h_flex().id(`section-${section}`).h(26).flex_none().mt(section === "unstaged" && this.sections.staged.length ? 6 : 0).pl(4).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open ? this.foldedSections.add(section) : this.foldedSections.delete(section); cx.notify(); })
        .child(svg(`mods/files-custom/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
        .child(div().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(files.length)))
        .child(div().flex_1())
        .when(files.length > 0, (e) => e.children(this.actions(section, files, t, `s-${section}`))));
      if (!open) continue;
      if (!files.length) out.push(div().px(26).py(4).text_size(12).text_color(t.dim).child("No unstaged changes"));
      else out.push(...(this.tree ? this.treeRows(t, files, section) : files.map((f) => this.fileRow(f, t, null, section))));
    }
    return out;
  }

  // Folder tree of the changed files; folders with one subfolder and no files are joined (a/b/c).
  treeRows(t, files = this.files, section = null) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      let node = root;
      for (const part of f.path.split("/").slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(f);
    }
    const out = [];
    const walk = (node, prefix, depth) => {
      for (const [dirName, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        let label = dirName, dir = child, path = prefix + dirName;
        while (dir.files.length === 0 && dir.dirs.size === 1) {
          const [[n, c]] = [...dir.dirs];
          label += "/" + n; path += "/" + n; dir = c;
        }
        const fold = `${section ?? ""}:${path}`, open = !this.collapsed.has(fold);
        out.push(h_flex().id(`dir-${fold}`).h(28).flex_none().pl(8 + depth * 16).pr(8).gap(6).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { open ? this.collapsed.add(fold) : this.collapsed.delete(fold); cx.notify(); })
          .child(svg(`mods/files-custom/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
          .child(fileIcon(path, true, open, 14, "mods/files-custom/folder.svg", t.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(label)));
        if (open) walk(dir, path + "/", depth + 1);
      }
      for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push(this.fileRow(f, t, depth, section));
    };
    walk(root, "", 0);
    return out;
  }

  render(cx) {
    this.counts = {};
    for (const c of this.drafts()) this.counts[c.path] = (this.counts[c.path] ?? 0) + 1;
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const sectioned = Boolean(this.sections && (this.sections.staged.length || this.sections.unstaged.length));
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .when(Boolean(this.root && this.hasHead), (e) => e.child(this.scopePicker(t)))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().id("view-toggle").p(4).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.tree ? "Show as list" : "Show as folder tree")
          .on_click((_e, cx) => { this.tree = !this.tree; localStorage.setItem("view", this.tree ? "tree" : "list"); cx.notify(); })
          .child(svg(this.tree ? "mods/workspace-chrome/file-text.svg" : "mods/files-custom/folder.svg").size(14))))
      .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(sectioned ? this.sectionRows(t) : this.tree ? this.treeRows(t) : this.files.map((f) => this.fileRow(f, t, null))).when(!this.files.length && !sectioned, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.scope === "work" ? "No uncommitted changes" : this.scope.startsWith("commit:") ? "No file changes in this commit" : "No changes") : "No folder")))))
      .when(this.drafts().length > 0, (e) => e.child(h_flex().flex_none().h(40).px(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(svg("mods/changes-custom/comment.svg").size(13).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(`${this.drafts().length} draft comment${this.drafts().length > 1 ? "s" : ""}`))
        .child(div().id("review-discard").h(26).px(8).flex().items_center().rounded(6).text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Delete these draft comments").on_click(() => this.discard()).child("Discard"))
        .child(div().id("review-submit").h(26).px(10).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium().cursor_pointer().hover((s) => s.opacity(0.88))
          .tooltip("Send every comment, with its lines, to an agent").on_click(() => this.submit()).child("Submit review"))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(Boolean(this.picked && this.scope.startsWith("commit:")), (e) => e.child(this.commitInfo(t)))
      .when(this.scope === "work" || !this.hasHead, (e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }

  // The picked commit: short hash, subject, and its long description in a fixed-height (160px) area that scrolls.
  commitInfo(t) {
    const { short, subject, body } = this.picked;
    return v_flex().flex_none().px(14).py(10).gap(6).border_t(1).border_color(t.border)
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).font_family(settings().font_family ?? "JetBrains Mono").child(short))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().child(subject)))
      .child(body
        ? div().relative().h(160).flex_none()
            .child(div().id("commit-body").size_full().overflow_y_scroll().pr(10)
              .child(div().text_size(13).text_color(t.muted).whitespace_normal().child(body)))
            .child(Scrollbar.vertical("commit-body").absolute().inset_0())
        : div().text_size(13).text_color(t.dim).child("No long description"));
  }
}
