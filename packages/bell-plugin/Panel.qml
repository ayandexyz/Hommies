import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "bridge.js" as Bridge

/**
 * agent-fold panel.
 *
 * Opened by BarWidget.qml on click. Lists pending questions and permissions
 * grouped by thread. Claude questions retain their native headers, options,
 * descriptions, and multi-select behavior. The configured answer surface
 * decides whether controls here are interactive or mirror the CLI prompt.
 */
Panel {
  id: root
  moduleName: "io.github.ayan-de.agent-fold"
  manageIpc: false

  component ProviderTab: Button {
    id: providerTab

    required property string providerId
    required property string providerName
    required property int pendingCount

    text: ""
    implicitHeight: tabContent.implicitHeight + Style.spacing.controlPaddingY * 2

    Row {
      id: tabContent
      anchors.centerIn: parent
      spacing: Style.spacing.controlGap

      ProviderLogo {
        anchors.verticalCenter: parent.verticalCenter
        providerId: providerTab.providerId
        tint: providerTab.selected
          ? Style.selectedStateColor(providerTab.foreground, providerTab.accent)
          : providerTab.foreground
        fontFamily: providerTab.fontFamily
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: providerTab.providerName + "  " + providerTab.pendingCount
        color: providerTab.selected
          ? Style.selectedStateColor(providerTab.foreground, providerTab.accent)
          : providerTab.foreground
        font.family: providerTab.fontFamily
        font.pixelSize: providerTab.fontSize
        font.bold: providerTab.selected
      }
    }
  }

  property var anchorItem: null
  property var hostWidget: null
  property string selectedProvider: "claude"

  readonly property bool questionsAnsweredInTopbar: hostWidget
    ? hostWidget.questionAnswerSurface === "topbar"
    : String(setting("questionAnswerSurface", "Top bar")) !== "Claude CLI"

  function toggleQuestionAnswerSurface() {
    if (!hostWidget || typeof hostWidget.setQuestionAnswerSurface !== "function") return
    hostWidget.setQuestionAnswerSurface(root.questionsAnsweredInTopbar ? "cli" : "topbar")
  }

  function providerCount(provider) {
    var count = 0
    var threads = hostWidget && hostWidget.snapshot ? hostWidget.snapshot.threads : []
    for (var threadIndex = 0; threadIndex < threads.length; threadIndex++) {
      var items = threads[threadIndex].items || []
      for (var itemIndex = 0; itemIndex < items.length; itemIndex++) {
        if (items[itemIndex].provider === provider) count++
      }
    }
    return count
  }

  function providerThreads(provider) {
    var result = []
    var threads = hostWidget && hostWidget.snapshot ? hostWidget.snapshot.threads : []
    for (var threadIndex = 0; threadIndex < threads.length; threadIndex++) {
      var thread = threads[threadIndex]
      var items = []
      for (var itemIndex = 0; itemIndex < thread.items.length; itemIndex++) {
        if (thread.items[itemIndex].provider === provider) items.push(thread.items[itemIndex])
      }
      if (items.length > 0) {
        result.push({ threadId: thread.threadId, title: thread.title, items: items })
      }
    }
    return result
  }

  function desiredPanelWidth() {
    var longest = 0
    var threads = providerThreads(root.selectedProvider)
    for (var threadIndex = 0; threadIndex < threads.length; threadIndex++) {
      var items = threads[threadIndex].items || []
      for (var itemIndex = 0; itemIndex < items.length; itemIndex++) {
        var item = items[itemIndex]
        var questions = item.questions || []
        for (var questionIndex = 0; questionIndex < questions.length; questionIndex++) {
          var question = questions[questionIndex]
          longest = Math.max(longest, String(question.question || "").length)
          var options = question.options || []
          for (var optionIndex = 0; optionIndex < options.length; optionIndex++) {
            longest = Math.max(longest, String(options[optionIndex].label || "").length)
          }
        }
      }
    }

    // Keep ordinary prompts compact, then grow quickly enough for long option
    // labels. KeyboardPanel still clamps the result to the monitor width.
    var width = 360 + Math.max(0, longest - 50) * 5
    return Style.space(Math.min(720, width))
  }

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
    contentWidth: panel.fittedContentWidth(root.desiredPanelWidth())
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

        Item {
          width: parent.width
          implicitHeight: answerModeRow.implicitHeight

          Row {
            id: answerModeRow
            anchors.right: parent.right
            spacing: Style.space(4)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: root.questionsAnsweredInTopbar ? "Answer: Top bar" : "Answer: Claude CLI"
              color: root.barForeground
              opacity: 0.72
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }

            ToggleSwitch {
              anchors.verticalCenter: parent.verticalCenter
              checked: root.questionsAnsweredInTopbar
              foreground: root.barForeground
              trackHeight: 22
              cursorPad: Style.space(2)
              onToggled: root.toggleQuestionAnswerSurface()
            }
          }
        }

        Row {
          id: providerTabs
          width: parent.width
          spacing: Style.space(8)

          readonly property real tabWidth: (width - spacing) / 2

          ProviderTab {
            width: providerTabs.tabWidth
            providerId: "claude"
            providerName: "Claude"
            pendingCount: root.providerCount("claude")
            selected: root.selectedProvider === "claude"
            bordered: true
            foreground: root.barForeground
            fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
            fontSize: Style.font.body
            onClicked: root.selectedProvider = "claude"
          }

          ProviderTab {
            width: providerTabs.tabWidth
            providerId: "codex"
            providerName: "Codex"
            pendingCount: root.providerCount("codex")
            selected: root.selectedProvider === "codex"
            bordered: true
            foreground: root.barForeground
            fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
            fontSize: Style.font.body
            onClicked: root.selectedProvider = "codex"
          }
        }

        Text {
          visible: root.providerCount(root.selectedProvider) === 0
          width: parent.width
          topPadding: Style.space(12)
          bottomPadding: Style.space(12)
          text: "No pending " + (root.selectedProvider === "claude" ? "Claude" : "Codex") + " items"
          color: root.barForeground
          opacity: 0.65
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
        }

        Repeater {
          model: root.providerThreads(root.selectedProvider)
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
                id: itemDelegate

                property var itemData: modelData
                property var draftAnswers: ({})
                // XMLHttpRequest JSON arrays can arrive in QML as array-like
                // QVariant values, for which Array.isArray() returns false.
                // Repeater accepts those values directly, so only guard for a
                // missing field instead of discarding a valid question list.
                readonly property var questions: itemData.kind === "question" && itemData.questions
                  ? itemData.questions : []
                readonly property bool answerInTopbar: itemData.answerSurface !== "cli"

                function answerFor(questionId) {
                  return draftAnswers[questionId]
                }

                function optionSelected(questionId, label) {
                  var answer = answerFor(questionId)
                  return Array.isArray(answer) ? answer.indexOf(label) >= 0 : answer === label
                }

                function chooseOption(question, label) {
                  if (!answerInTopbar) return
                  var next = Object.assign({}, draftAnswers)
                  if (question.multiSelect) {
                    var selected = Array.isArray(next[question.id]) ? next[question.id].slice() : []
                    var index = selected.indexOf(label)
                    if (index >= 0) selected.splice(index, 1)
                    else selected.push(label)
                    next[question.id] = selected
                  } else {
                    next[question.id] = label
                  }
                  draftAnswers = next
                }

                function setCustomAnswer(questionId, answer) {
                  if (!answerInTopbar) return
                  var next = Object.assign({}, draftAnswers)
                  next[questionId] = answer
                  draftAnswers = next
                }

                function readyToSubmit() {
                  if (questions.length === 0) return false
                  for (var index = 0; index < questions.length; index++) {
                    var answer = answerFor(questions[index].id)
                    if (Array.isArray(answer)) {
                      if (answer.length === 0) return false
                    } else if (typeof answer !== "string" || answer.trim().length === 0) {
                      return false
                    }
                  }
                  return true
                }

                function submitAnswers() {
                  if (!readyToSubmit()) return
                  var answers = {}
                  for (var index = 0; index < questions.length; index++) {
                    var question = questions[index]
                    var answer = answerFor(question.id)
                    answers[question.id] = Array.isArray(answer) ? answer.join(", ") : answer.trim()
                  }
                  Bridge.respond({
                    threadId: threadColumn.threadData.threadId,
                    requestId: itemData.id,
                    answers: answers
                  }).then(function() {
                    itemDelegate.draftAnswers = ({})
                    root.close()
                  }).catch(function(error) {
                    console.warn("agent-fold answer failed:", error)
                  })
                }

                width: parent.width
                implicitHeight: itemColumn.implicitHeight + Style.space(4)
                Column {
                  id: itemColumn
                  width: parent.width
                  spacing: Style.space(4)
                  Row {
                  id: itemRow
                  visible: itemDelegate.itemData.kind !== "question"
                  width: parent.width
                  spacing: Style.space(8)
                  Text {
                    text: itemDelegate.itemData.kind === "question" ? "?" : "!"
                    color: itemDelegate.itemData.kind === "question" ? "#f59e0b" : "#ef4444"
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  Text {
                    text: itemDelegate.itemData.summary
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    width: itemRow.width - 32
                  }
                }

                Repeater {
                  model: itemDelegate.questions

                  delegate: Column {
                    id: questionColumn
                    property var questionData: modelData
                    width: itemColumn.width
                    spacing: Style.space(4)

                    Text {
                      width: parent.width
                      text: questionColumn.questionData.header
                      color: root.barForeground
                      opacity: 0.72
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }

                    Text {
                      width: parent.width
                      text: questionColumn.questionData.question
                      color: root.barForeground
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.body
                      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    }

                    Repeater {
                      model: questionColumn.questionData.options

                      delegate: Column {
                        id: optionColumn
                        property var optionData: modelData
                        width: questionColumn.width
                        spacing: Style.space(2)

                        Button {
                          id: optionButton
                          width: parent.width
                          height: Math.max(Style.space(32), optionLabel.implicitHeight
                            + verticalPadding * 2 + Style.normalBorderWidth * 2)
                          text: ""
                          leftAlign: true
                          bordered: true
                          selected: itemDelegate.optionSelected(
                            questionColumn.questionData.id, optionColumn.optionData.label)
                          foreground: root.barForeground
                          fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                          fontSize: Style.font.bodySmall
                          opacity: itemDelegate.answerInTopbar ? 1 : 0.72
                          onClicked: itemDelegate.chooseOption(
                            questionColumn.questionData, optionColumn.optionData.label)

                          Text {
                            id: optionLabel
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.leftMargin: optionButton.horizontalPadding + Style.normalBorderWidth
                            anchors.rightMargin: optionButton.horizontalPadding + Style.normalBorderWidth
                            textFormat: Text.PlainText
                            text: optionColumn.optionData.label
                            color: optionButton.selected
                              ? Style.selectedStateColor(optionButton.foreground, optionButton.accent)
                              : optionButton.foreground
                            font.family: optionButton.fontFamily
                            font.pixelSize: optionButton.fontSize
                            font.bold: optionButton.selected
                            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                          }
                        }

                        Text {
                          visible: optionColumn.optionData.description !== undefined
                            && optionColumn.optionData.description !== ""
                          width: parent.width
                          leftPadding: Style.space(8)
                          rightPadding: Style.space(8)
                          text: optionColumn.optionData.description || ""
                          color: root.barForeground
                          opacity: 0.62
                          font.family: root.bar ? root.bar.fontFamily : Style.font.family
                          font.pixelSize: Style.font.caption
                          wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                        }
                      }
                    }

                    TextInput {
                      visible: itemDelegate.answerInTopbar
                      width: parent.width
                      color: root.barForeground
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.body
                      text: ""
                      focus: false
                      clip: true
                      onTextEdited: itemDelegate.setCustomAnswer(questionColumn.questionData.id, text)
                      onAccepted: itemDelegate.submitAnswers()
                    }
                  }
                }

                Text {
                  visible: itemDelegate.itemData.kind === "question"
                    && itemDelegate.questions.length === 0
                  width: parent.width
                  text: itemDelegate.itemData.summary || "Claude needs your input"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                  wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                }

                Text {
                  visible: itemDelegate.itemData.kind === "question"
                  text: itemDelegate.answerInTopbar
                    ? (itemDelegate.questions.length > 0
                        ? "Select or type an answer for every question"
                        : "This question has no structured input")
                    : "Answer this question in Claude CLI"
                  color: root.barForeground
                  opacity: 0.65
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                }

                Button {
                  visible: itemDelegate.itemData.kind === "question"
                    && itemDelegate.answerInTopbar
                    && itemDelegate.questions.length > 0
                  width: parent.width
                  text: "Send answer"
                  bordered: true
                  selected: itemDelegate.readyToSubmit()
                  foreground: root.barForeground
                  fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                  fontSize: Style.font.body
                  opacity: itemDelegate.readyToSubmit() ? 1 : 0.5
                  onClicked: itemDelegate.submitAnswers()
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
