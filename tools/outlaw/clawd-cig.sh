#!/bin/zsh
# Toggle Clawd's cigarette in the clawd-outlaw theme. Usage: clawd-cig on|off
# Rewrites the cig layer's display flag in the theme SVGs, clears the app's
# sanitized-SVG cache, and restarts the pet so it takes effect.

THEME="${HOME}/Library/Application Support/clawd-on-desk/themes/clawd-outlaw/assets"
CACHE="${HOME}/Library/Application Support/clawd-on-desk/theme-cache/clawd-outlaw"

case "$1" in
  on)  FROM='class="od-cig" style="display:none"'; TO='class="od-cig" style="display:inline"' ;;
  off) FROM='class="od-cig" style="display:inline"'; TO='class="od-cig" style="display:none"' ;;
  *) echo "usage: clawd-cig on|off"; exit 1 ;;
esac

changed=0
for f in "$THEME"/*.svg; do
  if grep -q "$FROM" "$f" 2>/dev/null; then
    perl -pi -e "s/\Q$FROM\E/$TO/g" "$f"
    changed=$((changed+1))
  fi
done
rm -rf "$CACHE"
echo "cigarette $1 ($changed sprites updated). Restarting Clawd..."
osascript -e 'quit app "Clawd on Desk"' 2>/dev/null
sleep 1
# env -i: ELECTRON_RUN_AS_NODE (set inside VSCode/Claude shells) makes the app
# silently exit as a bare Node process. A clean env launches it as a real app.
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin /usr/bin/open -a "Clawd on Desk"
