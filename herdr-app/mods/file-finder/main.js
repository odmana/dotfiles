// Find a file by typing parts of its path (fuzzy), then open it as a file tab.
// Opened as a dialog by the Files panel's search button. props: { root, on, overlay }.
// The list is the repo's files (tracked and untracked, minus ignored ones), else every file under
// the folder (skipping .git and node_modules), up to 50,000.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { props, exec, run, closeOverlay, theme, spaces, focused, shared, setShared } from "herdr";
import { loadIcons, fileIcon } from "./fileicons.js";

const LIMIT = 50000, SHOWN = 300, ROW = 34;

// Fuzzy match: every query character in order. Scores favour matches in the file name, at the
// start of a word (after / . _ - or a lower-to-upper change) and runs of consecutive characters.
// Returns { score, hits } (hit positions in path) or null.
function match(path, query) {
  if (!query) return { score: 0, hits: [] };
  const lower = path.toLowerCase(), base = path.lastIndexOf("/") + 1;
  // A plain left-to-right pass tells whether it matches at all.
  let at = 0;
  for (const c of query) { at = lower.indexOf(c, at); if (at < 0) return null; at++; }
  const hits = [];
  let score = 0, prev = -2, from = 0;
  // Prefer starting inside the file name when the whole query fits there.
  const inName = (() => { let i = base; for (const c of query) { i = lower.indexOf(c, i); if (i < 0) return false; i++; } return true; })();
  if (inName) from = base;
  for (const c of query) {
    let i = lower.indexOf(c, from);
    // Look ahead for the same character at a word start, which reads better than the first hit.
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

export default class FileFinder extends View {
  init(_props, cx) {
    loadIcons(cx);
    this.files = undefined; this.error = ""; this.text = ""; this.at = 0;
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ value: "", placeholder: "Find a file by name or path" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.results = null; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.open(this.shown()[this.at], cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
    const { root, on = null } = props() ?? {};
    if (!root) { this.error = "No folder"; return; }
    cx.spawn(async (cx) => {
      try {
        const git = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, on });
        let list;
        if (git.code === 0) list = [...new Set(git.stdout.split("\0").filter(Boolean))];
        else {
          const r = await exec("sh", ["-c", `find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print | head -n ${LIMIT}`], { cwd: root, on });
          if (r.code !== 0) throw new Error(r.stderr || "can't list files");
          list = r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
        }
        this.total = list.length;
        this.files = list.slice(0, LIMIT);
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  // The best matches, best first; with no query, the files as listed.
  shown() {
    if (!this.files) return [];
    if (this.results) return this.results;
    const q = this.text.toLowerCase().replace(/\s+/g, "");
    if (!q) return (this.results = this.files.slice(0, SHOWN).map((path) => ({ path, hits: [] })));
    const found = [];
    for (const path of this.files) { const m = match(path, q); if (m) found.push({ path, ...m }); }
    found.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    this.count = found.length;
    return (this.results = found.slice(0, SHOWN));
  }

  move(by, cx) {
    const n = this.shown().length;
    if (!n) return;
    this.at = (this.at + by + n) % n;
    this.scroll.scroll_to_item(this.at);
    cx.notify();
  }

  // Open as a file tab, or go to the tab already showing it. The tab is recorded in shared
  // "tab-views" (as the Files panel does) before the dialog closes, since closing ends this copy.
  open(item, cx) {
    if (!item || this.opening) return;
    const { root, on = null } = props(), file = `${root}/${item.path}`, view = `file:${on ?? ""}:${file}`, name = item.path.split("/").pop();
    const all = () => spaces().flatMap((s) => s.tabs), views = shared("tab-views") ?? {};
    const open = all().find((t) => (views[t.id]?.view ?? views[t.id]) === view);
    if (open) { run("tab.select", { id: open.id }); return this.close(); }
    const before = new Set(all().map((t) => t.id));
    this.opening = true;
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
      this.close();
    });
  }

  close() { closeOverlay(props().overlay); }

  key(e, cx) {
    if (e.key === "escape") { cx.stop_propagation(); return this.close(); }
    if (e.key === "down" || (e.key === "n" && e.modifiers?.control)) { cx.stop_propagation(); this.move(1, cx); }
    else if (e.key === "up" || (e.key === "p" && e.modifiers?.control)) { cx.stop_propagation(); this.move(-1, cx); }
    else if (e.key === "enter") { cx.stop_propagation(); this.open(this.shown()[this.at], cx); }
  }

  // The path with its matched characters picked out: dim folder, bright name.
  label(path, hits, t) {
    const base = path.lastIndexOf("/") + 1, set = new Set(hits);
    const part = (from, to, color) => {
      const out = [];
      let i = from;
      while (i < to) {
        const hit = set.has(i);
        let j = i + 1;
        while (j < to && set.has(j) === hit) j++;
        out.push(div().text_color(hit ? t.accent : color).when(hit, (e) => e.font_semibold()).child(path.slice(i, j)));
        i = j;
      }
      return out;
    };
    return h_flex().flex_1().min_w(0).gap(8).items_center().whitespace_nowrap()
      .child(h_flex().flex_none().children(part(base, path.length, t.foreground)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().text_size(11.5).children(part(0, Math.max(0, base - 1), t.dim)));
  }

  render(cx) {
    const t = theme(), rows = this.shown();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const where = (props()?.root ?? "").split("/").pop();
    const count = !this.files ? "" : this.text ? `${this.count ?? 0} of ${this.files.length}` : `${this.files.length} files`;
    return v_flex().id("file-finder").size_full().p(14).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().child(`Find file${where ? ` in ${where}` : ""}`))
        .child(div().text_size(11).text_color(t.dim).child(count)))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
      .child(this.error
        ? div().p(10).text_color(t.dim).child(this.error)
        : !this.files
          ? div().p(10).text_color(t.dim).child("Listing files…")
          : rows.length === 0
            ? div().p(10).text_color(t.dim).child("No matching files")
            : div().flex_1().min_h(0).relative()
                .child(v_virtual_list("ff-list", rows.length, ROW, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map((r, k) => {
                  const i = range.start + k, on = i === this.at;
                  return h_flex().w_full().h(ROW).px(10).gap(8).items_center().rounded(7).cursor_pointer()
                    .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
                    .child(div().flex_none().child(fileIcon(r.path, false, false, 14, "mods/file-finder/file.svg", t.dim)))
                    .child(this.label(r.path, r.hits, t));
                })).track_scroll(this.scroll).size_full()
                  .on_item_click((key, cx) => this.open(rows.find((r) => r.path === key), cx)))
                .child(Scrollbar.vertical("ff-list").absolute().inset_0()))
      .when(this.total > LIMIT, (e) => e.child(div().text_size(11).text_color(t.dim).child(`Only the first ${LIMIT.toLocaleString()} files are searched`)))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↑↓ choose · ↵ open · esc close"));
  }
}
