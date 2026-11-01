// Our addition (not in herdr-git-graph): opening things as tabs, as the Files and Changes panels do.
// If the view is open in any tab already, go there; else make one. shared("tab-views") maps tab id
// -> { view, cwd, on }; a new tab shows up in spaces() a moment after tab.new returns.
import { spaces, focused, run, shared, setShared } from "herdr";

const pending = new Set();
export function openTab(cx, mod, name, view, tabProps, where) {
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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's empty tree: "before" a root commit

// A file of a commit (or of the uncommitted row) in our diff tab, fixed to that commit.
export function openFileDiff(cx, commit, path, root, on) {
  const file = path.split("/").pop();
  const scope = commit.uncommitted
    ? { scope: "work", ref: "HEAD", label: "Uncommitted", words: "uncommitted changes" }
    : { scope: `commit:${commit.hash}`, ref: commit.parents[0] ?? EMPTY_TREE, to: commit.hash, label: `Commit ${commit.hash.slice(0, 7)}`,
        words: `only the changes of commit ${commit.hash.slice(0, 7)}${commit.subject ? ` ("${commit.subject}")` : ""}` };
  const name = commit.uncommitted ? `${file} (diff)` : `${file} (${commit.hash.slice(0, 7)})`;
  const view = commit.uncommitted ? `diff:${on ?? ""}:${root}/${path}` : `diff:${on ?? ""}:${root}/${path}@${commit.hash}`;
  openTab(cx, "diff-tab", name, view, { root, path, on: on ?? null, ...(commit.uncommitted ? {} : { scope }) }, { cwd: root, on: on ?? null });
}
