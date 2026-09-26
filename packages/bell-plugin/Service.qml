import QtQuick
import Quickshell

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
}
