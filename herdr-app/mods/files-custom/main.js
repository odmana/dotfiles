// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// Ours: the header's Collapse all and Find active file buttons; the active file (the focused file or
// diff tab's) is highlighted. The tree is a virtual list so Find active file can scroll to it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { loadIcons, fileIcon } from "./fileicons.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, shared, setShared } from "herdr";

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
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    loadIcons(cx);
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.scroll = VirtualListScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  collapseAll(cx) {
    for (const folder of this.folders) this.entries.delete(folder);
    this.folders.clear();
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  // The focused tab's file, relative to the folder shown: a file tab's file, or the file a diff tab
  // compares (its view, recorded in shared "tab-views": "file:<machine>:<path>" or
  // "diff:<machine>:<path>[@commit]"). Null when it's elsewhere or the tab isn't one of those.
  activeFile() {
    const f = focused(), rec = f?.tab ? (shared("tab-views") ?? {})[f.tab] : null, view = rec?.view ?? rec;
    const m = typeof view === "string" ? view.match(/^(file|diff):([^:]*):(.*)$/) : null;
    if (!m || !this.root || (m[2] || null) !== (this.on ?? null)) return null;
    const file = m[1] === "diff" ? m[3].replace(/@[0-9a-f]{7,40}$/, "") : m[3];
    return file.startsWith(`${this.root}/`) ? file.slice(this.root.length + 1) : null;
  }

  // Open the folders down to the active file, then scroll to it (render does, once its row exists).
  reveal(cx) {
    const path = this.activeFile();
    if (!path) return;
    if (this.file) this.show(null);
    const context = this.context, parts = path.split("/");
    cx.spawn(async cx => {
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        this.folders.add(dir);
        if (!this.entries.has(dir)) {
          try { await this.loadFolder(dir, context); } catch (e) { if (this.current(context)) this.error = String(e); }
        }
        if (!this.current(context)) return;
      }
      this.revealing = path;
      cx.notify();
    });
  }

  // The tree's visible rows, in order: { path, entry, depth, open, mark }.
  rows(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      out.push({ path, entry, depth, open, mark: this.marks[`${this.root}/${path}`] });
      if (entry.dir && open) this.rows(path, depth + 1, out);
    }
    return out;
  }

  // A row's click (the list's on_item_click: handlers can't be set inside its renderer).
  click({ path, entry }, cx) {
    if (entry.dir) this.toggle(path, cx);
    else openTab(cx, "file-tab", entry.name, `file:${this.on ?? ""}:${this.root}/${path}`, { file: `${this.root}/${path}`, on: this.on ?? null }, { cwd: this.root, on: this.on ?? null });
  }

  row({ path, entry, depth, open, mark }, active, t) {
    return h_flex().id(`file-${path}`).h(28).w_full().flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .when(path === active, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .child(entry.dir ? svg(`mods/files-custom/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(fileIcon(path, entry.dir, open, 14, `mods/files-custom/${entry.dir ? "folder" : "file"}.svg`, t.muted))
      .child(div().flex_1().min_w(0).truncate().child(entry.name))
      .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), rows = this.file ? [] : this.rows("", 0, []), active = this.activeFile();
    if (this.revealing) {
      const at = rows.findIndex(r => r.path === this.revealing);
      if (at >= 0) this.scroll.scroll_to_item(at, "center");
      this.revealing = null;
    }
    const iconButton = (id, icon, tip, action, enabled = true) => div().id(id).flex_none().p(4).rounded(5)
      .text_color(enabled ? t.muted : t.dim).tooltip(tip)
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(svg(`mods/files-custom/${icon}.svg`).size(14));
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.root) && !this.file, el => el
          .child(iconButton("files-reveal", "locate", active ? "Find active file" : "Find active file (no file tab focused in this folder)", (_e, cx) => this.reveal(cx), Boolean(active)))
          .child(iconButton("files-collapse", "collapse", "Collapse all", (_e, cx) => this.collapseAll(cx), this.folders.size > 0))))
      .when(!this.file, el => el
        .when(rows.length > 0, el => el.child(div().flex_1().min_h(0).relative().p(6)
          .child(v_virtual_list("files-tree", rows.length, 28, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map(r => this.row(r, active, t)))
            .track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => { const r = rows.find(r => r.path === key); if (r) this.click(r, cx); }))
          .child(Scrollbar.vertical("files-tree").absolute().inset_0())))
        .when(Boolean(this.error) || !rows.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
