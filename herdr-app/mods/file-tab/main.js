// A file opened from the Files panel as its own tab.
// props: { file (absolute path), on (machine or null) }.
// It opens as a read-only view drawn like the diff tab (same highlighter, colours, font and row
// spacing). Edit (or cmd-e) switches to an editor; cmd-s saves and returns to the view, Done returns
// without saving (unsaved edits stay in the editor and show in the view). Files on another machine,
// and files over 400 KB, are view-only.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, writeTextFile, theme, settings, shared, setShared } from "herdr";
import { tokenize, languageOf } from "./highlight.js";
import { palette } from "./palette.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const LIMIT = 400000, MAX_ROWS = 50000;
// Same look as the diff tab: the terminal's font one size down, rows 1.8x the size, One Dark Pro.
const codeSize = () => Math.max(9, (Number(settings().font_size) || 14) - 1);
const rowOf = (size) => Math.round(size * 1.8);
const charOf = (size) => size * 0.62;
const codeFont = () => settings().font_family ?? "JetBrains Mono";
// The editor's own highlighter, given the diff's colours (it can't match exactly; the view does).
function syntax(t) {
  const c = palette("one-dark-pro", t);
  return { keyword: c.keyword, string: c.string, "string.escape": c["string.escape"], comment: c.comment, function: c.function, type: c.type,
    number: c.number, constant: c.constant, boolean: c.boolean, variable: t.foreground, operator: t.foreground, punctuation: t.foreground };
}

// Markdown opens rendered; Source shows it like any other file. One choice for every file tab,
// kept across restarts (shared "file.markdown": "preview" or "source").
const isMarkdown = (file) => /\.(md|markdown|mdx|mdown|mkd)$/i.test(file ?? "");
const mdMode = () => shared("file.markdown") === "source" ? "source" : "preview";

// Unsaved files, so the tab bar can ask before closing: shared "unsaved" = { "file:<machine>:<path>": true }.
const viewKey = () => `file:${props()?.on ?? ""}:${props()?.file}`;
function markUnsaved(dirty) {
  const all = shared("unsaved") ?? {}, k = viewKey();
  if (Boolean(all[k]) === dirty) return;
  const next = { ...all };
  if (dirty) next[k] = true; else delete next[k];
  setShared("unsaved", next);
}

