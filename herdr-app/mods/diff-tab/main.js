// One file's changes, opened from the Changes panel as its own tab, with review comments.
// props: { root (repo top), path (relative to root), on (machine or null) }.
// Compares against the Changes panel's scope for this repo (shared "changes.scope"), so switching
// Uncommitted / vs main / a commit there switches this tab too.
// Comments: click a line (or a hunk header) to comment, click another line to widen the range;
// "Comment on file" for the whole file. Drafts live in shared "review.drafts" under
// "<machine>:<repo>:<scope>", so every diff tab and the Changes panel (which submits them) share them.
// Right-click a line or hunk header, or "Ask about diff", to send it to an agent (mod send-dialog).
// Syntax colours, row styling and the comment flow follow vytasgavelis/herdr-reviewer.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, TextareaState, Textarea } from "gpui-base";
import { props, exec, readTextFile, watchFolder, theme, settings, shared, setShared, openOverlay } from "herdr";
import { tokenize, languageOf } from "./highlight.js";
import { palette } from "./palette.js";

// Reads write nothing under .git, so the folder watch doesn't trigger itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const NONE = "#00000000", DRAFTS = "review.drafts";
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
// The terminal's font one size down; rows 1.8x the size.
const codeSize = () => Math.max(9, (Number(settings().font_size) || 14) - 1);
const rowOf = (size) => Math.round(size * 1.8);
const charOf = (size) => size * 0.62;

// A tab opened from the Git Graph has its own fixed scope (props.scope: a commit, or uncommitted).
const scopeOf = () => {
  const { root, on, scope } = props() ?? {};
  if (scope) return scope;
  return (shared("changes.scope") ?? {})[`${on ?? ""}:${root}`] ?? { scope: "work", ref: "HEAD", label: "Uncommitted", words: "uncommitted changes" };
};
// Unified or side by side: one setting for every diff tab, kept across restarts (shared "diff.layout").
const layoutMode = () => shared("diff.layout") === "split" ? "split" : "unified";
const draftKey = () => { const { root, on } = props() ?? {}; return `${on ?? ""}:${root}:${scopeOf().scope}`; };

// A row's identity across reloads: its kind, number and text (comments anchor to these).
const desc = (r) => ({ kind: r.kind, number: r.number ?? null, text: r.text });
const descKey = (d) => `${d.kind}|${d.number}|${d.text}`;

// Numbers each diff line once and tokenizes it, so a frame only draws the rows on screen.
function diffRows(lines, lang) {
  let old = 0, next = 0, state = null, hunk = -1;
  return lines.map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; state = null; hunk = i; return { kind: "@", text: line, hunk: i, spans: [{ text: line, cls: "" }] }; }
    const kind = line[0];
    let row;
    if (kind === "-") row = { kind, number: old++, text: line.slice(1) || " " };
    else if (kind === "+") row = { kind, number: next++, text: line.slice(1) || " " };
    else if (kind === " ") row = { kind, old: old++, number: next++, text: line.slice(1) || " " };
    else row = { kind: "", text: line };
    row.hunk = hunk;
    const t = tokenize(row.text.replace(/\t/g, "    "), lang, state);
    row.spans = t.spans; state = t.state;
    return row;
  });
}

