# Shell integration for Bash and Git Bash, passed as --rcfile.
# OSC 7 = current directory, OSC 133 = busy/idle state
# (133;C = command started, 133;A/D = prompt visible, waiting for input)

[ -f ~/.bashrc ] && source ~/.bashrc

# flightdeck:include claude-wrapper.sh

__flightdeck_at_prompt=1
__flightdeck_prompt() {
  __flightdeck_at_prompt=1
  printf '\033]133;D\007\033]133;A\007\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"
}
__flightdeck_preexec() {
  [ -n "$__flightdeck_at_prompt" ] || return 0
  case "$BASH_COMMAND" in __flightdeck_prompt*) return 0 ;; esac
  __flightdeck_at_prompt=
  printf '\033]7770;cmd;%s\007' "$(printf %s "$BASH_COMMAND" | base64 2>/dev/null | tr -d '\n')"
  printf '\033]133;C\007'
}
PROMPT_COMMAND=__flightdeck_prompt
trap __flightdeck_preexec DEBUG
