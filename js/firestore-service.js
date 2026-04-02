/**
 * Firestore (modulare SDK v10)
 * ---------------------------
 * SECURITY: Siehe firebase-config.js – Rules für entries/users sind Pflicht.
 *
 * Optional / Zukunft: Statt Abgleich über displayName besser eine feste userId
 * (z. B. aus Firebase Auth) als Dokument-ID und in jedem Entry speichern.
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  addDoc,
  updateDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const ENTRIES_COLLECTION = "entries";
const USERS_COLLECTION = "users";

const cfg = typeof window !== "undefined" ? window.JC_FIREBASE_CONFIG : null;
const isPlaceholder =
  !cfg ||
  !cfg.apiKey ||
  cfg.apiKey === "YOUR_API_KEY" ||
  !cfg.projectId ||
  cfg.projectId === "YOUR_PROJECT_ID";

let db = null;

if (!isPlaceholder) {
  try {
    if (!getApps().length) {
      initializeApp(cfg);
    }
    db = getFirestore();
  } catch (e) {
    console.error("[JCFirestore] Initialisierung fehlgeschlagen:", e);
  }
}

/**
 * Stabile Dokument-ID unter users/ für einen Anzeigenamen.
 * Transaktionen können keine where-Queries ausführen; gleicher Name → gleiche ID.
 */
function userDocKeyFromName(name) {
  const t = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const safe = t.replace(/[/\\[\]#?]/g, "_");
  return safe.length ? safe : "_unnamed";
}

/**
 * @param {{ name: string, activity: string, hours: number }} payload
 */
function submitMemberEntry(payload) {
  if (!db) {
    return Promise.reject(new Error("Firebase ist nicht konfiguriert."));
  }
  return addDoc(collection(db, ENTRIES_COLLECTION), {
    name: String(payload.name).trim(),
    activity: String(payload.activity).trim(),
    hours: Number(payload.hours),
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

/**
 * @param {(rows: Array<{ id: string } & Record<string, unknown>>) => void} onNext
 * @param {(err: Error) => void} [onError]
 */
function subscribePendingEntries(onNext, onError) {
  if (!db) {
    if (onError) onError(new Error("Firebase ist nicht konfiguriert."));
    return function () {};
  }

  const q = query(collection(db, ENTRIES_COLLECTION), where("status", "==", "pending"));

  return onSnapshot(
    q,
    (snap) => {
      const rows = [];
      snap.forEach((d) => {
        rows.push(Object.assign({ id: d.id }, d.data()));
      });
      rows.sort((a, b) => {
        const ta =
          a.createdAt && typeof a.createdAt.toMillis === "function" ? a.createdAt.toMillis() : 0;
        const tb =
          b.createdAt && typeof b.createdAt.toMillis === "function" ? b.createdAt.toMillis() : 0;
        return tb - ta;
      });
      onNext(rows);
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

/**
 * Status eines Eintrags setzen (z. B. reject).
 * @param {string} docId
 * @param {"pending" | "approved" | "rejected"} status
 */
function setEntryStatus(docId, status) {
  if (!db) {
    return Promise.reject(new Error("Firebase ist nicht konfiguriert."));
  }
  return updateDoc(doc(db, ENTRIES_COLLECTION, docId), { status: status });
}

/**
 * Genehmigen: Stunden dem User-Konto gutschreiben, dann Entry auf approved.
 * Doppelklick / Parallelität: In der Transaktion wird status erneut geprüft;
 * nur "pending" wird verarbeitet.
 *
 * @returns {Promise<boolean>} true wenn genehmigt und geschrieben, false wenn übersprungen (z. B. nicht pending)
 *
 * Hinweis: User-Zuordnung über users/{userDocKeyFromName(name)} mit Feldern
 * { name, hours }. Firestore-Transaktionen erlauben keine where-Queries; gleicher
 * normalisierter Name → gleiches User-Dokument (entspricht „User mit gleichem Namen“).
 * Optional: später userId statt Name (siehe Dateikopf).
 */
async function approveEntry(entryId) {
  if (!db) {
    throw new Error("Firebase ist nicht konfiguriert.");
  }

  let approved = false;

  try {
    const entryRef = doc(db, ENTRIES_COLLECTION, entryId);
    const preSnap = await getDoc(entryRef);
    if (!preSnap.exists()) {
      console.warn("[approveEntry] Eintrag fehlt:", entryId);
      return false;
    }
    const pre = preSnap.data();
    if (pre.status !== "pending") {
      console.warn("[approveEntry] Übersprungen (nicht pending):", entryId);
      return false;
    }

    // getDocs / query / where: Diagnose bei mehreren Legacy-Dokumenten gleichen Namens
    try {
      const nameForQuery = String(pre.name || "").trim();
      if (nameForQuery) {
        const dupQ = query(
          collection(db, USERS_COLLECTION),
          where("name", "==", pre.name)
        );
        const dupSnap = await getDocs(dupQ);
        if (dupSnap.size > 1) {
          console.warn(
            "[approveEntry] Mehrere users-Dokumente mit gleichem name – bitte auf userId migrieren."
          );
        }
      }
    } catch (e) {
      console.warn("[approveEntry] Diagnose-Query users:", e);
    }

    await runTransaction(db, async (transaction) => {
      approved = false;
      const entrySnap = await transaction.get(entryRef);
      if (!entrySnap.exists()) {
        console.warn("[approveEntry] (Tx) Eintrag fehlt:", entryId);
        return;
      }
      const entry = entrySnap.data();
      if (entry.status !== "pending") {
        console.warn("[approveEntry] (Tx) Übersprungen (nicht pending):", entryId);
        return;
      }

      const hours = Number(entry.hours) || 0;
      const displayName = String(entry.name || "").trim();
      const userKey = userDocKeyFromName(displayName);
      const userRef = doc(db, USERS_COLLECTION, userKey);
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists()) {
        transaction.set(userRef, {
          name: entry.name,
          hours: hours,
        });
      } else {
        const prev = Number(userSnap.data().hours) || 0;
        transaction.update(userRef, { hours: prev + hours });
      }

      transaction.update(entryRef, { status: "approved" });
      approved = true;
    });

    return approved;
  } catch (e) {
    console.error("[approveEntry]", e);
    throw e;
  }
}

window.JCFirestore = {
  isReady: function () {
    return !!db;
  },
  submitMemberEntry: submitMemberEntry,
  subscribePendingEntries: subscribePendingEntries,
  setEntryStatus: setEntryStatus,
  approveEntry: approveEntry,
};
