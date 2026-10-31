#!/usr/bin/env python3
"""Claude Code hook for Rozan.

Register this script for the hook events listed in README.md. Each run reads one
hook event (JSON) from stdin and updates a small per-session state file in
~/.cache/rozan/agents/<session_id>.json, which the GNOME Shell extension
watches to show progress in the notch.

For PermissionRequest events it also waits (up to WAIT_SECONDS) for the user to
answer from the notch. The extension writes "allow", "deny" or "ask" to
<session_id>.decision; "ask", no answer, or any error falls back to the normal
prompt in the terminal.
"""
import json
import os
import sys
import tempfile
import time

STATE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "rozan", "agents")
WAIT_SECONDS = 60
HEARTBEAT_MAX_AGE = 30  # the extension refreshes .notch-alive every 10 s while it runs
MAX_STEPS = 6


def label_for(tool, tool_input):
    tool_input = tool_input or {}
    if tool == "Bash":
        return tool_input.get("command", "").strip().splitlines()[0][:200] if tool_input.get("command") else "Bash"
    for key in ("file_path", "path", "notebook_path"):
        if tool_input.get(key):
            return f"{tool} {os.path.basename(str(tool_input[key]))}"
    for key in ("pattern", "url", "query", "description", "subject"):
        if tool_input.get(key):
            return f"{tool} {str(tool_input[key])[:120]}"
    return tool or "Tool"


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(path, state):
    os.makedirs(STATE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def claude_pid():
    """PID of the Claude Code process that ran this hook, found by walking up /proc.

    The extension uses it to drop sessions whose terminal was closed without a
    SessionEnd event, and to find the terminal window to raise.
    """
    pid = os.getppid()
    for _ in range(8):
        try:
            with open(f"/proc/{pid}/stat") as f:
                stat = f.read()
        except OSError:
            return None
        # "pid (comm) state ppid ..."; comm may contain spaces, so split at the last ')'
        comm = stat[stat.index("(") + 1:stat.rindex(")")]
        ppid = int(stat[stat.rindex(")") + 2:].split()[1])
        if comm == "claude":
            return pid
        if pid <= 1 or ppid <= 1:
            return None
        pid = ppid
    return None


def update_tasks(state, tool, tool_input):
    tasks = state.setdefault("tasks", [])
    if tool == "TodoWrite" and isinstance(tool_input.get("todos"), list):
        state["tasks"] = [
            {"text": t.get("content") or t.get("activeForm") or "", "status": t.get("status", "pending"),
             "active": t.get("activeForm") or t.get("content") or ""}
            for t in tool_input["todos"] if isinstance(t, dict)
        ]
    elif tool in ("TaskUpdate",) and tool_input.get("status"):
        task_id = str(tool_input.get("taskId") or tool_input.get("task_id") or tool_input.get("id") or "")
        for t in tasks:
            if t.get("id") == task_id:
                t["status"] = tool_input["status"]


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    session = str(event.get("session_id") or "unknown").replace("/", "_")
    path = os.path.join(STATE_DIR, f"{session}.json")
    state = load(path)
    name = event.get("hook_event_name", "")
    tool = event.get("tool_name", "")
    tool_input = event.get("tool_input") or {}
    now = time.time()

    state.setdefault("session_id", session)
    state.setdefault("started", now)
    pid = claude_pid()
    if pid:
        state["pid"] = pid
    state["cwd"] = event.get("cwd") or state.get("cwd", "")
    state["agent"] = "Claude"
    if event.get("session_title"):
        state["title"] = event["session_title"]
    steps = state.setdefault("steps", [])

    if name == "SessionStart":
        state["status"] = "idle"
    elif name == "UserPromptSubmit":
        state["status"] = "working"
        prompt = (event.get("prompt") or "").strip().replace("\n", " ")
        state.setdefault("title", prompt[:80])
        state["prompt"] = prompt[:160]
        state["steps"] = []
        state["current"] = None
    elif name == "PreToolUse":
        state["status"] = "working"
        state["current"] = {"tool": tool, "label": label_for(tool, tool_input), "started": now}
    elif name in ("PostToolUse", "PostToolUseFailure"):
        update_tasks(state, tool, tool_input)
        steps.append({"label": label_for(tool, tool_input), "state": "done" if name == "PostToolUse" else "failed"})
        del steps[:-MAX_STEPS]
        state["current"] = None
    elif name == "TaskCreated":
        state.setdefault("tasks", []).append({"id": str(event.get("task_id", "")), "text": event.get("task_subject", ""),
                                              "status": "pending", "active": event.get("task_subject", "")})
    elif name == "TaskCompleted":
        for t in state.setdefault("tasks", []):
            if t.get("id") == str(event.get("task_id", "")):
                t["status"] = "completed"
    elif name == "Notification":
        state["notification"] = event.get("message", "")
    elif name == "Stop":
        state["status"] = "idle"
        state["current"] = None
        state["permission"] = None
    elif name == "SessionEnd":
        state["status"] = "ended"
        state["current"] = None
        state["permission"] = None

    state["updated"] = now

    if name != "PermissionRequest":
        save(path, state)
        return 0

    # Only wait for an answer if the notch is running; otherwise go straight to the terminal prompt.
    try:
        alive = time.time() - os.path.getmtime(os.path.join(STATE_DIR, ".notch-alive")) < HEARTBEAT_MAX_AGE
    except OSError:
        alive = False
    if not alive:
        save(path, state)
        return 0

    # PermissionRequest: show it in the notch and wait for an answer.
    request_id = f"{int(now * 1000)}"
    decision_path = os.path.join(STATE_DIR, f"{session}.decision")
    try:
        os.unlink(decision_path)
    except OSError:
        pass
    state["status"] = "waiting"
    state["permission"] = {"id": request_id, "tool": tool, "label": label_for(tool, tool_input), "created": now}
    save(path, state)

    decision = None
    deadline = now + WAIT_SECONDS
    while time.time() < deadline:
        try:
            with open(decision_path) as f:
                answer = json.load(f)
            if answer.get("id") == request_id:
                decision = answer.get("decision")
                os.unlink(decision_path)
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.25)

    state = load(path) or state
    state["permission"] = None
    state["status"] = "working"
    state["updated"] = time.time()
    save(path, state)

    if decision in ("allow", "deny"):
        out = {"behavior": decision}
        if decision == "deny":
            out["message"] = "Denied from Rozan"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": out}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
