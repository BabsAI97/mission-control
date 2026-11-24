/* Mission Control service worker: cache-first app shell, updated ONLY from a release the Mac signed.
   The page checks the Mac's signature (release/Mac); this worker checks every file's SHA-256 against that manifest and swaps the cache all-or-nothing.
   First install is trust-on-first-use (release.json from the host). Never touches the relay (it is another origin). */
var CORE = ["index.html", "app.js", "sw.js"]; // every release must list these
var META = "mc-meta", PREFIX = "mc-shell-";
function pathOk(p) { return typeof p === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && p.split("/").every(function (s) { return s !== "." && s !== ".."; }); }
/** "" when r = { v, files } is a well-formed release, else the reason. */
function releaseProblem(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not an object";
  if (typeof r.v !== "number" || r.v !== Math.floor(r.v) || r.v < 1 || r.v > 2147483647) return "bad v";
  if (!r.files || typeof r.files !== "object" || Array.isArray(r.files)) return "no files";
  var ks = Object.keys(r.files);
  if (ks.length < CORE.length || ks.length > 200) return "bad file count";
  for (var i = 0; i < ks.length; i++) {
    if (!pathOk(ks[i]) || ks[i] === "release.json") return "bad path";
    if (typeof r.files[ks[i]] !== "string" || !/^[0-9a-f]{64}$/.test(r.files[ks[i]])) return "bad hash";
  }
  for (var j = 0; j < CORE.length; j++) if (!Object.prototype.hasOwnProperty.call(r.files, CORE[j])) return "missing " + CORE[j];
  return "";
}
/**
 * env: { caches, fetch, scopeUrl (ends with "/"), digest(bytes) -> Promise<ArrayBuffer> }. Returns the pieces the event handlers (and the tests) use.
 */
