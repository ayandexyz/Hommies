import QtQuick
import Quickshell
import Quickshell.Io

// Headless singleton owned by the Omarchy shell. Spawns the bridge daemon
// and hands the QML bridge client its {port, token} once the daemon has
// published them to <dataDir>/port.json. Keep this as an Item: a file named
// Service.qml cannot instantiate Service or it recursively instantiates itself.
Item {
  id: root

  readonly property string dataHome: Quickshell.env("XDG_DATA_HOME") || Quickshell.env("HOME") + "/.local/share"

  Process {
    id: bridgeProcess
    command: ["agent-fold-bridge", "--data-dir", root.dataHome + "/agent-fold", "--port", "0"]
    running: true
    onExited: restartTimer.restart()
  }

  Timer {
    id: restartTimer
    interval: 3000
    repeat: false
    onTriggered: bridgeProcess.running = true
  }

  // Poll for port.json until the daemon has written it, then hand the
  // {port, token} pair to bridge.js. When the daemon dies and is restarted,
  // the new port.json will differ — re-detect and reconfigure.
  Timer {
    id: portTimer
    interval: 250
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: {
      try {
        var info = JSON.parse(readFile(root.dataHome + "/agent-fold/port.json"))
        if (Number.isInteger(info.port) && typeof info.token === "string") {
          bridge.configure({ port: info.port, token: info.token })
        }
      } catch (_) {
        // port.json not present yet, or partial write — try again.
      }
    }
  }

  function readFile(path) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", "file://" + path, false)
    xhr.send()
    if (xhr.status >= 200 && xhr.status < 300) return xhr.responseText
    throw new Error("cannot read " + path)
  }
}
