/* Mission Control relay client: end-to-end encryption (PROTOCOL.md section 2) and the db shim over the device WebSocket (sections 4 and 8).
   Loaded as a plain script (window.MCRelay) and imported by the node tests (module.exports). No dependencies; WebCrypto only. */
(function (root, factory) {
  var m = factory();
  if (typeof module === "object" && module.exports) module.exports = m; else root.MCRelay = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var te = new TextEncoder(), td = new TextDecoder("utf-8", { fatal: true });
  function subtle() { return globalThis.crypto.subtle; }

  /* ---------- base64url ---------- */
  function b64u(buf) {
    var a = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = "";
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function ub(t) { // padding-safe decode
    if (typeof t !== "string" || !/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) throw new Error("bad base64url");
    var p = t.replace(/-/g, "+").replace(/_/g, "/"); while (p.length % 4) p += "=";
    var s = atob(p), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }

  /* ---------- section 2: bodies ---------- */
  function aadFor(col, id) { return "mc1|" + col + "/" + id; }
  /** doc -> { enc: 1, iv, ct }. K is an AES-GCM CryptoKey (usage "encrypt"). `iv` is for the test vectors only; real use draws 12 random bytes. */
  async function encryptDoc(K, col, id, doc, iv) {
    var v = iv || globalThis.crypto.getRandomValues(new Uint8Array(12));
    var ct = await subtle().encrypt({ name: "AES-GCM", iv: v, additionalData: te.encode(aadFor(col, id)) }, K, te.encode(JSON.stringify(doc)));
    return { enc: 1, iv: b64u(v), ct: b64u(ct) };
  }
  /** body -> the plaintext JSON TEXT, or null when anything is wrong (a body that fails to decrypt is absent). */
  async function decryptBodyText(K, col, id, body) {
    try {
      if (typeof body === "string") body = JSON.parse(body);
      if (!K || !body || typeof body !== "object" || body.enc !== 1 || typeof body.iv !== "string" || typeof body.ct !== "string") return null;
      var iv = ub(body.iv); if (iv.length !== 12) return null;
      var pt = await subtle().decrypt({ name: "AES-GCM", iv: iv, additionalData: te.encode(aadFor(col, id)) }, K, ub(body.ct));
      var text = td.decode(pt); JSON.parse(text); return text;
    } catch (e) { return null; }
  }
  async function decryptDoc(K, col, id, body) {
    var t = await decryptBodyText(K, col, id, body);
    return t === null ? null : JSON.parse(t);
  }

  /* ---------- section 2: key handling (device side) ---------- */
  function pubJwk(j) { return { kty: j.kty, crv: j.crv, x: j.x, y: j.y }; }
  function okPubJwk(j) { return !!j && typeof j === "object" && j.kty === "EC" && j.crv === "P-256" && typeof j.x === "string" && typeof j.y === "string" && j.x.length === 43 && j.y.length === 43; }
  /** The device's ECDH P-256 pair: the private key is NON-extractable (deriveBits only). */
  async function makeDhKey() {
    var kp = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    if (kp.privateKey.extractable !== false) throw new Error("extractable");
    return { priv: kp.privateKey, pub: kp.publicKey, jwk: pubJwk(await subtle().exportKey("jwk", kp.publicKey)) };
  }
  /** x-coordinate of ECDH(device priv, Mac public key): 32 bytes. */
  async function ecdhZ(dhPriv, macDhPub) {
    if (!okPubJwk(macDhPub)) throw new Error("bad macDhKey");
    var pub = await subtle().importKey("jwk", pubJwk(macDhPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
    return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, dhPriv, 256));
  }
  /** HKDF-SHA256(ikm Z, salt UTF-8 deviceId, info "mc-relay-k1", 32 bytes) -> raw bytes. */
  async function hkdfWrapBits(Z, deviceId) {
    var hk = await subtle().importKey("raw", Z, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: te.encode(String(deviceId)), info: te.encode("mc-relay-k1") }, hk, 256));
  }
  /** Z -> HKDF -> a non-extractable AES-GCM CryptoKey that can only unwrap. */
  async function deriveWrapKey(dhPriv, macDhPub, deviceId) {
    var raw = await hkdfWrapBits(await ecdhZ(dhPriv, macDhPub), deviceId);
    return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["unwrapKey"]);
  }
  /** wrappedKey = b64u(iv(12) || AES-GCM(wrapKey, K, AAD "mc1|wrap|" + deviceId)). Returns K as a NON-extractable AES-GCM key. */
  async function unwrapSpaceKey(wrapKey, wrappedKey, deviceId) {
    var raw = ub(wrappedKey);
    if (raw.length !== 12 + 32 + 16) throw new Error("bad wrappedKey");
    return subtle().unwrapKey("raw", raw.slice(12), wrapKey, { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: te.encode("mc1|wrap|" + deviceId) }, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  /** The whole device step: Mac's DH key + wrappedKey -> K. */
  async function openSpaceKey(dhPriv, macDhPub, wrappedKey, deviceId) {
    return unwrapSpaceKey(await deriveWrapKey(dhPriv, macDhPub, deviceId), wrappedKey, deviceId);
  }
  /** r2 pairing gate (H1): b64u(HMAC-SHA256(key = normalised code ASCII, msg = "mc-relay-gate-v1")). `code` must already be normalised (the same form the pairing mac uses). The code itself is never sent. */
  async function gateFor(code) {
    if (typeof code !== "string" || !/^[0-9A-Z]{16}$/.test(code)) throw new Error("bad code");
    var k = await subtle().importKey("raw", te.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64u(await subtle().sign("HMAC", k, te.encode("mc-relay-gate-v1")));
  }
  /** WebSocket auth proof: ECDSA P-256 SHA-256 (raw r||s, b64u) over "mc-relay-auth:" + challenge. */
  async function signAuth(priv, challenge) {
    return b64u(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, priv, te.encode("mc-relay-auth:" + challenge)));
  }

  /* ---------- section 8: the db shim ---------- */
  var ID_REQ = /^[A-Za-z0-9_-]{8,64}$/, MAX_SUBS = 30, LIMIT = 200;
  function noop() {}
  /** A put whose ack never came: the write may or may not have landed on the relay. `lost` tells the app not to call it a failure. */
  function lostErr(msg) { var e = new Error(msg); e.lost = true; return e; }

  /**
   * opts: { WebSocket, url, getAuth() -> Promise<{ deviceId, priv, K, gate, pairMachine }>, onState(state, role), setTimeout, clearTimeout, setInterval, clearInterval, now, graceMs }
   * state: "connecting" | "ready" | "offline" | "denied" | "idle" | "gate". role: "device" | "pairing" | "".
   * r2: with no device credentials and no pairing gate there is NO socket at all ("idle"). A pairing socket opens only with { t:"auth", pairing:true, gate };
   * if the relay closes it 4401 (wrong, expired or unpublished gate; or its 5 minutes are up) the state is "gate" and nothing retries: a new code needs a new gate.
   * Surface used by index: doc(path).onSnapshot(cb, err), doc(path).set(data), collection("requests").orderBy("createdAt","desc").limit(200).onSnapshot(cb, err).
   */
  function createDb(opts) {
    var WS = opts.WebSocket, setT = opts.setTimeout || setTimeout, clrT = opts.clearTimeout || clearTimeout;
    var setI = opts.setInterval || setInterval, clrI = opts.clearInterval || clearInterval, now = opts.now || Date.now;
    var graceMs = opts.graceMs == null ? 1200 : opts.graceMs, probeMs = opts.probeMs == null ? 3000 : opts.probeMs;
    var url = opts.url || (typeof globalThis.RELAY_URL === "string" && globalThis.RELAY_URL) || (function () { var l = globalThis.location; return (l.protocol === "https:" ? "wss:" : "ws:") + "//" + l.host + "/v1/ws"; })();
    var subs = Object.create(null);   // "col/id" or "requests/*" -> { listeners: [{cb, err}], seen: bool }
    var docs = Object.create(null);   // "col/id" -> JSON text, or null (absent)
    var reqs = Object.create(null);   // request id -> { text, createdAt }
    var pending = Object.create(null), refSeq = 0;
    var ws = null, gen = 0, role = "", authMode = "", pairMachine = "", curK = null, state = "connecting", retry = 0, authFails = 0, stopped = false;
    var timer = null, pingT = null, probeT = null, rxN = 0, lastRx = 0, subT = null, emitT = null, graceT = null, readyWaiters = [];
    var db = { get state() { return state; }, get role() { return role; } };

    function setState(s) { if (s !== state) { state = s; (opts.onState || noop)(s, role); } }
    function wantedSubs() {
      var keys = Object.keys(subs);
      // the pairing role watches exactly one document, pair/<machine> (a concrete id); release/Mac and everything else is for signed devices only
      if (role !== "device") keys = pairMachine && subs["pair/" + pairMachine] ? ["pair/" + pairMachine] : [];
      return keys.slice(0, MAX_SUBS);
    }
    function sendSubs() { subT = null; if (ws && state === "ready") try { ws.send(JSON.stringify({ t: "sub", subs: wantedSubs() })); } catch (e) {} }
    function schedSubs() { if (state === "ready" && !subT) subT = setT(sendSubs, 0); }

    function snapOf(key) {
      var t = docs[key];
      return { id: key.split("/").slice(1).join("/"), exists: t != null, data: function () { return t == null ? undefined : JSON.parse(t); } };
    }
    function reqSnap() {
      var list = Object.keys(reqs).map(function (id) { return { id: id, r: reqs[id] }; });
      list.sort(function (a, b) { return a.r.createdAt < b.r.createdAt ? 1 : a.r.createdAt > b.r.createdAt ? -1 : a.id < b.id ? 1 : -1; });
      var ds = list.slice(0, LIMIT).map(function (x) { return { id: x.id, exists: true, data: function () { return JSON.parse(x.r.text); } }; });
      return { docs: ds, size: ds.length, empty: ds.length === 0 };
    }
    function fire(sub, snap) { sub.listeners.slice().forEach(function (l) { try { l.cb(snap); } catch (e) { try { (globalThis.console || {}).error("snapshot callback", e); } catch (x) {} } }); }
    function emit(key) {
      var s = subs[key]; if (!s) return;
      s.seen = true;
      if (key === "requests/*") { if (!emitT) emitT = setT(function () { emitT = null; var q = subs["requests/*"]; if (q) fire(q, reqSnap()); }, 20); return; }
      fire(s, snapOf(key));
    }
    /** After the subscription is sent, a doc that never arrives is reported once as absent (the relay sends nothing for a missing doc). */
    function armGrace() {
      clrT(graceT);
      graceT = setT(function () {
        Object.keys(subs).forEach(function (k) {
          var s = subs[k]; if (s.seen) return;
          if (role !== "device" && k !== "pair/" + pairMachine) return;
          s.seen = true; if (k === "requests/*") fire(s, reqSnap()); else fire(s, snapOf(k));
        });
      }, graceMs);
    }

    async function onSnap(m) {
      var col = String(m.col), id = String(m.id), key = col + "/" + id, g = gen;
      if (col === "requests") {
        if (m.gone) delete reqs[id];
        else {
          var text = await decryptBodyText(curK, col, id, m.body); if (g !== gen) return;
          if (text === null) delete reqs[id]; // fails to decrypt = absent
          else { var d = JSON.parse(text); reqs[id] = { text: text, createdAt: d && typeof d.createdAt === "string" ? d.createdAt : "" }; }
        }
        if (subs["requests/*"]) emit("requests/*");
        return;
      }
      if (!subs[key]) return;
      if (m.gone) docs[key] = null;
      else if (col === "pair") { // clear JSON by design (PROTOCOL section 2)
        var b = m.body; try { if (typeof b === "string") b = JSON.parse(b); } catch (e) { b = null; }
        docs[key] = b && typeof b === "object" && !Array.isArray(b) && !("enc" in b && b.enc === 1) ? JSON.stringify(b) : null;
      } else {
        var t2 = await decryptBodyText(curK, col, id, m.body); if (g !== gen) return;
        docs[key] = t2;
      }
      emit(key);
    }
    function onMessage(g, ev) {
      if (g !== gen) return;
      lastRx = now(); rxN++;
      var data = ev && ev.data; if (typeof data !== "string" || data === "pong") return;
      var m; try { m = JSON.parse(data); } catch (e) { return; }
      if (!m || typeof m !== "object") return;
      if (m.t === "hello") { doAuth(g, String(m.challenge || "")); }
      else if (m.t === "ready") {
        role = m.role === "device" ? "device" : "pairing"; retry = 0; authFails = 0; setState("ready");
        sendSubs(); armGrace();
        var w = readyWaiters; readyWaiters = []; w.forEach(function (f) { f(true); });
      }
      else if (m.t === "snap") onSnap(m);
      else if (m.t === "ack") { var p = pending[m.ref]; if (p) { delete pending[m.ref]; clrT(p.timer); if (m.ok) p.resolve(); else { var ae = new Error(String(m.error || "refused")); ae.ack = true; ae.exists = ae.message === "exists"; p.reject(ae); } } }
    }
    async function doAuth(g, challenge) {
      var a; try { a = await opts.getAuth(); } catch (e) { a = {}; }
      if (g !== gen || !ws) return;
      a = a || {}; curK = a.K || null; authMode = ""; pairMachine = "";
      try {
        if (a.K && a.priv && a.deviceId) { authMode = "device"; ws.send(JSON.stringify({ t: "auth", deviceId: a.deviceId, sig: await signAuth(a.priv, challenge) })); }
        else if (typeof a.gate === "string" && a.gate) { curK = null; authMode = "pairing"; pairMachine = /^[A-Za-z0-9_.:-]{1,80}$/.test(String(a.pairMachine || "")) ? String(a.pairMachine) : ""; ws.send(JSON.stringify({ t: "auth", pairing: true, gate: a.gate })); }
        else { curK = null; ws.close(); } // r2: no unauthenticated pairing socket, ever
      } catch (e) { try { ws.close(); } catch (x) {} }
    }
    function cleanup() {
      clrI(pingT); pingT = null; clrT(probeT); probeT = null; clrT(graceT); clrT(subT); subT = null;
      Object.keys(pending).forEach(function (r) { var p = pending[r]; delete pending[r]; clrT(p.timer); p.reject(lostErr("connection lost")); });
    }
    function schedule(ms) { clrT(timer); timer = setT(open, ms); }
    function hasCreds(a) { return !!a && ((!!a.K && !!a.priv && !!a.deviceId) || (typeof a.gate === "string" && !!a.gate)); }
    function open() {
      if (stopped) return;
      gen++; var g = gen; role = ""; authMode = ""; setState(state === "denied" ? "denied" : "connecting");
      var pre; try { pre = Promise.resolve(opts.getAuth()); } catch (e) { pre = Promise.resolve({}); }
      pre.then(function (a) { return a; }, function () { return {}; }).then(function (a) {
        if (g !== gen || stopped) return;
        if (!hasCreds(a)) { if (state !== "denied") setState("idle"); return; } // nothing to sign in with: stay disconnected
        connectNow(g);
      });
    }
    function connectNow(g) {
      var s;
      try { s = new WS(url); } catch (e) { setState(state === "denied" ? "denied" : "offline"); retry++; schedule(backoff()); return; }
      ws = s;
      s.onopen = function () { if (g !== gen) return; lastRx = now(); clrI(pingT); pingT = setI(function () { if (g !== gen) return; if (now() - lastRx > 75000) { try { s.close(); } catch (e) {} return; } try { s.send("ping"); } catch (e) {} }, 25000); };
      s.onmessage = function (ev) { onMessage(g, ev); };
      s.onerror = noop;
      s.onclose = function (ev) {
        if (g !== gen) return;
        var mode = authMode, code = ev && ev.code; cleanup(); ws = null; role = ""; authMode = "";
        if (code === 4401 && mode === "pairing") { // gate refused or the 5-minute socket is over: no retry loop
          setState("gate");
          var w = readyWaiters; readyWaiters = []; w.forEach(function (f) { f(false); });
          return;
        }
        if (code === 4401 && mode !== "pairing") { authFails++; if (authFails >= 2) setState("denied"); else setState("offline"); }
        else if (state !== "denied") setState("offline");
        var d = backoff(); retry++; schedule(d);
      };
    }
    function backoff() { return Math.min(30000, 1000 * Math.pow(2, retry)); }
    function whenReady(ms) {
      if (state === "ready" && ws) return Promise.resolve(true);
      return new Promise(function (res) { var done = false, t = setT(function () { if (!done) { done = true; res(false); } }, ms); readyWaiters.push(function (ok) { if (!done) { done = true; clrT(t); res(ok); } }); });
    }

    db.reconnect = function () { // after pairing or "pair again": drop the socket and sign in again with the new keys
      clrT(timer); retry = 0; authFails = 0; if (state === "denied") state = "connecting";
      var old = ws; gen++; cleanup(); ws = null; role = ""; if (old) { old.onclose = old.onmessage = old.onopen = null; try { old.close(1000); } catch (e) {} }
      open();
    };
    /** Back in the foreground / network back: make sure the socket is alive. No socket, or a closed one: reconnect and re-subscribe at once. An open one is probed with a ping; no reply of any kind within probeMs = dead, reconnect. A "gate" refusal is never retried. */
    db.wake = function () {
      if (stopped || state === "gate") return;
      var s = ws;
      if (!s || s.readyState === 2 || s.readyState === 3) { clrT(timer); retry = 0; open(); return; }
      if (s.readyState !== 1 || state !== "ready" || probeT) return; // still connecting, or already probing
      var n = rxN;
      try { s.send("ping"); } catch (e) { db.reconnect(); return; }
      probeT = setT(function () { probeT = null; if (ws === s && rxN === n) db.reconnect(); }, probeMs);
    };
    db.stop = function () { stopped = true; clrT(timer); gen++; cleanup(); var o = ws; ws = null; if (o) { o.onclose = null; try { o.close(1000); } catch (e) {} } };

    function sub(key, cb, err) {
      var s = subs[key] || (subs[key] = { listeners: [], seen: false }), l = { cb: cb, err: err };
      s.listeners.push(l);
      if (key === "requests/*") { if (s.seen) setT(function () { if (subs[key] === s && s.listeners.indexOf(l) >= 0) { try { cb(reqSnap()); } catch (e) {} } }, 0); }
      else if (s.seen) setT(function () { if (subs[key] === s && s.listeners.indexOf(l) >= 0) { try { cb(snapOf(key)); } catch (e) {} } }, 0);
      schedSubs(); if (state === "ready") armGrace();
      return function () {
        var i = s.listeners.indexOf(l); if (i >= 0) s.listeners.splice(i, 1);
        if (!s.listeners.length && subs[key] === s) { delete subs[key]; schedSubs(); }
      };
    }
    db.doc = function (path) {
      var m = /^([a-z]+)\/([A-Za-z0-9_.:-]{1,80})$/.exec(String(path));
      if (!m) throw new Error("bad path");
      return {
        onSnapshot: function (cb, err) { return sub(path, cb, err || noop); },
        set: async function (data) {
          if (m[1] !== "requests" || !ID_REQ.test(m[2])) throw new Error("not allowed");
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad body");
          if (state === "gate") throw new Error("bad gate");
          if (!(await whenReady(8000))) throw new Error(state === "gate" ? "bad gate" : "not connected");
          var body, id = m[2];
          if (role === "device") body = await encryptDoc(curK, "requests", id, data);
          else if (role === "pairing" && data.action === "pair") body = data; // clear, by design; a pairing socket never starts pairing (r2: that happens on the Mac)
          else throw new Error("This device isn't paired.");
          var ref = "p" + (++refSeq) + "-" + Math.random().toString(36).slice(2, 8), sock = ws;
          if (!sock || state !== "ready") throw new Error("not connected");
          return new Promise(function (resolve, reject) {
            pending[ref] = { resolve: resolve, reject: reject, timer: setT(function () { if (pending[ref]) { delete pending[ref]; reject(lostErr("timeout")); } }, 10000) };
            try { sock.send(JSON.stringify({ t: "put", ref: ref, col: "requests", id: id, createdAt: typeof data.createdAt === "string" ? data.createdAt : "", body: body })); }
            catch (e) { clrT(pending[ref].timer); delete pending[ref]; reject(e); }
          });
        }
      };
    };
    db.collection = function (name) {
      if (name !== "requests") throw new Error("not allowed");
      var q = { order: false, lim: 0 };
      var api = {
        orderBy: function (f, dir) { if (f !== "createdAt" || dir !== "desc") throw new Error("unsupported"); q.order = true; return api; },
        limit: function (n) { if (n !== LIMIT) throw new Error("unsupported"); q.lim = n; return api; },
        onSnapshot: function (cb, err) { if (!q.order || !q.lim) throw new Error("unsupported"); return sub("requests/*", cb, err || noop); }
      };
      return api;
    };
    db.connect = function () { stopped = false; open(); return db; };
    return db;
  }

  return { b64u: b64u, ub64: ub, aadFor: aadFor, encryptDoc: encryptDoc, decryptDoc: decryptDoc, decryptBodyText: decryptBodyText, makeDhKey: makeDhKey, ecdhZ: ecdhZ, hkdfWrapBits: hkdfWrapBits, deriveWrapKey: deriveWrapKey, unwrapSpaceKey: unwrapSpaceKey, openSpaceKey: openSpaceKey, signAuth: signAuth, gateFor: gateFor, okPubJwk: okPubJwk, createDb: createDb };
});
