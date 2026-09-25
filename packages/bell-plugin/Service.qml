import QtQuick
import Quickshell

/**
 * agent-fold service.
 *
 * Headless singleton owned by the Omarchy shell. Its only job is to ensure
 * the bridge daemon is running while the shell is up.
 *
 * The actual process spawn lives in `Service.js` — QML can call JS modules
 * directly via `import "Service.js" as Service`. Quickshell evaluates the JS
 * file in its own context, so we cannot share state with `bridge.mjs` by
 * import; `bridge.mjs` discovers the daemon over HTTP (port.json) and the
 * daemon is restarted by this service if its PID file goes missing.
 */
Service {
  id: root
  moduleName: "io.github.ayan-de.agent-fold"

  Component.onCompleted: {
    if (typeof Service !== "undefined") {
      Service.start()
    }
  }
}