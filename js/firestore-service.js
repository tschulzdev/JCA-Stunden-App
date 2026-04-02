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
  setDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const ENTRIES_COLLECTION = "entries";
const USERS_COLLECTION = "users";
/** Tätigkeiten für Dropdowns & Melde-Seite (Felder: name) */
const ACTIVITIES_COLLECTION = "activities";

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
  const key = safe.length ? safe : "_unnamed";
  return key.length > 700 ? key.slice(0, 700) : key;
}

/** Firestore-Zahlen (auch ältere Long-Typen) zu JS-number für increment/set. */
function toNumberHours(v) {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (v && typeof v === "object" && typeof v.toNumber === "function") {
    try {
      return v.toNumber();
    } catch {
      /* ignore */
    }
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Modulares Firestore: exists ist boolean; ältere Snippets nutzen exists() – beides abfangen. */
function docExists(snap) {
  if (!snap) return false;
  if (typeof snap.exists === "boolean") return snap.exists;
  if (typeof snap.exists === "function") return snap.exists();
  return false;
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
    if (!docExists(preSnap)) {
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
      if (!docExists(entrySnap)) {
        console.warn("[approveEntry] (Tx) Eintrag fehlt:", entryId);
        return;
      }
      const entry = entrySnap.data();
      if (entry.status !== "pending") {
        console.warn("[approveEntry] (Tx) Übersprungen (nicht pending):", entryId);
        return;
      }

      const hours = toNumberHours(entry.hours);
      const displayName = String(entry.name || "").trim();
      const userKey = userDocKeyFromName(displayName);
      const userRef = doc(db, USERS_COLLECTION, userKey);
      const userSnap = await transaction.get(userRef);

      // Neu: feste Stunden; bestehend: FieldValue.increment (atomar, robust bei Typen).
      // Firestore Rules: increment nutzt Sentinel-Werte – Regeln dürfen nicht
      // request.resource.data.hours mit resource.data.hours + X gleichsetzen.
      if (!docExists(userSnap)) {
        transaction.set(userRef, {
          name: String(entry.name || "").trim(),
          hours: hours,
        });
      } else {
        transaction.update(userRef, {
          name: String(entry.name || "").trim(),
          hours: increment(hours),
        });
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

/**
 * Alle Dokumente aus users (id = Doc-ID, name, hours aus Cloud).
 */
function subscribeUsers(onNext, onError) {
  if (!db) {
    if (onError) onError(new Error("Firebase ist nicht konfiguriert."));
    return function () {};
  }
  return onSnapshot(
    collection(db, USERS_COLLECTION),
    (snap) => {
      const rows = [];
      snap.forEach((d) => {
        const dat = d.data();
        rows.push({
          id: d.id,
          name: String(dat.name || ""),
          hours: toNumberHours(dat.hours),
        });
      });
      rows.sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
      onNext(rows);
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

/**
 * Alle Tätigkeiten (id = Auto-ID, name).
 */
function subscribeActivities(onNext, onError) {
  if (!db) {
    if (onError) onError(new Error("Firebase ist nicht konfiguriert."));
    return function () {};
  }
  return onSnapshot(
    collection(db, ACTIVITIES_COLLECTION),
    (snap) => {
      const rows = [];
      snap.forEach((d) => {
        const dat = d.data();
        rows.push({ id: d.id, name: String(dat.name || "") });
      });
      rows.sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
      onNext(rows);
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

/**
 * Neues Mitglied in users (Stunden starten bei 0). Doc-ID = normalisierter Name.
 */
async function createUser(displayName) {
  if (!db) {
    throw new Error("Firebase ist nicht konfiguriert.");
  }
  const nm = String(displayName || "").trim();
  if (!nm) {
    throw new Error("Name darf nicht leer sein.");
  }
  const key = userDocKeyFromName(nm);
  const ref = doc(db, USERS_COLLECTION, key);
  const ex = await getDoc(ref);
  if (docExists(ex)) {
    throw new Error("Ein Mitglied mit diesem Namen existiert bereits.");
  }
  await setDoc(ref, { name: nm, hours: 0 });
  return key;
}

/**
 * Anzeigenamen ändern. Bei geändertem normalisierten Namen: Dokument verschieben.
 * @returns {Promise<string>} neue oder unveränderte Doc-ID
 */
async function renameUser(oldDocId, newDisplayName) {
  if (!db) {
    throw new Error("Firebase ist nicht konfiguriert.");
  }
  const nm = String(newDisplayName || "").trim();
  if (!nm) {
    throw new Error("Name darf nicht leer sein.");
  }
  const newKey = userDocKeyFromName(nm);
  const oldRef = doc(db, USERS_COLLECTION, oldDocId);

  if (newKey === oldDocId) {
    await updateDoc(oldRef, { name: nm });
    return oldDocId;
  }

  const newRef = doc(db, USERS_COLLECTION, newKey);
  const clash = await getDoc(newRef);
  if (docExists(clash)) {
    throw new Error("Unter diesem Namen existiert bereits ein anderes Mitglied.");
  }

  await runTransaction(db, async (tx) => {
    const o = await tx.get(oldRef);
    if (!docExists(o)) {
      throw new Error("Mitglied nicht gefunden.");
    }
    const d = o.data();
    const hrs = toNumberHours(d.hours);
    tx.set(newRef, { name: nm, hours: hrs });
    tx.delete(oldRef);
  });
  return newKey;
}

/**
 * @param {string} name Tätigkeitsbezeichnung
 */
/**
 * @returns {Promise<string>} neue Dokument-ID
 */
async function createActivity(name) {
  if (!db) {
    throw new Error("Firebase ist nicht konfiguriert.");
  }
  const nm = String(name || "").trim();
  if (!nm) {
    throw new Error("Name darf nicht leer sein.");
  }
  const ref = await addDoc(collection(db, ACTIVITIES_COLLECTION), { name: nm });
  return ref.id;
}

/**
 * @param {string} activityDocId
 */
function deleteActivity(activityDocId) {
  if (!db) {
    return Promise.reject(new Error("Firebase ist nicht konfiguriert."));
  }
  return deleteDoc(doc(db, ACTIVITIES_COLLECTION, activityDocId));
}

window.JCFirestore = {
  isReady: function () {
    return !!db;
  },
  submitMemberEntry: submitMemberEntry,
  subscribePendingEntries: subscribePendingEntries,
  setEntryStatus: setEntryStatus,
  approveEntry: approveEntry,
  subscribeUsers: subscribeUsers,
  subscribeActivities: subscribeActivities,
  createUser: createUser,
  renameUser: renameUser,
  createActivity: createActivity,
  deleteActivity: deleteActivity,
};
