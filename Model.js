// LibreNMS down-list parsing. The panel is the only place that talks to the
// network. Names that come back from the server are somebody else's strings,
// so plainText strips tags before anything is shown or put in a notification.

var MAX_DEVICES = 200
var MAX_NAME = 80
var MAX_FIELD = 60

function trim(value) {
  return String(value == null ? "" : value).replace(/^\s+|\s+$/g, "")
}

function codePointToString(codePoint) {
  if (!isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return ""
  if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return ""
  if (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) return ""
  if (typeof String.fromCodePoint === "function") return String.fromCodePoint(codePoint)
  return ""
}

function decodeEntities(input) {
  var text = String(input || "")
  for (var pass = 0; pass < 3; pass++) {
    text = text.replace(/&#x([0-9a-fA-F]{1,6});/g, function(_, hex) {
      return codePointToString(parseInt(hex, 16))
    })
    text = text.replace(/&#([0-9]{1,7});/g, function(_, dec) {
      return codePointToString(parseInt(dec, 10))
    })
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
  }
  return text
}

function stripBlocks(input) {
  return String(input || "")
    .replace(/<script\b[^>]*>[\s\S]*?(<\/script>|$)/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?(<\/style>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
}

function plainText(raw, limit) {
  var text = stripBlocks(decodeEntities(raw))
  text = stripBlocks(decodeEntities(text))
  text = text.replace(/</g, "\uFF1C")
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  text = trim(text.replace(/\s+/g, " "))
  var cap = typeof limit === "number" && limit > 0 ? limit : 200
  if (text.length > cap) text = trim(text.slice(0, cap))
  return text
}

function validToken(token) {
  var text = String(token || "")
  return text.length >= 8 && text.length <= 200 && /^[A-Za-z0-9._~+/-]+$/.test(text)
}

// The browser address of the LibreNMS install, without a query or a login
// embedded in the URL. The token travels in a header, never in this string.
function normalizeBase(raw) {
  var text = trim(raw)
  if (!text) return { ok: false, error: "empty" }
  if (text.length > 300) return { ok: false, error: "long" }
  if (/[\u0000-\u0020<>"'`\\@]/.test(text)) return { ok: false, error: "chars" }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text
  var match = text.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i)
  if (!match) return { ok: false, error: "scheme" }
  var scheme = match[1].toLowerCase()
  var host = match[2]
  var path = match[3] || ""
  if (host.charAt(0) === "[") return { ok: false, error: "host" }
  var port = ""
  var colon = host.lastIndexOf(":")
  if (colon !== -1) {
    port = host.slice(colon + 1)
    host = host.slice(0, colon)
    if (!/^\d+$/.test(port)) return { ok: false, error: "port" }
    var portNumber = parseInt(port, 10)
    if (portNumber < 1 || portNumber > 65535) return { ok: false, error: "port" }
    port = String(portNumber)
  }
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host) || host.indexOf("..") !== -1)
    return { ok: false, error: "host" }
  if (path && !/^[A-Za-z0-9._~!$&()*+,;=:@/%-]*$/.test(path)) return { ok: false, error: "path" }
  path = path.replace(/\/+$/, "")
  var url = scheme + "://" + host.toLowerCase() + (port ? ":" + port : "") + path
  if (url.length > 300) return { ok: false, error: "long" }
  return { ok: true, url: url }
}

function devicesUrl(base) {
  var normalized = normalizeBase(base)
  if (!normalized.ok || normalized.url !== base) return ""
  return base + "/api/v0/devices?type=down"
}

function devicePageUrl(base, id) {
  if (!devicesUrl(base)) return ""
  var device = String(id || "")
  if (!/^[0-9]{1,12}$/.test(device)) return ""
  return base + "/device/device=" + device + "/"
}

function parseSecret(raw) {
  var empty = { url: "", token: "" }
  try {
    var data = JSON.parse(String(raw || ""))
    if (!data || typeof data !== "object") return empty
    var base = normalizeBase(data.url)
    if (!base.ok || !validToken(data.token)) return empty
    return { url: base.url, token: String(data.token) }
  } catch (e) {
    return empty
  }
}

function locationText(value) {
  if (!value) return ""
  if (typeof value === "string") return plainText(value, MAX_FIELD)
  if (typeof value === "object") {
    if (typeof value.location === "string") return plainText(value.location, MAX_FIELD)
    if (typeof value.name === "string") return plainText(value.name, MAX_FIELD)
  }
  return ""
}

function flag(value) {
  return value === 1 || value === "1" || value === true
}

function parseDownList(raw) {
  var text = String(raw || "")
  if (text.length > 1500000) return { ok: false, error: "error.large", devices: [] }
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: "error.parse", devices: [] }
  }
  if (!data || typeof data !== "object" || data.status !== "ok")
    return { ok: false, error: "error.api", devices: [] }
  var list = data.devices
  if (!list && Number(data.count) === 0) list = []
  if (!Array.isArray(list)) return { ok: false, error: "error.api", devices: [] }

  var devices = []
  var truncated = list.length > MAX_DEVICES
  for (var i = 0; i < list.length && devices.length < MAX_DEVICES; i++) {
    var row = list[i]
    if (!row || typeof row !== "object") continue
    if (flag(row.disabled) || flag(row.ignore)) continue
    if (!(row.status === 0 || row.status === "0")) continue
    var id = String(row.device_id == null ? "" : row.device_id)
    if (!/^[0-9]{1,12}$/.test(id)) continue
    var hostname = plainText(row.hostname, MAX_NAME)
    var sysName = plainText(row.sysName || row.display, MAX_NAME)
    var name = sysName || hostname
    devices.push({
      id: id,
      name: name,
      hostname: hostname && hostname !== name ? hostname : "",
      location: locationText(row.location),
      reason: plainText(row.status_reason, 32)
    })
  }
  devices.sort(function(a, b) {
    var left = (a.name || a.hostname || a.id).toLowerCase()
    var right = (b.name || b.hostname || b.id).toLowerCase()
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
  return { ok: true, error: "", devices: devices, truncated: truncated }
}

// previous is null on the first successful poll. That poll draws the menu
// and stays quiet, so devices that were already down do not each raise a
// notification when the bar starts.
function transitions(previous, devices) {
  var list = devices || []
  var baseline = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    var id = list[i].id
    if (!id || seen[id]) continue
    seen[id] = true
    baseline.push({ id: id, name: list[i].name || id })
  }
  if (!previous) return { ready: false, down: [], up: [], baseline: baseline }

  var prior = {}
  var priorList = previous || []
  for (var p = 0; p < priorList.length; p++) prior[priorList[p].id] = priorList[p]

  var down = []
  for (var d = 0; d < baseline.length; d++) {
    if (!prior[baseline[d].id]) down.push(baseline[d])
  }
  var up = []
  for (var u = 0; u < priorList.length; u++) {
    if (!seen[priorList[u].id]) up.push({ id: priorList[u].id, name: priorList[u].name || priorList[u].id })
  }
  return { ready: true, down: down, up: up, baseline: baseline }
}

function maxDevices() { return MAX_DEVICES }

function failureKey(exitCode) {
  var code = Number(exitCode)
  if (code === 6) return "error.resolve"
  if (code === 7) return "error.connect"
  if (code === 22) return "error.auth"
  if (code === 28) return "error.timeout"
  if (code === 35 || code === 51 || code === 60) return "error.tls"
  if (code === 63) return "error.large"
  return "error.failed"
}

if (typeof exports !== "undefined") {
  exports.plainText = plainText
  exports.validToken = validToken
  exports.normalizeBase = normalizeBase
  exports.devicesUrl = devicesUrl
  exports.devicePageUrl = devicePageUrl
  exports.parseSecret = parseSecret
  exports.parseDownList = parseDownList
  exports.transitions = transitions
  exports.failureKey = failureKey
  exports.maxDevices = maxDevices
}
