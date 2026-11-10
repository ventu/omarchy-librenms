"use strict"

const assert = require("assert")
const { execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const Model = require("../Model.js")

const tracker = '<img src="https://example.invalid/tracker">'
const root = path.resolve(__dirname, "..")
const fetchScript = path.join(root, "bin/fetch")
const saveScript = path.join(root, "bin/save-secret")

function testPlainText() {
  const out = Model.plainText(tracker + " sensor")
  assert.strictEqual(out.indexOf("<"), -1)
  assert.strictEqual(out.indexOf("example.invalid"), -1)
  assert.ok(out.indexOf("sensor") !== -1)

  const encoded = Model.plainText("&lt;img src=&quot;https://example.invalid/tracker&quot;&gt;")
  assert.strictEqual(encoded.indexOf("<"), -1)
  assert.strictEqual(encoded.indexOf("example.invalid"), -1)
}

function testBaseAndUrls() {
  assert.strictEqual(Model.normalizeBase("nms.example/librenms/").url, "https://nms.example/librenms")
  assert.strictEqual(Model.normalizeBase("https://User:pass@nms.example").ok, false)
  assert.strictEqual(Model.normalizeBase("javascript:alert(1)").ok, false)
  const base = "https://nms.example/librenms"
  assert.strictEqual(Model.devicesUrl(base), base + "/api/v0/devices?type=down")
  assert.strictEqual(Model.devicesUrl("https://nms.example/librenms/"), "")
  assert.strictEqual(Model.devicePageUrl(base, "42"), base + "/device/device=42/")
  assert.strictEqual(Model.devicePageUrl(base, "42;id"), "")
  assert.strictEqual(Model.devicePageUrl(base, tracker), "")
  assert.strictEqual(Model.validToken("abcd1234"), true)
  assert.strictEqual(Model.validToken("short"), false)
  assert.strictEqual(Model.validToken("abcd1234$(id)"), false)
}

function testParseDownList() {
  const raw = JSON.stringify({
    status: "ok",
    count: 4,
    devices: [
      {
        device_id: "7",
        hostname: "esp-" + tracker,
        sysName: "Shed sensor",
        location: { location: "Shed &amp; yard" },
        status: 0,
        status_reason: "icmp"
      },
      {
        device_id: "8",
        hostname: "up.example",
        sysName: "Fine",
        status: 1
      },
      {
        device_id: "9",
        hostname: "ignored.example",
        status: 0,
        ignore: "1"
      },
      {
        device_id: "nope",
        hostname: "bad-id.example",
        status: 0
      }
    ]
  })
  const parsed = Model.parseDownList(raw)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.devices.length, 1)
  assert.strictEqual(parsed.devices[0].id, "7")
  assert.strictEqual(parsed.devices[0].name, "Shed sensor")
  assert.strictEqual(parsed.devices[0].hostname.indexOf("<"), -1)
  assert.strictEqual(parsed.devices[0].hostname.indexOf("example.invalid"), -1)
  assert.strictEqual(parsed.devices[0].location, "Shed & yard")
  assert.strictEqual(parsed.devices[0].reason, "icmp")

  assert.strictEqual(Model.parseDownList("{").error, "error.parse")
  assert.strictEqual(Model.parseDownList(JSON.stringify({ status: "error" })).error, "error.api")
  assert.deepStrictEqual(Model.parseDownList(JSON.stringify({ status: "ok", count: 0 })).devices, [])
}

function testTransitionsStayQuietOnTheFirstPoll() {
  const down = [{ id: "7", name: "Shed sensor" }]
  const first = Model.transitions(null, down)
  assert.strictEqual(first.ready, false)
  assert.strictEqual(first.down.length, 0)

  const same = Model.transitions(first.baseline, down)
  assert.strictEqual(same.ready, true)
  assert.strictEqual(same.down.length, 0)
  assert.strictEqual(same.up.length, 0)

  const recovered = Model.transitions(same.baseline, [])
  assert.strictEqual(recovered.up.length, 1)
  assert.strictEqual(recovered.up[0].name, "Shed sensor")

  const again = Model.transitions(recovered.baseline, [{
    id: "3",
    name: Model.plainText(tracker)
  }])
  assert.strictEqual(again.down.length, 1)
  assert.strictEqual(again.down[0].name.indexOf("<"), -1)
}

