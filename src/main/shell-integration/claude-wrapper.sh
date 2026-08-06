# Claude wrapper: assigns the session ID itself and reports it before Claude
# starts. Only that makes the mapping terminal -> transcript unambiguous;
# without it, the only option left would be guessing via timestamps - and
# anyone who happens to be working in another window at the same moment would
# get the wrong transcript.
# OSC 7771: session;<uuid> = exact, continue; = the folder's latest session.
#
# Included into bashrc.sh and zshrc.zsh, so it stays POSIX sh.

__flightdeck_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen 2>/dev/null | tr 'A-Z' 'a-z'
  fi
}
claude() {
  __fd_mode=new
  for __fd_a in "$@"; do
    case "$__fd_a" in
      -c|--continue) __fd_mode=continue ;;
      -r|--resume|--resume=*|--session-id|--session-id=*) __fd_mode=other ;;
    esac
  done
  if [ "$__fd_mode" = new ]; then
    __fd_id=$(__flightdeck_uuid)
    if [ -n "$__fd_id" ]; then
      printf '\033]7771;session;%s\007' "$__fd_id"
      command claude --session-id "$__fd_id" "$@"
      return $?
    fi
  elif [ "$__fd_mode" = continue ]; then
    printf '\033]7771;continue;\007'
  fi
  command claude "$@"
}
