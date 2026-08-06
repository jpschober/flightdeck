# Written to the integration directory as .zshenv.
#
# Zsh loads its configuration from $ZDOTDIR. We point that at our own directory
# (see getRcDir), which first loads the user's real configuration and then
# installs the hooks.
# Important: after loading the user's .zshenv, ZDOTDIR must point back at our
# directory, otherwise zsh will not find our .zshrc in the next step.

__flightdeck_rcdir="$ZDOTDIR"
ZDOTDIR="${FLIGHTDECK_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"
ZDOTDIR="$__flightdeck_rcdir"
unset __flightdeck_rcdir
