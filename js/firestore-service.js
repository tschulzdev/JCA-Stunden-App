/**
 * Firestore-Anbindung (Compat-API über globales `firebase`)
 * ---------------------------------------------------------
 * Erwartet vor diesem Skript: firebase-app-compat + firebase-firestore-compat
 * und gültige Werte in window.JC_FIREBASE_CONFIG.
 *
 * SECURITY:
 * Clientseitige Schreib-/Leserechte werden ausschließlich über Firestore Rules
 * geschützt. Ohne passende Rules ist die Datenbank öffentlich. Der Member-`key`
 * in der App ersetzt keine Auth – siehe Kommentar in firebase-config.js.
 */
(function () {
  "use strict";

  var ENTRIES_COLLECTION = "entries";

  var cfg = typeof JC_FIREBASE_CONFIG !== "undefined" ? JC_FIREBASE_CONFIG : null;
  var isPlaceholder =
    !cfg ||
    !cfg.apiKey ||
    cfg.apiKey === "YOUR_API_KEY" ||
    !cfg.projectId ||
    cfg.projectId === "YOUR_PROJECT_ID";

  /** @type {firebase.firestore.Firestore | null} */
  var db = null;

  if (!isPlaceholder && typeof firebase !== "undefined") {
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(cfg);
      }
      db = firebase.firestore();
    } catch (e) {
      console.error("[JCFirestore] Initialisierung fehlgeschlagen:", e);
    }
  }

  /**
   * @param {{ name: string, activity: string, hours: number }} payload
   * @returns {Promise<void>}
   */
  function submitMemberEntry(payload) {
    if (!db) {
      return Promise.reject(new Error("Firebase ist nicht konfiguriert."));
    }
    return db.collection(ENTRIES_COLLECTION).add({
      name: String(payload.name).trim(),
      activity: String(payload.activity).trim(),
      hours: Number(payload.hours),
      status: "pending",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Echtzeit-Listener für alle Einträge mit status === "pending".
   * Sortierung nach createdAt absteigend erfolgt clientseitig (kein zusammengesetzter Index nötig).
   *
   * @param {(rows: Array<{ id: string } & Record<string, unknown>>) => void} onNext
   * @param {(err: Error) => void} [onError]
   * @returns {() => void} unsubscribe
   */
  function subscribePendingEntries(onNext, onError) {
    if (!db) {
      if (onError) onError(new Error("Firebase ist nicht konfiguriert."));
      return function () {};
    }

    return db
      .collection(ENTRIES_COLLECTION)
      .where("status", "==", "pending")
      .onSnapshot(
        function (snap) {
          var rows = [];
          snap.forEach(function (doc) {
            rows.push(Object.assign({ id: doc.id }, doc.data()));
          });
          rows.sort(function (a, b) {
            var ta =
              a.createdAt && typeof a.createdAt.toMillis === "function"
                ? a.createdAt.toMillis()
                : 0;
            var tb =
              b.createdAt && typeof b.createdAt.toMillis === "function"
                ? b.createdAt.toMillis()
                : 0;
            return tb - ta;
          });
          onNext(rows);
        },
        function (err) {
          if (onError) onError(err);
        }
      );
  }

  /**
   * @param {string} docId
   * @param {"approved" | "rejected"} status
   */
  function setEntryStatus(docId, status) {
    if (!db) {
      return Promise.reject(new Error("Firebase ist nicht konfiguriert."));
    }
    return db.collection(ENTRIES_COLLECTION).doc(docId).update({ status: status });
  }

  window.JCFirestore = {
    isReady: function () {
      return !!db;
    },
    submitMemberEntry: submitMemberEntry,
    subscribePendingEntries: subscribePendingEntries,
    setEntryStatus: setEntryStatus,
  };
})();