export default class FileTab extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.rows = []; this.size = codeSize(); this.row = rowOf(this.size);
    this.load(cx);
  }

  load(cx) {
    const { file, on } = props() ?? {};
    if (!file) { this.error = "No file"; return; }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(file, { on: on ?? null });
        if (text === null) this.error = "This file is no longer available";
        else if (text.includes("\0")) this.error = "Binary file · no preview";
        else {
          this.readonly = Boolean(on) || text.length > LIMIT;
          this.saved = text;
          this.show(text.length > LIMIT ? text.slice(0, LIMIT) + "\n… (file truncated, view-only)" : text);
        }
      } catch { this.error = "Cannot open this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // The view's rows: every line numbered and tokenized once, like the diff tab.
  show(text) {
    this.text = text;
    const lang = languageOf(props()?.file), lines = text.replace(/\n$/, "").split("\n").slice(0, MAX_ROWS);
    let state = null;
    this.rows = lines.map((line, i) => {
      const t = tokenize(line.replace(/\t/g, "    "), lang, state);
      state = t.state;
      return { number: i + 1, spans: t.spans, length: line.length };
    });
    this.measure();
  }

  measure() {
    this.size = codeSize(); this.row = rowOf(this.size);
    const ch = charOf(this.size), digits = String(this.rows.length).length;
    this.gutter = Math.max(30, Math.ceil(digits * ch + 10));
    this.width = Math.max(300, ...this.rows.map((r) => Math.ceil(r.length * ch) + this.gutter + 36));
  }

  // ---- editing ----

  edit(cx) {
    if (this.readonly || this.text === undefined || this.editing) return;
    if (!this.code) {
      const ext = (props().file.includes(".") ? props().file.split(".").pop() : "txt");
      this.code = EditorState.new({ language: LANG[ext] ?? ext, value: this.text, font_family: codeFont(), font_size: this.size, syntax: syntax(theme()) });
      this.code.on("change", (_e, cx) => {
        const dirty = this.code.value() !== this.saved;
        if (dirty !== this.dirty) { this.dirty = dirty; markUnsaved(dirty); cx.notify(); }
      });
    }
    this.editing = true; this.note = null;
    cx.notify();
  }

  // Back to the view, showing the editor's text (saved or not).
  done(cx) {
    if (!this.editing) return;
    this.editing = false;
    this.show(this.code.value());
    this.handle.focus();
    cx.notify();
  }

  save(cx) {
    if (!this.code || this.readonly || this.saving) return;
    if (!this.dirty) { this.done(cx); return; }
    const { file } = props(), text = this.code.value();
    this.saving = true; this.note = null;
    cx.spawn(async cx => {
      try {
        await writeTextFile(file, text, this.saved);
        this.saved = text; this.dirty = this.code.value() !== text; markUnsaved(this.dirty);
        this.done(cx);
      } catch (e) { this.note = `Not saved: the file changed on disk since it was opened (${e})`; }
      finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  async close() { markUnsaved(false); this.code?.release(); }

  // ---- drawing ----

  drawRow({ number, spans }, t, colors) {
    return h_flex().w_full().h(this.row).flex_none().items_center()
      .child(div().w(this.gutter).h_full().flex().items_center().justify_end().flex_none().pr(4).text_color(t.dim).child(String(number)))
      .child(div().w(16).flex_none())
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap().children(spans.map((s) => s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text))));
  }

  render(cx) {
    if (codeSize() !== this.size && !this.editing) this.measure();
    const t = theme(), colors = palette("one-dark-pro", t), { file } = props() ?? {};
    const state = this.saving ? "Saving…" : this.readonly ? "View only" : this.dirty ? "Unsaved · ⌘S to save" : this.editing ? "Editing" : "Saved";
    const button = (id, label, primary, action, tip) => h_flex().id(id).h(22).px(8).items_center().rounded(6).border_1().border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(11).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).tooltip(tip).child(label);
    const ready = this.text !== undefined, md = isMarkdown(file), preview = md && mdMode() === "preview";
    // Until the file is read, show the controls it will most likely have, so the header doesn't jump.
    const editable = ready ? !this.readonly : !this.error && !props()?.on;
    const toggle = h_flex().h(22).p(2).gap(2).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
      .children([["preview", "Preview", "Rendered Markdown"], ["source", "Source", "The Markdown text"]].map(([m, label, tip]) => {
        const chosen = mdMode() === m;
        return h_flex().id(`md-${m}`).h(16).px(7).items_center().rounded(4).text_size(11).cursor_pointer()
          .bg(chosen ? t.raised : t.background).text_color(chosen ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { setShared("file.markdown", m); cx.notify(); }).tooltip(`${tip} (every Markdown tab)`).child(label);
      }));
    return v_flex().id("file-tab").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-s") { cx.stop_propagation(); this.save(cx); }
        else if (e.keystroke === "cmd-e") { cx.stop_propagation(); this.editing ? this.done(cx) : this.edit(cx); }
      })
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(file ?? ""))
        .child(div().flex_none().text_size(11).text_color(this.dirty ? t.blocked : t.dim).child(ready ? state : ""))
        .when(md && !this.error && !this.editing, (e) => e.child(toggle))
        .when(editable && !this.editing, (e) => e.child(button("edit", "Edit", false, (_e, cx) => this.edit(cx), "Edit this file (cmd-e)")))
        .when(Boolean(this.editing), (e) => e
          .child(button("done", "Done", false, (_e, cx) => this.done(cx), "Back to the view (cmd-e); unsaved edits are kept"))
          .child(button("save", "Save", true, (_e, cx) => this.save(cx), "Save and go back to the view (cmd-s)"))))
      .when(Boolean(this.note), el => el.child(div().px(12).py(4).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(this.editing
        ? Editor.new(this.code).flex_1().min_h(0).font_family(codeFont()).text_size(this.size).line_height(`${this.row}px`)
        : !ready
          ? div().p(12).text_color(t.dim).child(this.error ?? "")
          : preview
            ? div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar()
                .child(div().w_full().max_w(900).mx_auto().px(28).py(20).text_size(14).font_family(settings().ui_font ?? "Geist")
                  .child(TextView.markdown("md", this.text).selectable(true)))
          : div().flex_1().min_h(0).relative().font_family(codeFont()).text_size(this.size)
              .child(div().id("file-x").size_full().overflow_x_scrollbar()
                .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("file", this.rows.length, this.row, (i) => String(i),
                  (range) => this.rows.slice(range.start, range.end).map((r) => this.drawRow(r, t, colors))).size_full())))
              .child(Scrollbar.vertical("file").viewport_from_layout().absolute().inset_0()));
  }
}
