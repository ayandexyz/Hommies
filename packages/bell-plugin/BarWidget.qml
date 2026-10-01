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
  readonly property string questionAnswerSurface: String(setting("questionAnswerSurface", "Top bar")) === "Claude CLI"
    ? "cli" : "topbar"
  readonly property bool desktopNotifications: setting("desktopNotifications", true) !== false
  readonly property bool sounds: setting("sounds", false) === true
  property var snapshot: ({ totalCount: 0, threads: [], sessions: [] })
  /** Sessions thinking or running tools; shown as a dot next to the bell. */
  readonly property int busyCount: {
    var sessions = snapshot && snapshot.sessions ? snapshot.sessions : []
    var count = 0
    for (var index = 0; index < sessions.length; index++) {
      if (sessions[index].state === "working" || sessions[index].state === "thinking") count++
    }
    return count
  }

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
    panelLoader.item.settings = root.settings
  }
  function refreshSnapshot() {
    if (typeof Bridge !== "undefined") {
      Bridge.snapshot().then((s) => { root.snapshot = s }).catch((error) => {
        console.warn("agent-fold snapshot failed:", error)
      })
    }
  }
  function syncPreferences() {
    if (typeof Bridge === "undefined") return
    Bridge.setPreferences({
      questionAnswerSurface: root.questionAnswerSurface,
      desktopNotifications: root.desktopNotifications,
      sounds: root.sounds
    }).catch((error) => {
      console.warn("agent-fold preference sync failed:", error)
    })
  }
  function setQuestionAnswerSurface(surface) {
    updateSetting("questionAnswerSurface", surface === "cli" ? "Claude CLI" : "Top bar")
  }
  function setDesktopNotifications(enabled) {
    updateSetting("desktopNotifications", enabled === true)
  }
  function setSounds(enabled) {
    updateSetting("sounds", enabled === true)
  }
  function updateSetting(name, value) {
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry[name] = value

    // Update the live widget first, then persist through Omarchy's supported
    // inline-settings API. The binding above synchronizes the bridge.
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onQuestionAnswerSurfaceChanged: syncPreferences()
  onDesktopNotificationsChanged: syncPreferences()
  onSoundsChanged: syncPreferences()

  FileView {
    path: (Quickshell.env("XDG_DATA_HOME") || Quickshell.env("HOME") + "/.local/share") + "/agent-fold/port.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        Bridge.configure(JSON.parse(text()))
        root.syncPreferences()
        root.refreshSnapshot()
      } catch (error) {
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
    text: "\ud83d\udd14" + (root.snapshot.totalCount > 0 ? " " + root.snapshot.totalCount : "")
      + (root.busyCount > 0 ? " \u25cf" : "")
    tooltipText: (root.snapshot.totalCount > 0
      ? root.snapshot.totalCount + " pending agent item(s)"
      : "agent-fold: no pending items")
      + (root.busyCount > 0 ? "\n" + root.busyCount + " agent session(s) working" : "")
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }
}
