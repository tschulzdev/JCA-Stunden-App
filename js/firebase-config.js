/**
 * Firebase-Konfiguration & Member-Link-Schlüssel
 * ---------------------------------------------
 * Werte aus der Firebase Console (Projekt → App-Einstellungen) eintragen.
 *
 * QR-Code / Link für Mitglieder (Beispiel):
 *   https://ihre-domain.de/index.html?role=member&key=XYZ123#/submit
 * Parameter können auch am Hash hängen: #/submit?role=member&key=XYZ123
 *
 * SECURITY / WICHTIG:
 * -------------------
 * Der Parameter `key` ist KEINE echte Authentifizierung. Jeder, der den Schlüssel
 * kennt oder errät, kann Einträge einreichen. Der Schlüssel liegt im Klartext in
 * der URL und im Frontend-Code bzw. in der geteilten Konfiguration.
 *
 * Für den produktiven Betrieb empfehlen wir:
 * - Firebase Authentication (z. B. Anonym + Custom Claims, Magic Link, oder Login)
 * - Firestore Security Rules, die request.auth.uid / request.auth.token prüfen
 * - Keine Geheimnisse nur im Client; ggf. Cloud Functions für sensible Operationen
 *
 */
window.JC_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBuQ-8umNtG52p-Iw1j3PjPOYMGI9_44wQ",
  authDomain: "jca-stunden-app.firebaseapp.com",
  projectId: "jca-stunden-app",
  storageBucket: "jca-stunden-app.firebasestorage.app",
  messagingSenderId: "985786254326",
  appId: "1:985786254326:web:81a5ecbe9d4cdabcfebdd7",
};

/**
 * Muss exakt mit dem `key`-Wert im Member-Link übereinstimmen (Beispiel: XYZ123).
 * Siehe Sicherheitshinweis oben.
 */
window.JC_MEMBER_SUBMIT_KEY = "XYZ123";

/*
 * Firestore Rules – nur als Denkanstoß, vor Produktion anpassen und testen:
 *
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{database}/documents {
 *     match /entries/{entryId} { ... }
 *     match /users/{userId} {
 *       allow read: if true;              // Anpassen
 *       allow write: if request.auth != null;
 *     }
 *     match /activities/{id} {
 *       allow if request.auth != null;   // oder Regeln für eure Rollen
 *     }
 *   }
 * }
 *
 * Ohne passende Rules ist die Datenbank für jeden mit Projekt-API-Key les-/schreibbar
 * (Client-Schlüssel sind öffentlich). Auth + Rules sind Pflicht für echte Sicherheit.
 */
