# Rozan (روزن)

A notch for GNOME Shell 42 (Wayland), modeled on NotchNook for macOS.

*Rozan* is the small opening high in a Persian wall that lets light in.

The extension UUID is still `linux-notch@local`, and its data lives in `~/.local/share/linux-notch` and `~/.cache/linux-notch`.

## Phase 1 (current)
- Black notch at the top center of the primary monitor, over the panel.
- Collapsed: clock. While music plays it widens and shows album art plus an equalizer.
- Expands on hover (120 ms delay), on click, or on scroll down. Closes 400 ms after the pointer leaves, or on scroll up.
- Music workspace (any MPRIS player: Spotify, Firefox, Chromium, VLC...): art, title, artist, a seekable progress bar, previous/play/next.
- Horizontal scroll on the notch: right = next track, left = previous.
- Hidden on fullscreen windows.

## Phase 2 (current)
- Live activities in the collapsed notch, one at a time, by priority:
  1. Volume/brightness HUD (replaces the stock popup; the stock popup is still used for fullscreen windows or while the notch is open), battery plug/unplug and low battery (20/10/5 %), finished downloads.
  2. A meeting starting within 10 minutes ("in N min"), or one that started less than 5 minutes ago ("now").
  3. A download in progress in ~/Downloads (Firefox `.part`, Chromium `.crdownload`, ...), with its size so far.
  4. Music playing.
  5. Clock.
- Calendar workspace (tab on the left of the open notch): today's remaining and tomorrow's events from GNOME's calendar server, so GNOME Online Accounts and Evolution calendars are included. An ongoing event is marked "Now".

## Phase 3 (current)
The open notch is styled after NotchNook's Classic look: concave top corners, a floating tab pill
(Nook / Music / Calendar), and a size per workspace.

Nook (home) workspace:
- Mini player: art with the player's app icon, title, album, artist, previous/play/next.
- CPU tile and battery tile (memory tile on machines without a battery), each with a history chart.
- Focus/Break timer: scroll or drag the minute ruler to set the length, Start/Pause/Resume,
  sound on/off, reset. When a period ends it plays the theme's alarm sound, shows a notification
  and switches to the other mode. While running it is shown as a live activity in the collapsed notch.
- To-dos: left click toggles done, right click deletes, "Add a task" opens a text field
  (Enter adds, Esc cancels, clicking elsewhere adds and closes).

To-dos and timer settings are stored in `~/.local/share/linux-notch/state.json`.

## Phase 4 (current): all workspaces from the NotchNook demo
Tabs: Nook, Music, Calendar, Tray, Prompter, Agents. Right-click the tab pill to switch between
**Classic** (black) and **Liquid Glass** (blurred, translucent).

- **Tray**: a shelf of file references. GNOME Shell 42 cannot receive drag-and-drop from Wayland
  apps, so copy files in Files (Ctrl+C) and press **Paste**. Left click opens a file; right click
  offers Open, Copy (paste it anywhere), Show in Files, Remove.
- **Prompter**: teleprompter for `.txt` scripts in `~/.local/share/linux-notch/scripts`
  (menu at top left; "Edit scripts…" opens the folder). 3-second countdown, speed and text size
  steppers, mouse wheel to jump. The lock keeps the notch open; it also stays open while running.
  Voice mode is shown but disabled (GNOME has no speech recognition service).
- **Agents**: Claude Code progress (current prompt, task list or recent tool steps, the running
  command with elapsed time) and permission requests you can Allow / Deny / send to the Terminal.
  While Claude works or waits for approval this also shows in the collapsed notch.
  With several Claude Code sessions open, each one gets a chip at the top of the page (folder
  name, green dot while working, orange while waiting for approval); click a chip to show that
  session. A new permission request switches to its session. The terminal button raises the
  window running the session (for ddterm it opens the drop-down; it cannot pick the tab).
  Sessions whose terminal was closed disappear within about 10 seconds.

### Claude Code hook (for the Agents workspace)
Add to `~/.claude/settings.json` (adjust the path):

```json
{
  "hooks": {
    "SessionStart":       [{"hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "UserPromptSubmit":   [{"hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "PreToolUse":         [{"matcher": "*", "hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "PostToolUse":        [{"matcher": "*", "hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "PostToolUseFailure": [{"matcher": "*", "hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "PermissionRequest":  [{"matcher": "*", "hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py", "timeout": 90}]}],
    "TaskCreated":        [{"hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "TaskCompleted":      [{"hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "Stop":               [{"hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}],
    "SessionEnd":         [{"hooks": [{"type": "command", "command": "/path/to/linux-notch@local/hooks/notch-hook.py"}]}]
  }
}
```

A permission request waits up to 60 seconds for an answer in the notch, then falls back to the
normal terminal prompt.

Note: the notch covers the center of the top bar, including the date menu.

## Install
The extension directory is symlinked into `~/.local/share/gnome-shell/extensions/linux-notch@local`.
On Wayland, GNOME Shell only discovers new extensions at login:

```bash
# log out and back in, then:
gnome-extensions enable linux-notch@local
```

After editing code, log out and in again (Wayland cannot restart the shell in place).

## Test without logging out
```bash
dbus-run-session -- gnome-shell --nested --wayland
```
In the nested window, enable the extension with `gnome-extensions enable linux-notch@local`.

## Logs
```bash
journalctl --user -f -o cat /usr/bin/gnome-shell | grep -iE 'notch|error'
```

## Uninstall
```bash
gnome-extensions disable linux-notch@local
rm ~/.local/share/gnome-shell/extensions/linux-notch@local
```

## Files
- `extension.js`: enable/disable entry point.
- `notch.js`: notch actor, expansion, gestures, music UI.
- `mpris.js`: MPRIS player discovery and active-player selection.
- `calendar.js`: calendar feed (GNOME Shell's DBusEventSource) and the Calendar workspace.
- `battery.js`: UPower display device monitor.
- `downloads.js`: Downloads folder monitor.
- `nook.js`: Nook workspace (mini player, system tiles, timer, to-dos).
- `timer.js`: Focus/Break timer.
- `sysmon.js`: CPU, memory and battery history sampling.
- `store.js`: JSON state file.
- `tray.js`, `prompter.js`, `agents.js`: Tray, Prompter and Agents workspaces.
- `hooks/notch-hook.py`: Claude Code hook that feeds the Agents workspace.
- `art.js`: album art cache (`~/.cache/linux-notch/art`), downloaded with curl.
- `stylesheet.css`: styles.
