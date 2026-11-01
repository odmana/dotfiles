// A scratchpad for each space: free-form notes in a markdown editor, saved as you type.
// Each space's note is ~/.config/herdr-app/data/scratchpad/<space id>.md, so it outlives restarts
// (and can be read or backed up as a plain file). The panel shows the focused space's note.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { focused, spaces, theme, settings, appHome } from "herdr";
import * as fs from "fs/promises";

const dir = () => `${appHome()}/data/scratchpad`;
const fileOf = (space) => `${dir()}/${space}.md`;
// Same text size and spacing as the file and diff tabs.
const codeSize = () => Math.max(9, (Number(settings().font_size) || 14) - 1);

export default class Scratchpad extends View {
  init(_props, cx) {
    this.space = null; this.dirty = false; this.status = "";
    this.code = EditorState.new({ language: "markdown", value: "", soft_wrap: true, line_numbers: false, folding: false,
      font_family: settings().font_family ?? "JetBrains Mono", font_size: codeSize() });
    this.code.on("change", (_e, cx) => {
      if (this.switching) return;
      this.dirty = true; this.status = "Saving…";
      // Save half a second after the last keystroke.
      this.timer?.cancel?.();
      this.timer = cx.timer.after(500, (cx) => this.save(cx));
      cx.notify();
    });
  }

  async read(space) {
    try { return await fs.readFile(fileOf(space), "utf8"); } catch { return ""; }
  }

  save(cx) {
    if (!this.dirty || !this.space) return;
    const space = this.space, text = this.code.value();
    this.dirty = false;
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(dir(), { recursive: true });
        await fs.writeFile(fileOf(space), text, "utf8");
        if (space === this.space && !this.dirty) this.status = "Saved";
      } catch (e) { this.status = `Not saved: ${e}`; this.dirty = true; }
      cx.notify();
    });
  }

  // Another space: save this one's note now, then show that one's.
  show(space, cx) {
    if (this.dirty) { this.timer?.cancel?.(); this.save(cx); }
    this.space = space; this.status = ""; this.loaded = false;
    cx.spawn(async (cx) => {
      const text = await this.read(space);
      if (this.space !== space) return;
      this.switching = true; this.code.set_value(text); this.switching = false;
      this.loaded = true; this.dirty = false;
      cx.notify();
    });
  }

  async close(cx) {
    // Last chance to keep what was typed in the final half second.
    if (this.dirty && this.space) { try { await fs.mkdir(dir(), { recursive: true }); await fs.writeFile(fileOf(this.space), this.code.value(), "utf8"); } catch {} }
    this.code.release();
  }

  render(cx) {
    const space = focused()?.space ?? null;
    if (space && space !== this.space) this.show(space, cx);
    const t = theme(), name = spaces().find((s) => s.id === space)?.name ?? "";
    return v_flex().id("scratchpad").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Scratchpad"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(name))
        .when(Boolean(this.status), (e) => e.child(div().flex_none().text_size(11).text_color(this.status.startsWith("Not") ? t.ansi1 : t.dim).child(this.status))))
      .child(!space
        ? div().p(12).text_color(t.dim).child("No space")
        : div().flex_1().min_h(0).p(4).child(Editor.new(this.code).size_full().font_family(settings().font_family ?? "JetBrains Mono").text_size(codeSize()).line_height(`${Math.round(codeSize() * 1.6)}px`)));
  }
}
