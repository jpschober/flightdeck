# Shell integration for Bash and Git Bash, passed as --rcfile.
# OSC 7 = current directory, OSC 133 = busy/idle state
# (133;C = command started, 133;A/D = prompt visible, waiting for input)
#
# /etc/bash.bashrc is not sourced here: bash reads its compiled-in system rc
# before the file given with --rcfile (run_startup_files), so it is already
# loaded when this runs, and sourcing it again would re-run bash-completion.
#
# The hooks are added, not assigned. PROMPT_COMMAND usually already holds
# starship, direnv or the distribution's window-title hook - and since bash 5.1
# it may be an array, which a string assignment would flatten to its first
# element. The DEBUG trap is where bash-preexec and starship sit; the handler
# found there stays in front of ours and keeps its own $? and $_, which is what
# bash-preexec and starship read out of "$_".
#
# One handler form is not carried: a bare `return` in the trap string itself
# (not inside a function it calls). Such a handler ends the sourcing of this
# file at the first command after ~/.bashrc, and none of the hooks below are
# installed - the same happens to any other rc-file integration, and it is
# decided before the handlers are chained, so no order helps. At the
# interactive prompt the same `return` is only an error message and the rest of
# the trap string still runs, so the reporting is not affected there.
#
# __flightdeck_at_prompt is cleared by our PROMPT_COMMAND entry and set again by
# the last one, so the DEBUG trap ignores whatever the other entries run and
# reports only the command line you typed.

[ -f ~/.bashrc ] && source ~/.bashrc

# flightdeck:include claude-wrapper.sh

# Disarmed until the first prompt: the rest of this file runs after the trap is
# installed, and those lines are not commands you typed.
__flightdeck_at_prompt=
__flightdeck_prompt() {
  local __fd_status=$?
  __flightdeck_at_prompt=
  printf '\033]133;D\007\033]133;A\007\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"
  return $__fd_status
}
__flightdeck_arm() {
  local __fd_status=$?
  __flightdeck_at_prompt=1
  return $__fd_status
}
__flightdeck_preexec() {
  [ -n "$__flightdeck_at_prompt" ] || return 0
  case "$BASH_COMMAND" in __flightdeck_prompt*) return 0 ;; esac
  __flightdeck_at_prompt=
  printf '\033]7770;cmd;%s\007' "$(printf %s "$BASH_COMMAND" | base64 2>/dev/null | tr -d '\n')"
  printf '\033]133;C\007'
}
__flightdeck_decl=$(declare -p PROMPT_COMMAND 2>/dev/null)
__flightdeck_decl=${__flightdeck_decl#declare -}
__flightdeck_decl=${__flightdeck_decl%% *}
case "$__flightdeck_decl" in
  *a*) PROMPT_COMMAND=(__flightdeck_prompt "${PROMPT_COMMAND[@]}" __flightdeck_arm) ;;
  # Separated by newlines, not by ';': a trailing comment in the existing value
  # would otherwise swallow what follows it.
  *) PROMPT_COMMAND="__flightdeck_prompt
$PROMPT_COMMAND
__flightdeck_arm" ;;
esac
# An exported PROMPT_COMMAND carries our function names into every child bash,
# where they do not exist and each prompt answers with "command not found". The
# value stays, the export attribute goes.
case "$__flightdeck_decl" in *x*) export -n PROMPT_COMMAND ;; esac
unset __flightdeck_decl
# `trap -p` prints a line that reinstalls the trap. Running it with the command
# name replaced hands the handler over as one word, so quotes inside it survive.
__flightdeck_take_trap() { __flightdeck_prev_debug=$2; }
__flightdeck_prev_debug=
__flightdeck_trap=$(trap -p DEBUG)
[ -n "$__flightdeck_trap" ] && eval "${__flightdeck_trap/#trap/__flightdeck_take_trap}"
if [ -n "$__flightdeck_prev_debug" ]; then
  trap "$__flightdeck_prev_debug
__flightdeck_preexec" DEBUG
else
  trap __flightdeck_preexec DEBUG
fi
unset __flightdeck_trap __flightdeck_prev_debug
unset -f __flightdeck_take_trap