function run(script, env, input) {
  try {
    execFileSync(script, {
      env: Object.assign({}, process.env, env),
      input: input,
      encoding: "utf8",
      timeout: 5000
    })
    return 0
  } catch (error) {
    return error.status
  }
}

function testFetchRefusesBadTargets() {
  const token = "abcd1234"
  const good = "https://nms.example/api/v0/devices?type=down"
  assert.strictEqual(run(fetchScript, { LIBRENMS_URL: "file:///etc/passwd", LIBRENMS_TOKEN: token }), 2)
  assert.strictEqual(run(fetchScript, { LIBRENMS_URL: "https://user:pass@nms.example/api/v0/devices?type=down", LIBRENMS_TOKEN: token }), 2)
  assert.strictEqual(run(fetchScript, { LIBRENMS_URL: good + "&x=1", LIBRENMS_TOKEN: token }), 2)
  assert.strictEqual(run(fetchScript, { LIBRENMS_URL: good, LIBRENMS_TOKEN: "abcd$(id)" }), 2)
  assert.strictEqual(run(fetchScript, { LIBRENMS_URL: good, LIBRENMS_TOKEN: "short" }), 2)
}

// A stand-in curl on PATH records its arguments and stdin, so the test can
// check where the token goes without a network.
function fakeCurl(dir, status) {
  const bin = path.join(dir, "fakebin")
  fs.mkdirSync(bin, { recursive: true })
  const shim = path.join(bin, "curl")
  fs.writeFileSync(shim, [
    "#!/bin/bash",
    'printf "%s\\n" "$@" > "$FAKE_DIR/args"',
    'cat > "$FAKE_DIR/stdin"',
    'printf \'{"devices":[]}\\n' + status + '\'',
  ].join("\n") + "\n")
  fs.chmodSync(shim, 0o755)
  return bin
}

function testFetchKeepsTokenOffCommandLine() {
  const token = "s3cretTokenValue123"
  const url = "https://nms.example/api/v0/devices?type=down"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librenms-fetch-"))
  const env = (bin) => ({ LIBRENMS_URL: url, LIBRENMS_TOKEN: token, FAKE_DIR: dir, PATH: bin + ":" + process.env.PATH })

  const ok = fakeCurl(dir, "200")
  assert.strictEqual(run(fetchScript, env(ok)), 0)
  const args = fs.readFileSync(path.join(dir, "args"), "utf8")
  const stdin = fs.readFileSync(path.join(dir, "stdin"), "utf8")
  assert.strictEqual(args.indexOf(token), -1, "token must not be a curl argument")
  assert.ok(stdin.indexOf("Authorization: Bearer " + token) !== -1)
  assert.ok(stdin.indexOf("X-Auth-Token: " + token) !== -1)
  assert.strictEqual(/^(--location|-L|--location-trusted)$/m.test(args), false, "redirects must not be followed")

  fs.rmSync(path.join(dir, "fakebin"), { recursive: true, force: true })
  assert.strictEqual(run(fetchScript, env(fakeCurl(dir, "302"))), 47)
  fs.rmSync(dir, { recursive: true, force: true })
}

function testSaveSecret() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librenms-"))
  fs.mkdirSync(path.join(dir, "bin"))
  const script = path.join(dir, "bin/save-secret")
  fs.copyFileSync(saveScript, script)
  fs.chmodSync(script, 0o755)
  const secret = path.join(dir, "secret.json")
  const body = JSON.stringify({ url: "https://nms.example/librenms", token: "abcd1234" })
  assert.strictEqual(run(script, {}, body + "\n"), 0)
  assert.strictEqual(fs.readFileSync(secret, "utf8").trim(), body)
  assert.strictEqual(fs.statSync(secret).mode & 0o077, 0)
  assert.strictEqual(run(script, {}, JSON.stringify({ url: "https://nms.example", token: "bad token" }) + "\n"), 2)
  assert.strictEqual(fs.readFileSync(secret, "utf8").trim(), body)
  fs.rmSync(dir, { recursive: true, force: true })
}

testPlainText()
testBaseAndUrls()
testParseDownList()
testTransitionsStayQuietOnTheFirstPoll()
testFetchRefusesBadTargets()
testFetchKeepsTokenOffCommandLine()
testSaveSecret()
console.log("librenms model tests passed")
