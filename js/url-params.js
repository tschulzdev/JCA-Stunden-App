/**
 * URL-Parameter-Helfer
 * --------------------
 * Kombiniert Query-String (location.search) und optionale Parameter im Hash
 * (z. B. #/submit?role=member&key=abc). Bei doppeltem Schlüssel überschreibt der
 * Hash die Werte aus dem Search-String (Hash gewinnt).
 */
(function (global) {
  "use strict";

  /**
   * @returns {Record<string, string>}
   */
  function getMergedParams() {
    const merged = Object.create(null);

    new URLSearchParams(typeof location !== "undefined" ? location.search : "").forEach(
      function (value, key) {
        merged[key] = value;
      }
    );

    const hash = typeof location !== "undefined" ? location.hash || "" : "";
    const q = hash.indexOf("?");
    if (q >= 0) {
      new URLSearchParams(hash.slice(q + 1)).forEach(function (value, key) {
        merged[key] = value;
      });
    }

    return merged;
  }

  global.JCUrlParams = {
    getMergedParams: getMergedParams,
  };
})(typeof window !== "undefined" ? window : this);
