# Hommies Character States Test Guide

This guide explains how to test and record videos of all **9 different character states** of Hommie, the animated mark face in the Hommies plugin.

## The 9 States

| # | State | Mood | Eyes | Badge | Animations |
|---|-------|------|------|-------|-----------|
| 1 | **Idle** | 🌙 Default | Pill | None | Blinks normally |
| 2 | **Working** | ⚙️ Running tools | Pill | Animated dots | Fast snake on inner ring |
| 3 | **Thinking** | 🤔 Processing input | Pill | Animated dots | Slow snake on inner ring |
| 4 | **Approval** | ✅ Permission granted | Wide | `!` bang | Bounces up/down |
| 5 | **Question** | ❓ Needs input | Pill | `?` question mark | Tilted slightly |
| 6 | **Error** | ❌ API error | Flat/squinted | Dot | Shakes left/right |
| 7 | **Rate Limited** | ⏱️ Rate limited | Tired | Dot | Sweats, eyes drooping |
| 8 | **Finished** | 🎉 Turn complete | Happy/smile | Dot | Bounces, emits sparks |
| 9 | **Sleeping** | 😴 Idle timeout | Dash | None | Bobs gently, emits "Z"s |

## Setup

### 1. Start the Hommies Bridge

```bash
# Install if not already installed
npm install -g @thisisayande/hommies

# Start the bridge daemon
hommies-bridge
```

The bridge listens on localhost and writes its port to `~/.local/share/hommies/port.json`.

### 2. Verify the Bridge is Running

```bash
curl http://127.0.0.1:$(jq .port ~/.local/share/hommies/port.json)/healthz
# Should return 200 OK
```

### 3. Make the Test Script Executable

```bash
cd /home/ayan-de/Projects/omarchy-projects/agent-fold
chmod +x test-states.mjs
```

## Running the Test

### Interactive Mode

Run the test script to interactively toggle through states:

```bash
node test-states.mjs
```

You'll see a menu:
```
🎭 Hommies Character State Tester

Choose a state to simulate:

  1. 🌙 IDLE: No activity, no items
  2. ⚙️  WORKING: Running tools, snake animation fast
  3. 🤔 THINKING: Processing input, snake animation slow
  4. ✅ APPROVAL: Permission request, bouncing with '!' badge
  5. ❓ QUESTION: User input needed, tilted with '?' badge
  6. ❌ ERROR: API failed, flat eyes, shaking
  7. ⏱️  RATE LIMITED: Hit rate limit, tired eyes, sweating
  8. 🎉 FINISHED: Turn complete, happy smile, sparkles
  9. 😴 SLEEPING: Idle state, dash eyes, bobbing with Z's

  0. Exit
  r. Record GIF (cycles through all states)
```

Select a number (1-9) to activate that state. The Hommie character in the Omarchy top bar will change to match.

## Recording Videos

### Option 1: Manual Recording with Screen Capture

1. Start the bridge and test script
2. Open the Omarchy menu/notification area to see the Hommies bell
3. Use your screen recorder (OBS, Screenkey, etc.):
   ```bash
   # Example with ffmpeg
   ffmpeg -video_size 1920x1080 -framerate 30 -f x11grab -i :0 hommies-demo.mp4
   ```
4. Run the test script and step through each state, spending 2-3 seconds on each
5. Stop the recorder

### Option 2: Automated Cycling

Press `r` in the test script to automatically cycle through all 9 states with 2-second pauses between each. Record your screen during this time.

### Option 3: Using Claude-in-Chrome (Browser Automation)

You can use the browser automation tools to:
1. Open a preview of the widget
2. Take screenshots of each state
3. Assemble them into an animated GIF

Example (not yet implemented in test script):
```bash
# Would require a custom preview page showing the widget
# See packages/bell-plugin for the QML source
```

## Understanding the States

### Idle (State 1)
- **Triggered by:** No pending items, no active sessions
- **Visual:** Pill-shaped eyes, occasional blinks, no badge
- **Use case:** Default state when there's nothing to do

### Working (State 2) 
- **Triggered by:** `POST /v1/providers/claude/activity` with `hook_event_name: "PreToolUse"`
- **Visual:** Fast-moving snake animation on the inner ring (30 cells/sec)
- **Use case:** Running tools like Bash, Edit, Read commands

### Thinking (State 3)
- **Triggered by:** `POST /v1/providers/claude/activity` with `hook_event_name: "UserPromptSubmit"`
- **Visual:** Slower snake animation (15 cells/sec)
- **Use case:** Processing the user's prompt before taking action

### Approval (State 4)
- **Triggered by:** `POST /v1/providers/claude/permission` (PermissionRequest)
- **Visual:** Slightly wider eyes, bounces up and down, red `!` badge
- **Use case:** Requesting permission to run sensitive tools

### Question (State 5)
- **Triggered by:** `POST /v1/providers/claude/question` with `tool_name: "AskUserQuestion"`
- **Visual:** Tilted head (~0.12 radians), question mark `?` badge
- **Use case:** Asking the user to choose between options

### Error (State 6)
- **Triggered by:** `POST /v1/providers/claude/failure` with `error: "server_error"` (or other non-rate-limit errors)
- **Visual:** Flat, squinted eyes, red dot badge, shakes left and right
- **Use case:** API error, authentication failure, model not found, etc.