function createWorker(env) {
  var scope = env.scopeUrl, busy = Promise.resolve();
  function url(p) { return new URL(p, scope).href; }
  async function sha(buf) { return Array.prototype.map.call(new Uint8Array(await env.digest(buf)), function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join(""); }
  async function currentName() { var m = await env.caches.open(META), r = await m.match(url("__current")); return r ? await r.text() : ""; }
  async function cachedRelease() {
    var n = await currentName(); if (!n) return null;
    var c = await env.caches.open(n), r = await c.match(url("release.json"));
    if (!r) return null;
    try { var j = JSON.parse(await r.text()); return releaseProblem(j) ? null : j; } catch (e) { return null; }
  }
  async function getBytes(path) {
    var res = await env.fetch(url(path), { cache: "no-store", redirect: "error" });
    if (!res || !res.ok) throw new Error("fetch failed: " + path);
    return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") || "" };
  }
  /** Fetch every listed file fresh, check each hash, and only then make the new cache the current one. Throws (keeping the old cache) on any mismatch. */
  async function stage(rel) {
    var name = PREFIX + rel.v;
    await env.caches.delete(name);
    var paths = Object.keys(rel.files).sort(), got = {};
    try {
      await Promise.all(paths.map(async function (p) {
        var f = await getBytes(p);
        if ((await sha(f.bytes)) !== rel.files[p]) throw new Error("mismatch: " + p);
        got[p] = f;
      }));
      var c = await env.caches.open(name);
      var res = function (f) { return new Response(f.bytes, { status: 200, headers: { "content-type": f.type } }); };
      for (var i = 0; i < paths.length; i++) await c.put(url(paths[i]), res(got[paths[i]]));
      await c.put(scope, res(got["index.html"]));
      await c.put(url("release.json"), new Response(JSON.stringify({ v: rel.v, files: rel.files }), { status: 200, headers: { "content-type": "application/json" } }));
    } catch (e) { await env.caches.delete(name); throw e; }
    var m = await env.caches.open(META);
    await m.put(url("__current"), new Response(name)); // the one atomic step: everything above was only staging
    var ks = await env.caches.keys();
    await Promise.all(ks.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== name; }).map(function (k) { return env.caches.delete(k); }));
  }
  /** Install: resolves = take over now. Rejects = this worker is refused and the old one keeps serving. */
  async function install() {
    var cur = await cachedRelease(), own = await sha((await getBytes("sw.js")).bytes);
    if (cur) { // a verified version is already installed: a changed sw.js must be in a release the Mac signed (and the page already swapped to)
      if (cur.files["sw.js"] !== own) throw new Error("sw.js is not in a verified release");
      return true;
    }
    var rel = JSON.parse(new TextDecoder().decode((await getBytes("release.json")).bytes)); // first install: trust on first use
    var why = releaseProblem(rel);
    if (why) throw new Error("release.json: " + why);
    if (rel.files["sw.js"] !== own) throw new Error("sw.js does not match release.json");
    await stage(rel);
    return true;
  }
  /** Cache-first for files inside this scope. Returns a Promise<Response>, or null when the browser should handle the request itself. */
  function handleFetch(req) {
    if (!req || req.method !== "GET") return null;
    var u; try { u = new URL(req.url); } catch (e) { return null; }
    if (u.href.indexOf(scope) !== 0) return null; // other origins (the relay) and other paths: untouched
    return (async function () {
      var n = await currentName();
      if (!n) return env.fetch(req);
      var c = await env.caches.open(n), hit = await c.match(u.origin + u.pathname);
      if (!hit && req.mode === "navigate") hit = await c.match(scope);
      return hit || Response.error(); // not in the verified release: not served
    })();
  }
  /** The page hands over a release whose Mac signature IT verified. Resolves { ok, v } or { ok:false, reason }. One at a time. */
  function applyRelease(rel) {
    var p = busy.then(async function () {
      if (releaseProblem(rel)) return { ok: false, reason: "shape" };
      var cur = await cachedRelease();
      if (cur && rel.v <= cur.v) return { ok: false, reason: "old", v: cur.v };
      try { await stage({ v: rel.v, files: rel.files }); return { ok: true, v: rel.v }; }
      catch (e) { return { ok: false, reason: /^mismatch/.test(String(e && e.message)) ? "mismatch" : "fetch" }; }
    });
    busy = p.catch(function () {});
    return p;
  }
  async function activate() {
    var n = await currentName(), ks = await env.caches.keys();
    await Promise.all(ks.filter(function (k) { return k !== META && k !== n; }).map(function (k) { return env.caches.delete(k); }));
  }
  return { install: install, activate: activate, handleFetch: handleFetch, applyRelease: applyRelease, currentName: currentName, cachedRelease: cachedRelease };
}
/* ---------- push (refocus 4g/5d). The browser decrypts the payload; nothing here is a trust decision, it only decides what the alert says. ---------- */
var OFFLINE_TEXT = "Mission Control: Mac offline", PREFS_KEY = "__prefs";
function oneLine(v, n) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n); }
/** What a push shows. An empty payload is the relay's offline alert (fixed text). A decision shows the title and body exactly as the Mac sent them (control characters out, length capped); whether to send detail is decided on the Mac by the "hide details" setting. */
function pushView(raw) {
  var text = typeof raw === "string" ? raw : "", p = null;
  if (!text) return { title: OFFLINE_TEXT, body: "", id: "", badge: null, tag: "mc-offline" };
  try { p = JSON.parse(text); } catch (e) { p = null; }
  if (!p || typeof p !== "object" || p.t !== "decision") return { title: "Mission Control", body: "Open Mission Control", id: "", badge: null, tag: "mc" };
  var id = /^[0-9a-f]{32}$/.test(String(p.id)) ? p.id : "", b = Math.floor(Number(p.badge)), title = oneLine(p.title, 100);
  return { title: title || "A decision needs you", body: oneLine(p.body, 180) || "Open Mission Control", id: id, badge: isFinite(b) && b >= 0 ? Math.min(b, 99) : null, tag: id ? "mc-" + id : "mc" };
}
async function loadPrefs(caches, scope) {
  try { var m = await caches.open(META), r = await m.match(new URL(PREFS_KEY, scope).href); return r ? JSON.parse(await r.text()) === true : false; } catch (e) { return false; }
}
async function savePrefs(caches, scope, hideDetail) {
  var m = await caches.open(META); await m.put(new URL(PREFS_KEY, scope).href, new Response(JSON.stringify(hideDetail === true)));
}
/** Where a tapped alert goes: an open window of this app (told which decision) or a new one at #d=<id>. */
async function openFromAlert(clientsApi, scope, id) {
  var list = await clientsApi.matchAll({ type: "window", includeUncontrolled: true }), clean = /^[0-9a-f]{32}$/.test(String(id)) ? id : "";
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].url).indexOf(scope) !== 0) continue;
    try { await list[i].focus(); } catch (e) {}
    if (clean) list[i].postMessage({ type: "open-decision", id: clean });
    return "focused";
  }
  await clientsApi.openWindow(scope + (clean ? "#d=" + clean : ""));
  return "opened";
}
if (typeof self !== "undefined" && self.addEventListener && typeof self.skipWaiting === "function") {
  var W = createWorker({ caches: self.caches, fetch: function (r, o) { return self.fetch(r, o); }, scopeUrl: self.registration.scope, digest: function (b) { return crypto.subtle.digest("SHA-256", b); } });
  self.addEventListener("install", function (e) { e.waitUntil(W.install().then(function () { return self.skipWaiting(); })); });
  self.addEventListener("activate", function (e) { e.waitUntil(W.activate().then(function () { return self.clients.claim(); })); });
  self.addEventListener("fetch", function (e) { var p = W.handleFetch(e.request); if (p) e.respondWith(p); });
  self.addEventListener("message", function (e) {
    var d = e.data, src = e.source;
    if (!src || !d || typeof d !== "object") return; // only a page of this origin has a source
    if (d.type === "status") e.waitUntil(W.cachedRelease().then(function (r) { src.postMessage({ type: "status", v: r ? r.v : 0 }); }));
    if (d.type === "push-prefs") e.waitUntil(savePrefs(self.caches, self.registration.scope, d.hideDetail === true));
    if (d.type === "apply-release") e.waitUntil(W.applyRelease(d.release).then(function (r) { src.postMessage({ type: "release-result", ok: r.ok, v: r.v, reason: r.reason || "" }); }));
  });
  self.addEventListener("push", function (e) {
    e.waitUntil((async function () {
      var raw = ""; try { raw = e.data ? await e.data.text() : ""; } catch (x) {}
      var v = pushView(raw);
      try { if (v.badge !== null && self.navigator) { if (v.badge > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(v.badge); else if (v.badge === 0 && self.navigator.clearAppBadge) await self.navigator.clearAppBadge(); } } catch (x) {}
      await self.registration.showNotification(v.title, { body: v.body, tag: v.tag, data: { id: v.id } });
    })());
  });
  self.addEventListener("notificationclick", function (e) {
    e.notification.close();
    e.waitUntil(openFromAlert(self.clients, self.registration.scope, e.notification.data && e.notification.data.id));
  });
}
if (typeof module === "object" && module.exports) module.exports = { pushView: pushView, loadPrefs: loadPrefs, savePrefs: savePrefs, openFromAlert: openFromAlert, OFFLINE_TEXT: OFFLINE_TEXT, createWorker: createWorker, releaseProblem: releaseProblem, pathOk: pathOk, CORE: CORE, PREFIX: PREFIX };
