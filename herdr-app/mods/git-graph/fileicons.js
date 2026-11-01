// Ours: file and folder icons from Material Icon Theme (github.com/material-extensions/vscode-material-icon-theme,
// MIT), the VS Code icon theme, when it's installed in ~/.config/herdr-app/data/material-icons (herdr-app-sync
// --install downloads it at a pinned version). Its own manifest (material-icons.json) is read at run time and
// its SVGs are drawn from there, so nothing is copied here. Without it, the plain icons.
// Matched like VS Code: a path rule (".github/workflows") beats a name, a name beats an extension, and the
// longest extension wins ("spec.ts" over "ts"); names case-insensitively. Light themes use the light tables.
import { image, svg } from "gpui-kit";
import { appHome, settings } from "herdr";
import * as fs from "fs/promises";

const DIR = "data/material-icons";
let M = null, asked = false;

const lower = (map = {}) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
const tables = (m = {}) => ({ fileNames: lower(m.fileNames), fileExtensions: lower(m.fileExtensions), folderNames: lower(m.folderNames), folderNamesExpanded: lower(m.folderNamesExpanded) });

// Call from init: reads the manifest once per mod, then redraws.
export function loadIcons(cx) {
  if (asked) return;
  asked = true;
  cx.spawn(async (cx) => {
    try {
      const m = JSON.parse(await fs.readFile(`${appHome()}/${DIR}/material-icons.json`, "utf8"));
      M = { defs: m.iconDefinitions, file: m.file, folder: m.folder, folderExpanded: m.folderExpanded, dark: tables(m), light: tables(m.light) };
      cx.notify();
    } catch { /* not installed: plain icons */ }
  });
}

// An icon id's SVG ("./../icons/x.svg" in the manifest), or null.
const fileOf = (id) => { const p = id && M.defs[id]?.iconPath; return p ? `${DIR}/icons/${p.split("/").pop()}` : null; };

// The icon's path for a file or folder ("/"-separated path, relative to anything), or null.
export function iconPath(path, dir, open = false) {
  if (!M) return null;
  const light = !settings().dark;
  const get = (table, key) => (light ? M.light[table][key] : undefined) ?? M.dark[table][key];
  const parts = path.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? (open ? "folderNamesExpanded" : "folderNames") : "fileNames";
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = get(table, parts.slice(i).join("/"));
  id ??= get(table, name);
  if (dir) return fileOf(id) ?? fileOf(open ? M.folderExpanded : M.folder);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = get("fileExtensions", name.slice(dot + 1));
  return fileOf(id) ?? fileOf(M.file);
}

// The element: the coloured icon, else `plain` (an svg path) tinted `color`.
export function fileIcon(path, dir, open, size, plain, color) {
  const p = iconPath(path, dir, open);
  return p ? image(p).size(size + 2).flex_none() : svg(plain).size(size).flex_none().text_color(color);
}