### Rate Limited (State 7)
- **Triggered by:** `POST /v1/providers/claude/failure` with `error: "rate_limit"`
- **Visual:** Tired/drooping eyes, orange dot badge, emits sweat drops
- **Use case:** Hit the API rate limit or server overloaded

### Finished (State 8)
- **Triggered by:** `POST /v1/providers/claude/stop` with `hook_event_name: "Stop"`
- **Visual:** Happy smile eyes, emits gold sparks, brief bounce animation
- **Use case:** Turn completed successfully

### Sleeping (State 9)
- **Triggered by:** 10 minutes (600 s) on the idle mood, from `Service.qml`
- **Visual:** Dash eyes (closed), gentle bobbing, emits `Z` letters floating upward
- **Use case:** Long idle timeout (not normally triggered in testing)

## Emotes

Emotes are short animations played on top of the mood. Hommie draws them
himself, so they are triggered over shell IPC, not through the bridge:

```sh
node test-states.mjs emote dizzy     # one emote
node test-states.mjs emotes 3        # every emote, 3 s apart
omarchy-shell hommies emote wink     # the same call the script makes
```

| Emote | Plays when | Looks like |
|-------|-----------|------------|
| `greet` | The character loads (shell start, plugin reload) | Pops in, wiggles, happy eyes |
| `celebrate` | Any turn finishes, even while another agent keeps the mood on working | A jump with sparks, happy eyes |
| `dizzy` | Five clicks within 2.5 s | Spinning spiral eyes, wobble, three stars circling above |
| `wink` | Every 20-45 s while idle (random) | Right eye closes briefly |
| `yawn` | Every 20-45 s while idle (random) | Eyes shut, a slow stretch |
| `look` | Every 20-45 s while idle (random) | Glances left, then right |

A single click is a poke: a squash, a blink, and a small hop.

**Agent moods always win.** Approval, question, error, and rate limit block
emotes and cancel one that is running, so an emote never hides something
that needs you. `wink`, `yawn`, and `look` only play on the idle mood, and
not while the pointer is over Hommie (his eyes follow it then). Asleep, he
only reacts to `greet` and `dizzy`. `omarchy-shell hommies emote` still
answers `ok` when the mood blocks an emote; nothing plays.

To see `celebrate` through the real path, choose **Finished while another
agent works** (`node test-states.mjs finishedBusy`): a working session keeps
the mood on working, and the second session's finished turn makes him jump.

## API Details

The test script sends JSON requests to the bridge. Examples:

```bash
# Test a working state
curl -X POST http://127.0.0.1:3000/v1/providers/claude/activity \
  -H "x-hommies-token: $(jq -r .token ~/.local/share/hommies/port.json)" \
  -H "Content-Type: application/json" \
  -d '{
    "hook_event_name": "PreToolUse",
    "session_id": "test-working",
    "cwd": "/home/user/project",
    "tool_name": "Bash",
    "tool_input": { "command": "npm run build" }
  }'

# Test a question state
curl -X POST http://127.0.0.1:3000/v1/providers/claude/question \
  -H "x-hommies-token: $(jq -r .token ~/.local/share/hommies/port.json)" \
  -H "Content-Type: application/json" \
  -d '{
    "hook_event_name": "PreToolUse",
    "session_id": "test-question",
    "cwd": "/home/user/project",
    "tool_name": "AskUserQuestion",
    "tool_use_id": "tuq-abc123",
    "tool_input": {
      "questions": [{
        "question": "Which option?",
        "options": [
          { "label": "Option A" },
          { "label": "Option B" }
        ],
        "multiSelect": false
      }]
    }
  }'
```

## Video Production Tips

1. **Lighting:** Record with consistent background (dark terminal or light desktop)
2. **Duration:** 2-3 seconds per state is good for viewing
3. **Transitions:** The state animations take ~0.3s, so allow extra time
4. **Audio:** Consider adding narration or music
5. **Resolution:** 1920x1080 or 1280x720 works well
6. **Frame rate:** 30 FPS is sufficient

## Troubleshooting

### Bridge not responding
```bash
# Check if bridge is running
ps aux | grep hommies-bridge

# Check port.json exists
cat ~/.local/share/hommies/port.json

# Manually test the healthz endpoint
curl http://127.0.0.1:$(jq .port ~/.local/share/hommies/port.json)/healthz -v
```

### Widget not visible
- Make sure Omarchy is running: `omarchy-shell shell rescanPlugins`
- Check that the Hommies plugin is installed: `ls ~/.config/omarchy/plugins/io.github.ayandexyz.hommies/`
- Restart Omarchy shell if needed

### State not changing
- Verify the API request succeeded (no 401/403 errors)
- Check the bridge logs: `journalctl -u hommies-bridge -f`
- Verify you're using the correct token from `port.json`

## Source Code

- **Character animations:** `packages/bell-plugin/characters/Hommie.qml`
- **Bridge server:** `packages/omarchy-bridge/src/server.ts`
- **Panel UI:** `packages/bell-plugin/Panel.qml`
- **Status colors:** `packages/bell-plugin/StatusPalette.qml`

## Next Steps

Once you have a video of all states:
1. Upload it to your project wiki or documentation
2. Share it in your team's Slack or communication channel
3. Use it for design/demo purposes
4. Create a demo reel or presentation
