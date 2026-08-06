# Shell integration for Fish, sourced via -C before the first prompt.
#
# Fish has no --rcfile, but -C runs commands before the first prompt. The
# events fish_prompt/fish_preexec deliver the same as PROMPT_COMMAND + the
# DEBUG trap in Bash.

function __flightdeck_prompt --on-event fish_prompt
    printf '\033]133;D\007\033]133;A\007\033]7;file://%s%s\007' $hostname $PWD
end
function __flightdeck_preexec --on-event fish_preexec
    printf '\033]7770;cmd;%s\007' (printf '%s' $argv[1] | base64 | string join '')
    printf '\033]133;C\007'
end
function __flightdeck_uuid
    if test -r /proc/sys/kernel/random/uuid
        cat /proc/sys/kernel/random/uuid
    else
        uuidgen 2>/dev/null | string lower
    end
end
function claude
    set -l mode new
    for a in $argv
        switch $a
            case -c --continue
                set mode continue
            case -r --resume '--resume=*' --session-id '--session-id=*'
                set mode other
        end
    end
    if test $mode = new
        set -l id (__flightdeck_uuid)
        if test -n "$id"
            printf '\033]7771;session;%s\007' $id
            command claude --session-id $id $argv
            return $status
        end
    else if test $mode = continue
        printf '\033]7771;continue;\007'
    end
    command claude $argv
end
