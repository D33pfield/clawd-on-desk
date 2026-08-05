#!/bin/zsh
# Set Clawd's roam fence. Applies live (no restart) — the patched app re-reads
# ~/.clawd/roam-area.json before every wander.
#
# Usage:
#   clawd-roam bottom-right | bottom-left | top-right | top-left
#   clawd-roam bottom | top | left | right      (half of the screen)
#   clawd-roam full                             (no fence)
#   clawd-roam <left> <top> <right> <bottom>    (fractions 0..1 of the screen)

F="${HOME}/.clawd/roam-area.json"

write() {
  print -r -- "{\"enabled\": $5, \"left\": $1, \"top\": $2, \"right\": $3, \"bottom\": $4}" | tee "$F" >/dev/null
  echo "roam fence: left=$1 top=$2 right=$3 bottom=$4 enabled=$5"
}

case "$1" in
  bottom-right) write 0.55 0.55 1.0 1.0 true ;;
  bottom-left)  write 0.0 0.55 0.45 1.0 true ;;
  top-right)    write 0.55 0.0 1.0 0.45 true ;;
  top-left)     write 0.0 0.0 0.45 0.45 true ;;
  bottom)       write 0.0 0.55 1.0 1.0 true ;;
  top)          write 0.0 0.0 1.0 0.45 true ;;
  left)         write 0.0 0.0 0.45 1.0 true ;;
  right)        write 0.55 0.0 1.0 1.0 true ;;
  full)         write 0.0 0.0 1.0 1.0 false ;;
  *)
    if [[ $# -eq 4 ]]; then
      write "$1" "$2" "$3" "$4" true
    else
      echo "usage: clawd-roam bottom-right|bottom-left|top-right|top-left|bottom|top|left|right|full"
      echo "       clawd-roam <left> <top> <right> <bottom>   (0..1 fractions)"
      exit 1
    fi
    ;;
esac
