#!/usr/bin/env python3
"""PreToolUse hook: denies known-noisy package-manager install commands and
asks Claude to reissue them with a quiet flag, so ~hundreds of lines of
version/warning spam never enter context. Scoped to installers only -- never
touches test or build commands, since their verbose output can be needed for
debugging failures.

PreToolUse hooks cannot rewrite tool_input; deny + additionalContext is the
only supported way to steer a command before it runs.
"""
import json
import re
import sys

# (pattern to detect the noisy command, already-quiet indicator, suggested fix)
RULES = [
    (r"\bnpm\s+(install|ci)\b", r"--silent|--quiet|--loglevel[= ]", "add --silent"),
    (r"\byarn\s+(install|add)\b", r"--silent", "add --silent"),
    (r"\bpnpm\s+(install|add)\b", r"--silent|--reporter[= ]silent", "add --silent"),
    (r"\bpip3?\s+install\b", r"(^|\s)-q\b|--quiet", "add -q"),
    (r"\bbundle\s+install\b", r"--quiet", "add --quiet"),
    (r"\bapt-get\s+(install|upgrade|update)\b", r"(^|\s)-q{1,2}\b", "add -qq"),
]


def main() -> None:
    payload = json.load(sys.stdin)
    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    command = payload.get("tool_input", {}).get("command", "")

    for noisy_pat, quiet_pat, fix in RULES:
        if re.search(noisy_pat, command) and not re.search(quiet_pat, command):
            reason = (
                f"This install command is likely to dump a large amount of "
                f"version/warning noise into context. Reissue it with a quiet "
                f"flag ({fix}) -- failures still surface with a non-zero exit "
                f"code and error text even in quiet mode."
            )
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                },
                "additionalContext": reason,
            }))
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
