import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "bridge.js" as Bridge

/**
 * agent-fold panel.
 *
 * Opened by BarWidget.qml on click. Lists pending questions and permissions
 * grouped by thread. Each item is a button that, when clicked, opens T3 Code
 * to the relevant thread (deep-link via xdg-open) and dismisses the panel.
 *
 * v1 does NOT answer inline — answering happens in T3 Code's composer.
 * v2 will add inline answering via Bridge.respond().
 */
Panel {
  id: root
  moduleName: "io.github.ayan-de.agent-fold"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  function open() {
    root.controller.show()
  }
  function close() {
    root.controller.hide()
  }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function") {
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    }
    return false
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        Text {
          width: parent.width
          text: "Pending agent items"
          color: root.barForeground
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.subtitle
          font.bold: true
        }

        Repeater {
          model: hostWidget ? hostWidget.snapshot.threads : []
          delegate: Column {
            id: threadColumn
            property var threadData: modelData
            width: parent.width
            spacing: Style.space(4)
            Text {
              width: parent.width
              text: modelData.title
              color: root.barForeground
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.body
              font.bold: true
            }
            Repeater {
              model: modelData.items
              delegate: Item {
                width: parent.width
                implicitHeight: itemColumn.implicitHeight + Style.space(4)
                Column {
                  id: itemColumn
                  width: parent.width
                  spacing: Style.space(4)
                  Row {
                  id: itemRow
                  width: parent.width
                  spacing: Style.space(8)
                  Text {
                    text: modelData.kind === "question" ? "?" : "!"
                    color: modelData.kind === "question" ? "#f59e0b" : "#ef4444"
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  Text {
                    text: modelData.summary
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    wrapMode: Text.WordWrap
                    width: itemRow.width - 32
                  }
                }
                TextInput {
                  id: answerInput
                  visible: modelData.kind === "question"
                  width: parent.width
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                  text: ""
                  focus: false
                  clip: true
                  onAccepted: {
                    if (text.length === 0) return
                    Bridge.respond({ threadId: threadColumn.threadData.threadId, requestId: modelData.id, answers: { _answer: text } }).then(function() { text = ""; root.close() }).catch(function() {})
                  }
                }
                Text {
                  visible: modelData.kind === "question"
                  text: "Press Enter to send"
                  color: root.barForeground
                  opacity: 0.65
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                }
                }
              }
            }
          }
        }
      }
    }
  }
}