export default class DiffTab extends View {
  init(_props, cx) {
    this.rows = []; this.lines = []; this.index = new Map(); this.items = []; this.sizes = []; this.add = 0; this.del = 0;
    this.composer = null; this.noteText = ""; this.handle = cx.focus_handle();
    // Full file: the whole file with its changes in place (git diff with unlimited context).
    this.full = localStorage.getItem("full") === "1";
    this.box = TextareaState.new({ placeholder: "Leave a comment on these lines…", rows: 3 });
    this.box.set_auto_grow(3, 12);
    // Enter adds; shift-enter is the textarea's own newline, so its submit is ignored.
    this.box.on("submit", (e, cx) => { if (!e?.shift) this.addComment(cx); });
    this.box.on("change", (_e, cx) => { this.noteText = this.box.value(); if (this.composer?.editing) this.rebuild(); cx.notify(); });
    this.measure();
    this.refresh(cx);
    const { root, on } = props() ?? {};
    if (root && !on) cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(root); this.refresh(cx); } } catch {}
    });
    else cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { root, path, on = null } = props() ?? {};
    if (!root || !path) { this.note = "No file"; return; }
    const scope = scopeOf();
    this.loading = true; this.again = false; this.shownRef = `${scope.ref}..${scope.to ?? ""}`;
    // The header is complete from the first frame, so nothing jumps when the diff arrives.
    this.label = scope.label;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [rev, status] = await Promise.all([git(["rev-parse", "--verify", "HEAD"]),
          git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", path])]);
        const head = rev.code === 0;
        if (status.code !== 0) throw new Error(status.stderr);
        const xy = status.stdout.slice(0, 2);
        let lines;
        if (!scope.to && (xy === "??" || (!head && xy.includes("A")))) {
          // Untracked (or no commit yet): the whole file as one added hunk.
          const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
          if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
          else if (text.includes("\0")) lines = ["Binary file · no text diff"];
          else lines = [`@@ -0,0 +1,${countLines(text)} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 5000).map((l) => `+${l}`)];
        } else {
          const r = await git(["diff", ...(head ? [scope.ref || "HEAD", ...(scope.to ? [scope.to] : [])] : []), "--no-ext-diff", "--no-textconv", "--no-color", ...(this.full ? ["--unified=1000000"] : []), "--", path]);
          if (r.code !== 0) throw new Error(r.stderr);
          if (!r.stdout) lines = [];
          else {
            const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
            lines = first < 0 ? [r.stdout.includes("Binary files") ? "Binary file changed" : "No text diff available"] : all.slice(first, first + (this.full ? 50000 : 5000));
          }
        }
        this.setLines(lines.map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
        this.label = scope.label; this.words = scope.words;
        this.note = lines.length ? null : scope.scope === "work" ? "No uncommitted changes in this file" : scope.to ? `This file isn't changed in ${scope.label.toLowerCase()}` : `No changes in this file (${scope.label})`;
      } catch (e) { this.note = `Cannot read this diff: ${e}`; }
      finally {
        this.loading = false; this.loaded = true; cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  setLines(lines) {
    if (this.lines.length === lines.length && lines.every((l, i) => l === this.lines[i])) return;
    this.lines = lines;
    this.rows = diffRows(lines, languageOf(props()?.path));
    this.add = this.rows.filter((r) => r.kind === "+").length;
    this.del = this.rows.filter((r) => r.kind === "-").length;
    this.index = new Map();
    this.rows.forEach((r, i) => { const k = descKey(desc(r)); if (!this.index.has(k)) this.index.set(k, i); });
    this.measure();
  }

  // The gutter fits the largest line number; the diff is as wide as its longest line.
  measure() {
    this.size = codeSize(); this.row = rowOf(this.size);
    const ch = charOf(this.size), digits = String(Math.max(0, ...this.rows.map((r) => r.number ?? 0))).length;
    this.gutter = Math.max(30, Math.ceil(digits * ch + 10));
    const longest = Math.max(0, ...this.lines.map((l) => l.length));
    this.width = Math.max(300, Math.ceil(longest * ch) + this.gutter + 36);
    this.codeWidth = Math.ceil(longest * ch) + 24;

    this.rebuild();
  }

  // ---- comments -----------------------------------------------------------------------------

  drafts() { return (shared(DRAFTS) ?? {})[draftKey()] ?? []; }
  mine() { return this.drafts().filter((c) => c.path === props()?.path); }
  setDrafts(list) {
    const all = { ...(shared(DRAFTS) ?? {}) }, k = draftKey();
    if (list.length) all[k] = list; else delete all[k];
    setShared(DRAFTS, all);
  }

  // Where a row descriptor is in the current diff, or -1.
  at(d) { return d ? (this.index.get(descKey(d)) ?? -1) : -1; }

  // The list's items: diff rows, each comment under its last line; whole-file comments first.
  // The comment being edited shows what's typed in the box.
  rebuild() {
    const under = new Map(), editing = this.composer?.editing ?? null;
    this.items = []; this.mode = layoutMode();
    const split = this.mode === "split";
    for (const c of this.mine()) {
      const live = c.id === editing, text = live ? this.noteText : c.text;
      const it = { key: `c:${c.id}`, kind: "comment", id: c.id, live, text, height: this.commentHeight(text) };
      if (c.whole) { this.items.push({ ...it, whole: true, from: -1, to: -1 }); continue; }
      const from = this.at(c.from), to = this.at(c.to);
      if (from < 0 || to < 0 || to < from) continue;
      (under.get(to) ?? under.set(to, []).get(to)).push({ ...it, from, to });
    }
    if (split) {
      // Each pair is one line: a comment goes under the pair holding its last row.
      this.pairs = this.pairUp();
      this.pairs.forEach((p, j) => {
        this.items.push({ key: `p:${j}`, kind: "pair", j, height: this.row });
        for (const i of new Set([p.full, p.l, p.r].filter((x) => x !== undefined && x !== null))) for (const c of under.get(i) ?? []) this.items.push(c);
      });
    } else this.rows.forEach((_r, i) => {
      this.items.push({ key: `r:${i}`, kind: "row", i, height: this.row });
      for (const c of under.get(i) ?? []) this.items.push(c);
    });
    this.sizes = this.items.map((it) => it.height);
    this.sig = JSON.stringify(this.mine());
  }

  // Side by side: context on both sides, a run of removed lines beside the added lines that follow it,
  // hunk headers and notes across the whole width. { l, r } are row indexes (null: blank), { full } one row.
  pairUp() {
    const rows = this.rows, out = [];
    for (let i = 0; i < rows.length;) {
      const k = rows[i].kind;
      if (k === "-" || k === "+") {
        const dels = [], adds = [];
        while (i < rows.length && rows[i].kind === "-") dels.push(i++);
        while (i < rows.length && rows[i].kind === "+") adds.push(i++);
        for (let n = 0; n < Math.max(dels.length, adds.length); n++) out.push({ l: dels[n] ?? null, r: adds[n] ?? null });
      } else if (k === " ") { out.push({ l: i, r: i }); i++; }
      else { out.push({ full: i }); i++; }
    }
    return out;
  }

  // The row a press on a pair means: the side under the pointer (x in the diff's own coordinates).
  rowAt(j, x) {
    const p = this.pairs?.[j];
    if (!p) return -1;
    if (p.full !== undefined) return p.full;
    const left = x < (this.area?.width ?? 0) / 2;
    return (left ? (p.l ?? p.r) : (p.r ?? p.l)) ?? -1;
  }
  unit() { return settings().zoom ?? 1; }

  setLayout(mode, cx) {
    if (mode === layoutMode()) return;
    setShared("diff.layout", mode);
    this.rebuild(); cx.notify();
  }

  commentHeight(text) {
    const cpl = Math.max(24, Math.floor(((this.area?.width ?? 900) - 120) / charOf(this.size)));
    const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
    return 44 + lines * Math.round(this.size * 1.45);
  }

  // The composer's target rows in the diff, or null (also for a whole-file comment).
  target() {
    if (!this.composer || this.composer.whole) return null;
    const from = this.at(this.composer.from), to = this.at(this.composer.to);
    return from < 0 || to < 0 ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  }

  // The rows of a hunk (its header's index), without the header.
  hunkRows(i) { return this.rows.map((_r, j) => j).filter((j) => j !== i && this.rows[j].hunk === i && this.rows[j].kind !== ""); }

  // Click on a row: open the comment box there, or widen it to a range; a hunk header targets the hunk.
  clickRow(i, cx) {
    const row = this.rows[i];
    if (!row || row.kind === "") return;
    let from = i, to = i;
    if (row.kind === "@") {
      const members = this.hunkRows(i);
      if (!members.length) return;
      from = members[0]; to = members[members.length - 1];
    }
    const t = this.target();
    if (t && !this.composer.editing && !this.noteText.trim()) {
      // Inside the highlighted lines clears them; outside widens them.
      if (from >= t.from && to <= t.to) { this.closeComposer(cx); return; }
      from = Math.min(t.from, from); to = Math.max(t.to, to);
    }
    const editing = this.composer?.editing && !this.composer.whole ? this.composer.editing : null;
    this.composer = { from: desc(this.rows[from]), to: desc(this.rows[to]), editing };
    this.openBox(cx);
  }

  commentFile(cx) {
    if (this.composer?.whole && !this.composer.editing && !this.noteText.trim()) { this.closeComposer(cx); return; }
    this.composer = { whole: true, editing: null };
    this.openBox(cx);
  }

  editComment(id, cx) {
    const c = this.mine().find((c) => c.id === id);
    if (!c) return;
    this.composer = c.whole ? { whole: true, editing: id } : { from: c.from, to: c.to, editing: id };
    this.box.set_value(c.text); this.noteText = c.text;
    this.openBox(cx);
  }

  openBox(cx) {
    this.rebuild();
    this.box.focus();
    cx.timer.after(300, () => this.box.focus());
    cx.notify();
  }

  closeComposer(cx) {
    this.composer = null; this.box.set_value(""); this.noteText = ""; this.rebuild(); this.handle.focus(); cx.notify();
  }

  addComment(cx) {
    const text = this.box.value().trim(), c = this.composer, path = props()?.path;
    if (!c || !text) return;
    const all = this.drafts(), list = all.filter((x) => x.id !== c.editing);
    const id = c.editing ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const comment = c.whole ? { id, path, whole: true, text } : { id, path, from: c.from, to: c.to, text };
    const t = this.target();
    // The lines as they are now, sent with the review even if they later leave the diff.
    if (t) { comment.from = desc(this.rows[t.from]); comment.to = desc(this.rows[t.to]); comment.quote = this.quote(this.rows.slice(t.from, Math.min(t.to, t.from + 60) + 1)); }
    else if (c.editing) { const old = all.find((x) => x.id === c.editing); if (old?.quote) comment.quote = old.quote; }
    list.push(comment);
    this.setDrafts(list);
    this.closeComposer(cx);
  }

  deleteComment(cx) {
    const id = this.composer?.editing;
    if (id) this.setDrafts(this.drafts().filter((c) => c.id !== id));
    this.closeComposer(cx);
  }

  toggleFull(cx) {
    this.full = !this.full; localStorage.setItem("full", this.full ? "1" : "0");
    this.closeComposer(cx); this.refresh(cx);
  }

  // ---- asking -------------------------------------------------------------------------------

  // The text the agent gets for some rows.
  quote(rows) {
    return rows.map((r) => r.kind === "@" ? r.text : `${r.number === undefined ? "" : String(r.number).padStart(5)} ${r.kind || " "} ${r.text}`).join("\n");
  }
  span(rows) {
    const nums = rows.filter((r) => r.number !== undefined && r.kind !== "-").map((r) => r.number), olds = rows.filter((r) => r.kind === "-").map((r) => r.number);
    const range = (a) => a.length > 1 ? `lines ${Math.min(...a)}-${Math.max(...a)}` : `line ${a[0]}`;
    return nums.length ? range(nums) : olds.length ? `removed ${range(olds)}` : "";
  }

  // Ask an agent about some rows (indexes), or the whole diff (null).
  askAbout(indexes) {
    if (!this.rows.length) return;
    const { root, path, on } = props(), where = `${root}/${path}${on ? ` (on ${on})` : ""}`, words = this.words ?? "uncommitted changes";
    const rows = (indexes ? [...indexes].sort((a, b) => a - b).map((i) => this.rows[i]) : this.rows).filter(Boolean).slice(0, 400);
    const span = this.span(rows), title = `${path}${span ? `:${span.replace(/^(removed )?lines? /, "")}` : ""}`;
    const head = indexes ? `In ${where}, ${span || "these lines"} of the diff (${words}; new-file line numbers; - lines are removed):` : `The diff of ${where} (${words}):`;
    openOverlay({ mod: "send-dialog", kind: "dialog", width: 680, height: 560, props: { title, context: `${head}\n${this.quote(rows)}` } });
  }

  // ---- drawing ------------------------------------------------------------------------------

  drawItem(it, t, colors, target, commented) {
    if (it.kind === "comment") {
      const span = it.whole ? "whole file" : it.from === it.to ? `line ${this.rows[it.from].number}` : `lines ${this.rows[it.from].number}–${this.rows[it.to].number}`;
      return div().w_full().h(it.height).flex_none().pl(this.gutter + 16).pr(12).py(4).cursor_pointer()
        .child(v_flex().max_w(760).rounded(8).border_1().border_color(it.live ? t.accent : t.accent + "66").bg(t.surface).px(10).py(6).gap(3).font_family(settings().ui_font ?? "Geist")
          .child(div().text_size(10).text_color(it.live ? t.accent : t.dim).child(it.live ? `Comment · ${span} · editing` : `Comment · ${span} · click to edit`))
          .child(div().text_size(this.size).whitespace_normal().text_color(it.text ? t.foreground : t.dim).child(it.text || "(empty)")));
    }
    if (it.kind === "pair") {
      const p = this.pairs[it.j];
      if (p.full !== undefined) return this.drawLine(p.full, t, colors, target, commented, null);
      return h_flex().w_full().h(this.row).flex_none()
        .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(p.l === null ? this.blank(t) : this.drawLine(p.l, t, colors, target, commented, "l")))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(p.r === null ? this.blank(t) : this.drawLine(p.r, t, colors, target, commented, "r")));
    }
    return this.drawLine(it.i, t, colors, target, commented, null);
  }

  // Split scrolls sideways by itself (trackpad or shift+wheel): both halves' code moves together and
  // the line numbers stay. Each half is half the window, so the most it scrolls is what's left over.
  maxScroll() {
    const half = (this.area?.width ?? 0) / 2 - this.gutter - 16 - 3;
    return Math.max(0, this.codeWidth - half);
  }
  scrollSplit(e, cx) {
    if (this.mode !== "split") return;
    const u = this.unit(), dx = e.modifiers?.shift && !e.delta.x ? e.delta.y : e.delta.x;
    if (!dx || Math.abs(dx) < Math.abs(e.modifiers?.shift ? 0 : e.delta.y)) return;
    const next = Math.min(this.maxScroll(), Math.max(0, (this.sx ?? 0) - dx / u));
    if (next !== this.sx) { this.sx = next; cx.notify(); }
    cx.stop_propagation();
  }

  blank(t) { return div().size_full().bg(t.raised + "80"); }

  // One diff line. side: null (unified), "l" (old side: context shows its old number) or "r".
  drawLine(i, t, colors, target, commented, side) {
    const { kind, spans } = this.rows[i], number = side === "l" && kind === " " ? this.rows[i].old : this.rows[i].number;
    const on = target && i >= target.from && i <= target.to, mark = commented.has(i);
    if (kind === "@") return h_flex().w_full().h(this.row).flex_none().items_center().cursor_pointer().bg(t.raised).border_l(2).border_color(on ? t.accent : NONE)
      .child(div().w(this.gutter + 14).flex_none()).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(spans[0].text));
    // Added and removed rows get a tint (stronger when targeted), a tinted gutter and a coloured sign column.
    const tint = kind === "+" ? colors.added : kind === "-" ? colors.removed : null;
    return h_flex().w_full().h(this.row).flex_none().items_center().when(kind !== "", (e) => e.cursor_pointer()).border_l(2).border_color(on ? t.accent : mark ? t.accent + "66" : NONE)
      .when(Boolean(tint), (e) => e.bg(tint + (on ? "5c" : "30")))
      .when(!tint && on, (e) => e.bg(t.selected))
      .child(div().w(this.gutter).h_full().flex().items_center().justify_end().flex_none().pr(4).when(Boolean(tint), (e) => e.bg(tint + "26")).text_color(on ? t.foreground : tint ? t.foreground + "cc" : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().font_bold().text_color(tint ?? NONE).child(kind === "+" ? "+" : kind === "-" ? "−" : " "))
      .child(div().flex_1().min_w(0).h_full().overflow_hidden().flex().items_center()
        .child(h_flex().flex_none().whitespace_nowrap().when(side !== null && this.sx > 0, (e) => e.relative().left(-this.sx))
          .children(spans.map((s) => s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text)))));
  }

  // The comment box: a card over the top-right of the diff while open.
  drawBox(t, target) {
    const c = this.composer, editing = Boolean(c.editing), path = props()?.path ?? "";
    const where = c.whole ? "whole file" : target ? (target.from === target.to ? `line ${this.rows[target.from].number ?? ""}` : `lines ${this.rows[target.from].number}–${this.rows[target.to].number}`) : "those lines are no longer in the diff";
    // Presses inside the box stop here, so they don't reach the row underneath.
    const stop = (action) => (e, cx) => { cx.stop_propagation(); action(e, cx); };
    const button = (id, label, primary, action, tip) => div().id(id).h(26).px(10).flex().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(11).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(stop(action)).tooltip(tip).child(label);
    const link = (id, label, color, action, tip) => div().id(id).h(26).px(7).flex().items_center().rounded(6).text_size(11).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(stop(action)).tooltip(tip).child(label);
    return v_flex().id("comment-box").absolute().top(12).right(14).w(340).gap(8).p(10).text_size(12).rounded(10).border_1().border_color(t.border).bg(t.surface + "eb").shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .child(h_flex().items_center().gap(6)
        .child(div().font_semibold().child(editing ? "Edit comment" : "Comment"))
        .child(div().flex_1())
        .child(div().id("comment-close").size(20).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(stop((_e, cx) => this.closeComposer(cx))).tooltip("Close (Esc)").child("×")))
      .child(div().text_size(11).text_color(t.dim).whitespace_normal().child(`${path.split("/").pop()} · ${where}`))
      .child(div().text_size(10.5).text_color(t.dim).whitespace_normal().child(c.whole || editing ? "Enter saves · shift-enter for a new line · Esc cancels" : "Click another line to widen · Enter saves · shift-enter for a new line"))
      .child(div().w_full().child(Textarea.new(this.box).w_full().px(8).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(h_flex().items_center().gap(6)
        .child(button("comment-add", editing ? "Save" : "Add comment", true, (_e, cx) => this.addComment(cx), "Enter"))
        .child(link("comment-cancel", "Cancel", t.dim, (_e, cx) => this.closeComposer(cx), "Esc"))
        .when(editing, (e) => e.child(div().flex_1()).child(link("comment-delete", "Delete", t.ansi1, (_e, cx) => this.deleteComment(cx), "Remove this comment"))));
  }

  render(cx) {
    if (`${scopeOf().ref}..${scopeOf().to ?? ""}` !== this.shownRef) { this.composer = null; this.refresh(cx); }
    if (codeSize() !== this.size) this.measure();
    if (JSON.stringify(this.mine()) !== this.sig || this.mode !== layoutMode()) this.rebuild();
    // Side by side fits the window (no sideways scrolling): each half clips lines too long for it.
    const split = this.mode === "split";
    this.sx = split ? Math.min(this.sx ?? 0, this.maxScroll()) : 0;
    const t = theme(), colors = palette("one-dark-pro", t), { path } = props() ?? {}, target = this.target();
    const commented = new Set();
    for (const it of this.items) if (it.kind === "comment" && !it.whole) for (let j = it.from; j <= it.to; j++) commented.add(j);
    const n = this.mine().length, canAsk = this.rows.length > 0;
    // Until the first load, show the controls a diff will have, so the header doesn't change when it arrives.
    const controls = canAsk || !this.loaded;
    const button = (id, label, action, tip) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(6).border_1().border_color(t.border).bg(t.raised).text_size(11).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).tooltip(tip).child(label);
    return v_flex().id("diff-tab").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { const w = this.area?.width; this.area = size; if (w !== size.width) { this.rebuild(); cx.notify(); } })
      .on_key_down((e, cx) => { if (e.key === "escape" && this.composer) { this.closeComposer(cx); cx.stop_propagation(); } })
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(path ?? ""))
        .when(n > 0, (e) => e.child(h_flex().h(18).px(6).gap(3).items_center().rounded(4).bg(t.accent + "33").text_size(10).child(svg("mods/diff-tab/comment.svg").size(10)).child(String(n))))
        .when(Boolean(this.label), (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.label)))
        .child(div().text_size(11).text_color(colors.added).child(this.loaded ? `+${this.add}` : ""))
        .child(div().text_size(11).text_color(colors.removed).child(this.loaded ? `−${this.del}` : ""))
        .when(controls, (e) => e.child(h_flex().h(22).p(2).gap(2).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
          .children([["unified", "Unified", "One column: removed lines above the added ones"], ["split", "Split", "Side by side: the old file left, the new one right"]].map(([m, label, tip]) => {
            const chosen = layoutMode() === m;
            return h_flex().id(`layout-${m}`).h(16).px(7).items_center().rounded(4).text_size(11).cursor_pointer()
              .bg(chosen ? t.raised : t.background).text_color(chosen ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.setLayout(m, cx)).tooltip(`${tip} (every diff tab)`).child(label);
          }))))
        .when(controls, (e) => e.child(button("full-file", this.full ? "Changes only" : "Full file", (_e, cx) => this.toggleFull(cx), this.full ? "Show only the changed hunks" : "Show the whole file with its changes in place")))
        .child(button("comment-file", "Comment on file", (_e, cx) => this.commentFile(cx), "A comment about the whole file"))
        .when(controls, (e) => e.child(button("ask-diff", "Ask about diff", () => this.askAbout(null), "Send this file's diff to an agent with a question"))))
      .when(Boolean(this.note), (el) => el.child(div().px(12).py(8).text_color(t.dim).child(this.note)))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(this.size)
        .child(div().id("diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(split ? 0 : this.width).h_full()
            .on_scroll_wheel((e, cx) => this.scrollSplit(e, cx))
            .on_mouse_down("left", (e) => { this.pressX = (e.local_position?.x ?? 0) / this.unit(); })
            .child(v_virtual_list("diff", this.items.length, this.sizes.length ? this.sizes : this.row, (i) => this.items[i].key,
            (range) => this.items.slice(range.start, range.end).map((it) => this.drawItem(it, t, colors, target, commented))).size_full()
            .on_item_click((k, cx) => {
              if (k.startsWith("c:")) { if (k.slice(2) !== this.composer?.editing) this.editComment(k.slice(2), cx); }
              else if (k.startsWith("p:")) { const i = this.rowAt(Number(k.slice(2)), this.pressX ?? 0); if (i >= 0) this.clickRow(i, cx); }
              else this.clickRow(Number(k.slice(2)), cx);
            })
            .on_item_secondary_click((k, _e, cx) => {
              if (!k.startsWith("r:") && !k.startsWith("p:")) return;
              const i = k.startsWith("p:") ? this.rowAt(Number(k.slice(2)), (_e?.local_position?.x ?? 0) / this.unit()) : Number(k.slice(2)), r = this.rows[i];
              if (!r || r.kind === "") return;
              this.askAbout(r.kind === "@" ? this.hunkRows(i) : [i]);
            }))))
        .child(Scrollbar.vertical("diff").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.composer), (e) => e.child(this.drawBox(t, target)));
  }
}
