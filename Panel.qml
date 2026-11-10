import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Devices LibreNMS marks down. The address and token live in secret.json
// next to this plugin (mode 600), not in shell.json. curl is a fixed script
// whose arguments are the script path only; the token is an environment
// header, and the script refuses any URL that is not the down-device route.
Panel {
  id: root

  moduleName: "mvolz.librenms"
  ipcTarget: "mvolz.librenms"

  // nf-fa-server.
  readonly property string iconServer: "\uF233"
  readonly property int refreshIntervalMs: 60000

  readonly property bool refreshEnabled: setting("refreshEnabled", true) !== false
  readonly property bool notifyEnabled: setting("notifyEnabled", true) !== false

  property int secretRevision: 0
  readonly property var secret: {
    var _tick = secretRevision
    return Model.parseSecret(secretFile.text())
  }
  readonly property string baseUrl: secret.url
  readonly property string token: secret.token
  readonly property bool configured: baseUrl !== "" && token !== ""

  property var devices: []
  property bool truncated: false
  // Down-device ids from the last good poll. Not named baseline: Item.baseline is final.
  property var knownDown: []
  property bool haveBaseline: false
  property string lastError: ""
  property bool checking: false
  property bool editing: false
  property string formError: ""
  property double lastFetchMs: 0
  property var pendingNotes: []

  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property int downCount: devices.length
  readonly property string barCount: downCount > 0 ? Commons.I18n.formatNumber(downCount) : ""

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  Text {
    id: countMeasure
    visible: false
    text: root.barCount
    textFormat: Text.PlainText
    font.family: root.fontFamily
    font.pixelSize: Style.bar.iconFont
  }

  readonly property int barSlot: Math.max(
    Style.bar.iconSlot,
    Math.ceil(countMeasure.implicitWidth + Style.bar.iconFont + Style.space(12)))

  implicitWidth: bar && bar.vertical ? bar.barSize : barSlot
  implicitHeight: bar && bar.vertical ? barSlot : (bar ? bar.barSize : Style.bar.sizeHorizontal)

  onBaseUrlChanged: {
    haveBaseline = false
    knownDown = []
    devices = []
    truncated = false
    lastError = ""
  }

  function open() {
    root.controller.show()
    root.refreshIfStale()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function persistSettings(values) {
    var entry = { id: root.moduleName }
    var current = root.settings || {}
    for (var existing in current) if (existing !== "id") entry[existing] = current[existing]
    for (var key in values) entry[key] = values[key]
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function knownError(key) {
    if (key === "error.resolve") return strings.t("error.resolve")
    if (key === "error.connect") return strings.t("error.connect")
    if (key === "error.timeout") return strings.t("error.timeout")
    if (key === "error.tls") return strings.t("error.tls")
    if (key === "error.auth") return strings.t("error.auth")
    if (key === "error.large") return strings.t("error.large")
    if (key === "error.parse") return strings.t("error.parse")
    if (key === "error.api") return strings.t("error.api")
    if (key === "error.failed") return strings.t("error.failed")
    return ""
  }

  function formErrorText() {
    if (formError === "long") return strings.t("panel.long")
    if (formError === "token") return strings.t("panel.tokenInvalid")
    if (formError === "save") return strings.t("panel.saveFailed")
    if (formError === "empty" || formError === "chars" || formError === "scheme"
        || formError === "host" || formError === "port" || formError === "path")
      return strings.t("panel.invalid")
    return ""
  }

  function deviceName(row) {
    if (row && row.name) return row.name
    if (row && row.id) return strings.t("panel.unnamed").arg(row.id)
    return ""
  }

  function refreshIfStale() {
    if (!configured) return
    if (Date.now() - lastFetchMs < 15000) return
    refresh()
  }

  function refresh() {
    var url = Model.devicesUrl(baseUrl)
    if (!url || !Model.validToken(token) || fetchProc.running) return
    checking = true
    lastFetchMs = Date.now()
    fetchProc.environment = { LIBRENMS_URL: url, LIBRENMS_TOKEN: token }
    fetchProc.command = [fetchScript]
    fetchProc.running = true
  }

  function applyFetch(exitCode, body) {
    checking = false
    if (exitCode !== 0) {
      lastError = Model.failureKey(exitCode)
      return
    }
    var parsed = Model.parseDownList(body)
    if (!parsed.ok) {
      lastError = parsed.error
      return
    }
    var change = Model.transitions(haveBaseline ? knownDown : null, parsed.devices)
    devices = parsed.devices
    truncated = parsed.truncated === true
    knownDown = change.baseline
    lastError = ""
    if (change.ready && notifyEnabled) announce(change)
    haveBaseline = true
  }

  function announce(change) {
    var note = Model.notice(change)
    if (note) enqueueNote(note.urgency, strings.t(note.headlineKey), strings.t(note.bodyKey))
  }

  function enqueueNote(urgency, headline, description) {
    pendingNotes = pendingNotes.concat([{
      urgency: urgency,
      headline: Model.plainText(headline, 80),
      description: Model.plainText(description, 180)
    }])
    pumpNotes()
  }

  function pumpNotes() {
    if (noteProc.running || pendingNotes.length === 0) return
    var next = pendingNotes[0]
    pendingNotes = pendingNotes.slice(1)
    noteProc.command = [
      "omarchy-notification-send",
      "-u", next.urgency,
      "--app-name", "LibreNMS",
      next.headline,
      next.description
    ]
    noteProc.running = true
  }

  function saveFromField() {
    var content = panel.loadedContent
    if (!content) return
    var base = Model.normalizeBase(content.urlField.text)
    if (!base.ok) {
      formError = base.error
      return
    }
    if (!Model.validToken(content.tokenField.text)) {
      formError = "token"
      return
    }
    formError = ""
    saveProc.payload = JSON.stringify({ url: base.url, token: content.tokenField.text })
    saveProc.command = [saveScript]
    saveProc.running = true
  }

  function openDevice(id) {
    var page = Model.devicePageUrl(baseUrl, id)
    if (!page || openProc.running) return
    openProc.command = ["omarchy-launch-browser", page]
    openProc.running = true
  }

  readonly property string fetchScript: Qt.resolvedUrl("bin/fetch").toString().replace(/^file:\/\//, "")
  readonly property string saveScript: Qt.resolvedUrl("bin/save-secret").toString().replace(/^file:\/\//, "")

  FileView {
    id: secretFile
    path: Quickshell.env("HOME") + "/.config/omarchy/plugins/mvolz.librenms/secret.json"
    watchChanges: true
    printErrors: false
    blockLoading: true
  }

  Timer {
    interval: root.refreshIntervalMs
    repeat: true
    running: root.refreshEnabled && root.configured
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: fetchProc.body = text
    }
    property string body: ""
    onExited: function(exitCode) {
      var body = fetchProc.body
      fetchProc.body = ""
      root.applyFetch(exitCode, body)
    }
  }

  Process {
    id: saveProc
    stdinEnabled: true
    property string payload: ""
    onStarted: {
      var payload = saveProc.payload
      saveProc.payload = ""
      write(payload + "\n")
    }
    onExited: function(exitCode) {
      var content = panel.loadedContent
      if (exitCode !== 0) {
        root.formError = "save"
        return
      }
      root.formError = ""
      root.editing = false
      root.secretRevision += 1
      if (content) content.tokenField.text = ""
      root.refresh()
    }
  }

  Process { id: noteProc; onExited: root.pumpNotes() }
  Process { id: openProc }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.iconServer
    labelText: root.barCount
    slotSize: root.barSlot
    active: root.downCount > 0
    opacity: root.configured ? 1 : 0.55
    tooltipText: strings.t("bar.tooltip")

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else if (b === Qt.LeftButton) root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: PanelKeyCatcher {
      id: catcher
      property alias urlField: urlField
      property alias tokenField: tokenField
      anchors.fill: parent
      implicitHeight: body.implicitHeight
      blocked: urlField.activeFocus || tokenField.activeFocus
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.refresh()
      }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: body.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: body
          width: catcher.width
          spacing: Style.space(10)

          PlainText {
            width: parent.width
            text: strings.t("panel.title")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          PlainText {
            width: parent.width
            wrapMode: Text.WordWrap
            text: strings.t("panel.blurb")
            color: Qt.darker(root.foreground, 1.45)
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          PlainText {
            width: parent.width
            visible: root.configured && !root.editing
            elide: Text.ElideRight
            text: strings.t("panel.server").arg(root.baseUrl)
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          Button {
            visible: root.configured && !root.editing
            text: strings.t("panel.change")
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: {
              root.editing = true
              var content = panel.loadedContent
              if (content) content.urlField.text = root.baseUrl
            }
          }

          Column {
            width: parent.width
            visible: !root.configured || root.editing
            spacing: Style.space(8)

            PlainText {
              width: parent.width
              visible: !root.configured
              wrapMode: Text.WordWrap
              text: strings.t("panel.unconfigured")
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            TextField {
              id: urlField
              width: parent.width
              placeholderText: strings.t("panel.url")
              foreground: root.foreground
              font.family: root.fontFamily
              onTextChanged: root.formError = ""
              onAccepted: tokenField.forceActiveFocus()
            }

            TextField {
              id: tokenField
              width: parent.width
              password: true
              placeholderText: strings.t("panel.token")
              foreground: root.foreground
              font.family: root.fontFamily
              onTextChanged: root.formError = ""
              onAccepted: root.saveFromField()
            }

            Button {
              text: strings.t("panel.save")
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.saveFromField()
            }
          }

          PlainText {
            width: parent.width
            visible: text !== ""
            wrapMode: Text.WordWrap
            text: root.formErrorText()
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Toggle {
            width: parent.width
            label: strings.t("panel.refresh")
            description: strings.t("panel.refreshHelp")
            checked: root.refreshEnabled
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.persistSettings({ refreshEnabled: !root.refreshEnabled })
          }

          Toggle {
            width: parent.width
            label: strings.t("panel.notify")
            description: strings.t("panel.notifyHelp")
            checked: root.notifyEnabled
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.persistSettings({ notifyEnabled: !root.notifyEnabled })
          }

          PlainText {
            width: parent.width
            visible: root.configured && root.checking && root.devices.length === 0 && root.lastError === ""
            text: strings.t("panel.checking")
            color: Qt.darker(root.foreground, 1.45)
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          PlainText {
            width: parent.width
            visible: root.configured && root.lastError !== ""
            wrapMode: Text.WordWrap
            text: root.knownError(root.lastError)
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          PlainText {
            width: parent.width
            visible: root.configured && !root.checking && root.lastError === "" && root.devices.length === 0 && root.haveBaseline
            wrapMode: Text.WordWrap
            text: strings.t("panel.allOnline")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          PanelSectionHeader {
            visible: root.devices.length > 0
            width: parent.width
            text: strings.tn("panel.offline", root.devices.length).arg(Commons.I18n.formatNumber(root.devices.length))
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Repeater {
            model: root.devices

            delegate: Item {
              id: deviceRow
              required property var modelData
              readonly property var row: modelData
              readonly property string title: root.deviceName(row)
              width: parent.width
              implicitHeight: deviceText.implicitHeight + Style.space(8)

              Rectangle {
                anchors.fill: parent
                radius: Math.min(4, Style.cornerRadius)
                color: deviceMouse.containsMouse
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                  : "transparent"
              }

              Column {
                id: deviceText
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(4)
                anchors.rightMargin: Style.space(4)
                spacing: Style.space(2)

                PlainText {
                  width: parent.width
                  elide: Text.ElideRight
                  text: deviceRow.title
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                }

                PlainText {
                  width: parent.width
                  visible: deviceRow.row.hostname !== ""
                  elide: Text.ElideRight
                  text: deviceRow.row.hostname
                  color: Qt.darker(root.foreground, 1.45)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                PlainText {
                  width: parent.width
                  visible: deviceRow.row.location !== ""
                  elide: Text.ElideRight
                  text: deviceRow.row.location
                  color: Qt.darker(root.foreground, 1.45)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                PlainText {
                  width: parent.width
                  visible: deviceRow.row.reason !== ""
                  elide: Text.ElideRight
                  text: deviceRow.row.reason
                  color: root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              MouseArea {
                id: deviceMouse
                anchors.fill: parent
                hoverEnabled: true
                preventStealing: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.openDevice(deviceRow.row.id)
              }
            }
          }

          PlainText {
            width: parent.width
            visible: root.truncated
            wrapMode: Text.WordWrap
            text: strings.t("panel.truncated").arg(Commons.I18n.formatNumber(Model.maxDevices()))
            color: Qt.darker(root.foreground, 1.45)
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Button {
            visible: root.configured
            text: strings.t("panel.check")
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.refresh()
          }
        }
      }
    }
  }
}
