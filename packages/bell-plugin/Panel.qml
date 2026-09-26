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
 * `attention` items are notify-only: Claude ended its turn with a plain-text
 * question, so the reply happens in the terminal and the bar can only dismiss.
 * `finished` items mark a session whose turn ended without a question. They
 * count toward the bell like other items but render as "Done".
 *
 * Each provider tab first lists its sessions (one row per thread); clicking a
 * row opens that session's items and the back row returns to the list.
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

  component SessionRow: Button {
    id: sessionRow

    // Not `required`: a required property on a Repeater delegate stops QML
    // from injecting `modelData`, which the delegate binds this from.
    property var threadData: ({ threadId: "", title: "", items: [] })

    readonly property bool finished: root.threadFinished(threadData)

    text: ""
    leftAlign: true
    bordered: true
    opacity: finished ? 0.72 : 1
    implicitHeight: sessionContent.implicitHeight + Style.spacing.controlPaddingY * 2

    Column {
      id: sessionContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: sessionRow.horizontalPadding + Style.normalBorderWidth
      anchors.rightMargin: sessionRow.horizontalPadding + Style.normalBorderWidth
      spacing: Style.space(2)

      Row {
        width: parent.width
        spacing: Style.space(6)

        Text {
          id: sessionTitle
          width: parent.width - sessionCount.width - sessionChevron.width - parent.spacing * 2
          text: root.sessionLabel(sessionRow.threadData)
          textFormat: Text.PlainText
          elide: Text.ElideRight
          color: sessionRow.foreground
          font.family: sessionRow.fontFamily
          font.pixelSize: sessionRow.fontSize
          font.bold: true
        }
        Text {
          id: sessionCount
          text: sessionRow.finished ? "Done" : String(root.pendingItemCount(sessionRow.threadData))
          color: sessionRow.finished ? "#22c55e" : sessionRow.foreground
          font.family: sessionRow.fontFamily
          font.pixelSize: sessionRow.fontSize
          font.bold: true
        }
        Text {
          id: sessionChevron
          text: "\u203a"
          color: sessionRow.foreground
          opacity: 0.72
          font.family: sessionRow.fontFamily
          font.pixelSize: sessionRow.fontSize
        }
      }

      Text {
        width: parent.width
        text: root.sessionPreview(sessionRow.threadData)
        textFormat: Text.PlainText
        elide: Text.ElideRight
        color: sessionRow.foreground
        opacity: 0.65
        font.family: sessionRow.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  property var anchorItem: null
  property var hostWidget: null
  property string selectedProvider: "claude"
  /** Empty shows the session list; otherwise the open session's thread id. */
  property string selectedThreadId: ""

  readonly property var currentThreads: providerThreads(selectedProvider)
  // Falls back to the list when the open session has no pending items left.
  readonly property var openThread: {
    for (var index = 0; index < currentThreads.length; index++) {
      if (currentThreads[index].threadId === selectedThreadId) return currentThreads[index]
    }
    return null
  }

  onSelectedProviderChanged: selectedThreadId = ""

  function sessionProject(thread) {
    if (thread.project) return String(thread.project)
    // Bridges older than `project` only send "Claude Code — <folder>".
    var title = String(thread.title || "")
    var separator = title.indexOf(" \u2014 ")
    return separator >= 0 ? title.slice(separator + 3) : title
  }

  // Claude's /resume title names the session; the folder is the fallback,
  // with a short id so two untitled sessions in one folder stay distinct.
  function sessionLabel(thread) {
    if (thread.sessionTitle) return String(thread.sessionTitle)
    return sessionProject(thread) + "  \u00b7  " + String(thread.threadId).slice(0, 8)
  }

  function sessionPreview(thread) {
    var items = thread.items || []
    var latest = items.length > 0 ? items[items.length - 1] : null
    if (!latest) return ""
    var prefix = latest.kind === "permission" ? "Permission: "
      : latest.kind === "attention" ? "Waiting: "
      : latest.kind === "finished" ? "Finished: " : "Question: "
    var preview = prefix + String(latest.summary || "")
    return thread.sessionTitle ? sessionProject(thread) + "  \u00b7  " + preview : preview
  }

  readonly property bool questionsAnsweredInTopbar: hostWidget
    ? hostWidget.questionAnswerSurface === "topbar"
    : String(setting("questionAnswerSurface", "Top bar")) !== "Claude CLI"

  readonly property bool desktopNotifications: hostWidget
    ? hostWidget.desktopNotifications
    : setting("desktopNotifications", true) !== false

  function toggleDesktopNotifications() {
    if (!hostWidget || typeof hostWidget.setDesktopNotifications !== "function") return
    hostWidget.setDesktopNotifications(!root.desktopNotifications)
  }

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

  function pendingItemCount(thread) {
    var count = 0
    var items = thread.items || []
    for (var index = 0; index < items.length; index++) {
      if (items[index].kind !== "finished") count++
    }
    return count
  }

  function threadFinished(thread) {
    return (thread.items || []).length > 0 && pendingItemCount(thread) === 0
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
        result.push({
          threadId: thread.threadId,
          title: thread.title,
          sessionTitle: thread.sessionTitle,
          project: thread.project,
          items: items
        })
      }
    }
    // Sessions that need you first; finished ones keep their relative order.
    var waiting = result.filter(function(thread) { return !threadFinished(thread) })
    var finished = result.filter(function(thread) { return threadFinished(thread) })
    return waiting.concat(finished)
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

            Text {
              anchors.verticalCenter: parent.verticalCenter
              leftPadding: Style.space(8)
              text: "Notify"
              color: root.barForeground
              opacity: 0.72
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }

            ToggleSwitch {
              anchors.verticalCenter: parent.verticalCenter
              checked: root.desktopNotifications
              foreground: root.barForeground
              trackHeight: 22
              cursorPad: Style.space(2)
              onToggled: root.toggleDesktopNotifications()
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
            onClicked: { root.selectedProvider = "claude"; root.selectedThreadId = "" }
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
            onClicked: { root.selectedProvider = "codex"; root.selectedThreadId = "" }
          }
        }

        Text {
          visible: root.currentThreads.length === 0
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
          model: root.openThread ? [] : root.currentThreads
          delegate: SessionRow {
            width: parent.width
            threadData: modelData
            foreground: root.barForeground
            fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
            fontSize: Style.font.body
            onClicked: root.selectedThreadId = modelData.threadId
          }
        }

        Repeater {
          model: root.openThread ? [root.openThread] : []
          delegate: Column {
            id: threadColumn
            property var threadData: modelData
            width: parent.width
            spacing: Style.space(4)
            Button {
              width: parent.width
              text: "\u2039  " + root.sessionLabel(modelData)
              leftAlign: true
              bordered: true
              foreground: root.barForeground
              fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
              fontSize: Style.font.body
              onClicked: root.selectedThreadId = ""
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

                // "cancel" releases the hook without a decision, so the
                // provider falls back to its native terminal prompt. For
                // attention items any decision simply dismisses them.
                function respondPermission(decision) {
                  Bridge.respond({
                    threadId: threadColumn.threadData.threadId,
                    requestId: itemData.id,
                    decision: decision
                  }).then(function() {
                    if (root.hostWidget && typeof root.hostWidget.refreshSnapshot === "function")
                      root.hostWidget.refreshSnapshot()
                  }).catch(function(error) {
                    console.warn("agent-fold permission response failed:", error)
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
                    text: itemDelegate.itemData.kind === "attention" ? "\u21a9"
                      : itemDelegate.itemData.kind === "finished" ? "\u2713" : "!"
                    color: itemDelegate.itemData.kind === "attention" ? "#3b82f6"
                      : itemDelegate.itemData.kind === "finished" ? "#22c55e" : "#ef4444"
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  Text {
                    text: itemDelegate.itemData.summary
                    textFormat: Text.PlainText
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
                  textFormat: Text.PlainText
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

                Text {
                  visible: itemDelegate.itemData.kind === "attention" || itemDelegate.itemData.kind === "finished"
                  text: itemDelegate.itemData.kind === "finished"
                    ? "Claude finished this turn"
                    : "Claude is waiting for your reply in the terminal"
                  color: root.barForeground
                  opacity: 0.65
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.caption
                }

                Button {
                  visible: itemDelegate.itemData.kind === "attention" || itemDelegate.itemData.kind === "finished"
                  width: parent.width
                  text: "Dismiss"
                  bordered: true
                  foreground: root.barForeground
                  fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                  fontSize: Style.font.bodySmall
                  onClicked: itemDelegate.respondPermission("cancel")
                }

                Row {
                  id: permissionRow
                  visible: itemDelegate.itemData.kind === "permission"
                  width: parent.width
                  spacing: Style.space(4)

                  Repeater {
                    model: [
                      { label: "Allow", decision: "accept" },
                      { label: "Deny", decision: "decline" },
                      { label: "Ask in CLI", decision: "cancel" }
                    ]

                    delegate: Button {
                      width: (permissionRow.width - permissionRow.spacing * 2) / 3
                      text: modelData.label
                      bordered: true
                      selected: modelData.decision === "accept"
                      foreground: root.barForeground
                      fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                      fontSize: Style.font.bodySmall
                      onClicked: itemDelegate.respondPermission(modelData.decision)
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
  }
}
