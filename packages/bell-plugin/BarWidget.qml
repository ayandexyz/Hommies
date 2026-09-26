import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import "bridge.js" as Bridge

/**
 * agent-fold bar widget.
 *
 * Shows a bell glyph with a pending count badge. Click toggles the Panel
 * (defined in Panel.qml), which lists the pending items grouped by thread.
 *
 * The `bridge.mjs` module is the only thing in this plugin that talks to
 * the bridge daemon — it is loaded lazily and exposes `Bridge.snapshot()`,
 * `Bridge.subscribe()`, `Bridge.respond()`.
 *
 * Module name MUST match the manifest id and the `moduleName` in Panel.qml
 * and Service.qml.
 */
BarWidget {
  id: root
  moduleName: "io.github.ayan-de.agent-fold"

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  property var snapshot: ({ totalCount: 0, threads: [] })

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }
  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }
  function toggle() {
    if (panelLoader.item) panelLoader.item.toggle()
  }
  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }
  function injectPanel() {
    if (!panelLoader.item) return
    panelLoader.item.bar = root.bar
    panelLoader.item.anchorItem = button
    panelLoader.item.hostWidget = root
  }
  function refreshSnapshot() {
    if (typeof Bridge !== "undefined") {
      Bridge.snapshot().then((s) => { root.snapshot = s }).catch((error) => {
        console.warn("agent-fold snapshot failed:", error)
      })
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()

  FileView {
    path: (Quickshell.env("XDG_DATA_HOME") || Quickshell.env("HOME") + "/.local/share") + "/agent-fold/port.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { Bridge.configure(JSON.parse(text())); root.refreshSnapshot() } catch (error) {
        console.warn("agent-fold connection file invalid:", error)
      }
    }
  }

  Timer {
    id: pollTimer
    interval: 3000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshSnapshot()
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.snapshot.totalCount > 0 ? "\ud83d\udd14 " + root.snapshot.totalCount : "\ud83d\udd14"
    tooltipText: root.snapshot.totalCount > 0
      ? root.snapshot.totalCount + " pending agent item(s)"
      : "agent-fold: no pending items"
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }
}
