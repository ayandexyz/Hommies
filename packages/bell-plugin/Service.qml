import QtQuick
import Quickshell
import Quickshell.Io

/**
 * agent-fold service.
 *
 * Headless singleton owned by the Omarchy shell. Its only job is to ensure
 * the bridge daemon is running while the shell is up.
 *
 * The daemon process wiring will be added here after the plugin client can
 * discover its installed bridge runtime. Keep this as an Item: a file named
 * Service.qml cannot instantiate Service or it recursively instantiates itself.
 */
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
}
