#!/bin/sh
# Open the TTT editor plugin in a new tab at the focused pane's directory,
# then switch to that tab.

field() {
  grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}

dir=$(herdr pane current | field foreground_cwd)

tab=$(herdr plugin pane open \
  --plugin ttt.editor \
  --entrypoint editor \
  --env "TTT_TARGET_DIR=${dir:-$HOME}" \
  --focus | field tab_id)

[ -n "$tab" ] && herdr tab focus "$tab" >/dev/null
