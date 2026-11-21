/* Home Screen app plumbing: register the service worker and ask the browser to keep this origin's storage (the device keys live in IndexedDB). */
(function () {
  "use strict";
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (p) { if (!p) return navigator.storage.persist(); }).catch(function () {});
    }
  } catch (e) {}
  try {
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(function () {}); });
    }
  } catch (e) {}
})();
