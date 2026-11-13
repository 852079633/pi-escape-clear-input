# pi-escape-clear-input

A Pi TUI extension that preserves Pi's native Escape behavior first, then clears a non-empty prompt draft when no active operation handled Escape.

## Behavior

- During generation, agent-tool execution, or a user-entered `!` Bash command, Escape prioritizes interruption and preserves the draft.
- When Pi is idle and its native handler leaves a non-empty draft untouched, Escape clears the prompt.
- Autocomplete and modal dialogs keep their native Escape handling.

## Install

From npm:

```sh
pi install npm:pi-escape-clear-input@0.1.0
```

From GitHub:

```sh
pi install git:github.com/852079633/pi-escape-clear-input@v0.1.0
```

## Compatibility and limitations

- Tested with Pi 1.5.2; the host package is provided by Pi and is not bundled.
- This is a TUI extension; it does not patch Pi itself.
- To detect running user-entered `!` commands, the extension wraps Pi's local Bash backend through the `user_bash` event. Pi stops dispatching that event when a handler first returns backend operations. Place this package after observer-only `user_bash` handlers and last among packages using that event. Do not combine it with an earlier competing backend provider: that can prevent this extension from tracking the command; handlers ordered after it will not receive the event.
- Isolated PTY testing covers custom editor wrapping, autocomplete, dialogs, generation interruption, user Bash, agent Bash tools, and reloads. Compatibility with every third-party extension stack has not been established.

## License

MIT. See [LICENSE](./LICENSE).
