import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, exec, notify } from "herdr";

// Closes a tab, asking first when it's an editor tab with unsaved changes (shared "unsaved", set by
// file-tab; which file a tab shows is in shared "tab-views", set when the Files panel opened it).
function closeTab(id) {
  if (!id) return;
  const rec = (shared("tab-views") ?? {})[id], view = rec?.view ?? rec;
  if (view && (shared("unsaved") ?? {})[view]) {
    const name = String(view).split("/").pop();
    openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 180, props: {
      title: `Close ${name}?`, detail: "It has unsaved changes. Closing the tab discards them.",
      command: { name: "tab.close", args: { id } } } });
  } else run("tab.close", { id });
}

// Graph: the Git Graph (mod git-graph) of the repository you're in, as a tab; one per repository.
// In a file, diff or graph tab, that tab's folder; else the focused terminal's, else the space's.
function graphFolder() {
  const f = focused(), space = spaces().find(s => s.id === f?.space) ?? spaces().find(s => s.active);
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane && !pane.terminal && ["file-tab", "diff-tab", "git-graph"].includes(pane.mod)) {
    const rec = (shared("tab-views") ?? {})[f.tab];
    if (rec?.cwd) return { cwd: rec.cwd, on: rec.on ?? null };
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const opening = new Set();
async function openGraph(cx) {
  const { cwd, on } = graphFolder();
  if (!cwd) return notify({ title: "No folder for the graph", level: "error" });
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (!r || r.code !== 0) return notify({ title: "Not a git repository", body: cwd, level: "error" });
  const root = r.stdout.trim(), view = `graph:${on ?? ""}:${root}`, name = `${root.split("/").pop()} (graph)`;
  const all = () => spaces().flatMap(s => s.tabs), views = shared("tab-views") ?? {};
  const open = all().find(t => (views[t.id]?.view ?? views[t.id]) === view);
  if (open) return run("tab.select", { id: open.id });
  if (opening.has(view)) return;
  const before = new Set(all().map(t => t.id));
  opening.add(view);
  run("tab.new", { space: focused()?.space, name, mod: "git-graph", props: { folder: root, on } });
  try {
    for (let i = 0; i < 40; i++) {
      const made = all().find(t => !before.has(t.id) && t.name === name);
      if (made) {
        const ids = new Set(all().map(t => t.id)), now = shared("tab-views") ?? {};
        setShared("tab-views", { ...Object.fromEntries(Object.entries(now).filter(([id]) => ids.has(id))), [made.id]: { view, cwd: root, on } });
        return;
      }
      await cx.sleep(50);
    }
  } finally { opening.delete(view); }
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    // cmd-w in the main-custom layout (keys.json) arrives here.
    cx.spawn(async () => { for (;;) { if (await nextCommand() === "close-tab") closeTab(focused()?.tab); } });
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      // A Git Graph tab shows the graph icon and just the repo ("dotfiles (graph)" stays its real name).
      const graph = panes().some(p => p.tab === c.id && p.mod === "git-graph");
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : graph ? c.name.replace(/ \(graph\)$/, "") : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu-custom", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        // Middle click closes the tab (the last tab of a space still asks first).
        .on_mouse_down("middle", (_e, cx) => cx.stop_propagation())
        .on_mouse_up("middle", (_e, cx) => { cx.stop_propagation(); closeTab(c.id); })
        .when(graph, el => el.child(svg("mods/git-graph/icons/graph.svg").size(14).flex_none().text_color(c.active ? t.accent : t.muted)))
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); closeTab(c.id); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Files and Changes as the welcome set them up, plus the Scratchpad (mod scratchpad), always.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "scratchpad"];
    this.syncPanel(space, panel, body, enabled);
    const fp = focused()?.pane ? panes().find(p => p.pane === focused().pane) : null, graphShown = fp?.mod === "git-graph";
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu-custom", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(h_flex().id("open-graph").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(graphShown ? t.selected : t.chrome).text_color(graphShown ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => cx.spawn(async cx => openGraph(cx)))
        .child(svg("mods/git-graph/icons/graph.svg").size(14)).child("Graph"))
      .child(panelButton("scratchpad", "Scratchpad", "mods/scratchpad/square-pen.svg"))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-custom/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-custom/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-custom/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
