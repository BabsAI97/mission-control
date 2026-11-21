/* Frame-buster (a meta CSP cannot carry frame-ancestors): the page stays hidden until it knows it is the top window; framed, it blanks itself. */
(function () {
  "use strict";
  var framed = true;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (framed) { try { document.documentElement.textContent = ""; } catch (e) {} return; }
  var s = document.getElementById("fb"); if (s && s.parentNode) s.parentNode.removeChild(s);
})();
