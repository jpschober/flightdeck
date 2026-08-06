# Written to the integration directory as .zshrc; runs after zshenv.zsh.

ZDOTDIR="${FLIGHTDECK_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"

# flightdeck:include claude-wrapper.sh

__flightdeck_prompt() {
  printf '\033]133;D\007\033]133;A\007\033]7;file://%s%s\007' "${HOST:-localhost}" "$PWD"
}
__flightdeck_preexec() {
  printf '\033]7770;cmd;%s\007' "$(printf %s "$1" | base64 2>/dev/null | tr -d '\n')"
  printf '\033]133;C\007'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __flightdeck_prompt
add-zsh-hook preexec __flightdeck_preexec
