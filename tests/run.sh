#!/bin/bash
# Runs a test scenario against the extension in a headless shell with a home directory of its own:
#
#   tests/run.sh tests/overlay.test.js [timeout in seconds]
#
# The scenario is JavaScript that runs at the end of enable(), with the helpers of tests/prelude.js.
# Screenshots go to tests/output. The exit status is 1 if a check failed or the scenario did not finish.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
scenario=$(realpath "$1")
uuid=$(sed -n 's/.*"uuid": "\(.*\)".*/\1/p' "$repo/metadata.json")
work=$(mktemp -d "${TMPDIR:-/tmp}/gamebar-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

extension="$work/home/.local/share/gnome-shell/extensions/$uuid"
mkdir -p "$extension" "$repo/tests/output"
(cd "$repo" && cp -r *.js *.css metadata.json addons helpers icons schemas locale "$extension/")

python3 - "$extension/extension.js" "$repo/tests/prelude.js" "$scenario" "$repo/tests/output" <<'PY'
import sys
path, prelude, scenario, output = sys.argv[1:]
source = open(path).read()
anchor = "        this._gamebar._loadSettings(this._settings);\n"
assert anchor in source, "enable() changed, update the anchor in tests/run.sh"
test = open(prelude).read().replace('@OUTPUT@', output) + "\nrunScenario(async () => {\n" + open(scenario).read() + "\n});\n"
open(path, 'w').write(source.replace(anchor, anchor + test))
PY

# Exported before dbus-run-session: services started by D-Bus take their home from the D-Bus daemon.
export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" XDG_DATA_HOME="$work/home/.local/share" \
    XDG_CACHE_HOME="$work/home/.cache" GSETTINGS_BACKEND=keyfile
gsettings set org.gnome.shell enabled-extensions "['$uuid']"
gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
# The pointer starts in the hot corner.
gsettings set org.gnome.desktop.interface enable-hot-corners false

timeout "${2:-60}" dbus-run-session -- gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11 > "$work/log" 2>&1
cp "$work/log" "$repo/tests/output/shell.log"

# The lines of the scenario, and the errors of the extension.
grep -E "TEST: |JS ERROR|Gjs-CRITICAL" "$work/log" | sed 's/^.*TEST: //'
grep -q "TEST: DONE" "$work/log" || { echo "The scenario did not finish, see tests/output/shell.log"; exit 1; }
! grep -q "TEST: FAIL" "$work/log"
