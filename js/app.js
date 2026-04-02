/**
 * Jugendclub – Arbeitsstunden
 * -----------------------------
 * Single-Page-App mit LocalStorage + optional Firestore (Member-Einreichung / Admin-Freigabe).
 * Datenmodell (siehe README-Kommentare unten):
 * - members:    { id, name }
 * - entries:    { id, memberId, date, activity, hours }
 * - activities: { id, name } (keine vordefinierten Tätigkeiten – alles manuell anlegbar)
 * totalHours pro Mitglied wird immer aus entries berechnet (nicht dauerhaft gespeichert).
 */

(function () {
  "use strict";

  // --- Konstanten & Storage-Schlüssel ---
  const STORAGE_KEY = "jugendclub-stunden-v1";
  const PREFS_KEY = "jugendclub-prefs-v1";
  const HOURS_GOAL = 20;

  /** @typedef {{ id: string, name: string }} Member */
  /** @typedef {{ id: string, memberId: string, date: string, activity: string, hours: number }} TimeEntry */
  /** @typedef {{ id: string, name: string }} Activity */

  /**
   * @returns {{ members: Member[], entries: TimeEntry[], activities: Activity[] }}
   */
  function emptyState() {
    return { members: [], entries: [], activities: [] };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedInitialState();
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return seedInitialState();
      return {
        members: Array.isArray(data.members) ? data.members : [],
        entries: Array.isArray(data.entries) ? data.entries : [],
        activities: Array.isArray(data.activities) ? data.activities : [],
      };
    } catch {
      return seedInitialState();
    }
  }

  function seedInitialState() {
    return emptyState();
  }

  function saveState() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        members: state.members,
        entries: state.entries,
        activities: state.activities,
      })
    );
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  /** @type {{ members: Member[], entries: TimeEntry[], activities: Activity[] }} */
  let state = loadState();

  /** @type {{ memberSort: 'alpha' | 'hours', darkMode: boolean }} */
  function defaultPrefs() {
    return { memberSort: "alpha", darkMode: false };
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return defaultPrefs();
      const p = JSON.parse(raw);
      return {
        memberSort: p.memberSort === "hours" ? "hours" : "alpha",
        darkMode: !!p.darkMode,
      };
    } catch {
      return defaultPrefs();
    }
  }

  function savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  let prefs = loadPrefs();

  function applyTheme() {
    document.documentElement.classList.toggle("theme-dark", prefs.darkMode);
    const btn = $("#btn-theme-toggle");
    if (btn) {
      btn.setAttribute("aria-pressed", prefs.darkMode ? "true" : "false");
      btn.textContent = prefs.darkMode ? "Hellmodus" : "Dunkelmodus";
    }
  }

  // --- Dom-Hilfen ---
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function showToast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("toast--visible");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("toast--visible"), 2800);
  }

  // --- Geschäftslogik: Stunden pro Mitglied ---
  function memberTotalHours(memberId) {
    return state.entries
      .filter((e) => e.memberId === memberId)
      .reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
  }

  function getMember(id) {
    return state.members.find((m) => m.id === id) || null;
  }

  /** Eintrag speichert activity als Name (String) laut Anforderung „activity“ im Eintrag */
  function activityNameForEntry(activityIdOrName) {
    const byId = state.activities.find((a) => a.id === activityIdOrName);
    if (byId) return byId.name;
    return String(activityIdOrName || "");
  }

  // --- Zeitberechnung Start/Ende (gleicher Kalendertag; Über Mitternacht: +24h) ---
  function parseTimeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return null;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  function durationHoursFromStartEnd(startStr, endStr) {
    const s = parseTimeToMinutes(startStr);
    const e = parseTimeToMinutes(endStr);
    if (s === null || e === null) return null;
    let diffMin = e - s;
    if (diffMin < 0) diffMin += 24 * 60;
    return Math.round((diffMin / 60) * 100) / 100;
  }

  // --- Routing (Hash + programmatisch) ---
  const views = {
    home: $("#view-home"),
    "add-entry": $("#view-add-entry"),
    activities: $("#view-activities"),
    "member-detail": $("#view-member-detail"),
    timer: $("#view-timer"),
    "filter-export": $("#view-filter-export"),
    "access-denied": $("#view-access-denied"),
    "member-submit": $("#view-member-submit"),
    admin: $("#view-admin"),
  };

  let currentMemberDetailId = null;

  /** @type {null | (() => void)} */
  let adminFirestoreUnsub = null;

  function tearDownAdmin() {
    if (typeof adminFirestoreUnsub === "function") {
      adminFirestoreUnsub();
      adminFirestoreUnsub = null;
    }
  }

  /**
   * UI-Modus: Member-Seiten blenden Admin-Navigation aus (kein Ersatz für echte Sicherheit).
   * @param {"default" | "member" | "restricted"} mode
   */
  function setAppMode(mode) {
    document.body.classList.remove("app-mode--member", "app-mode--restricted");
    const titleEl = $("#app-title-text");
    if (mode === "member") {
      document.body.classList.add("app-mode--member");
      if (titleEl) titleEl.textContent = "Stunden melden";
    } else if (mode === "restricted") {
      document.body.classList.add("app-mode--restricted");
      if (titleEl) titleEl.textContent = "Zugriff";
    } else {
      if (titleEl) titleEl.textContent = "Arbeitsstunden";
    }
  }

  function setActiveNav(viewName) {
    $$(".nav-btn").forEach((btn) => {
      const active = viewName != null && btn.dataset.view === viewName;
      btn.classList.toggle("nav-btn--active", active);
    });
  }

  function showView(name, options = {}) {
    Object.keys(views).forEach((key) => {
      views[key].classList.toggle("view--active", key === name);
    });

    if (name === "access-denied" || name === "member-submit") {
      setActiveNav(null);
    } else if (name === "admin") {
      setActiveNav("admin");
    } else if (name !== "member-detail") {
      const navName =
        name === "member-detail" ? "home" : name === "add-entry" && options.fromNav ? "add-entry" : name;
      setActiveNav(
        ["home", "add-entry", "activities", "timer", "filter-export", "admin"].includes(navName)
          ? navName === "home" && name === "add-entry"
            ? "add-entry"
            : navName
          : "home"
      );
    } else {
      setActiveNav("home");
    }

    if (name === "add-entry" && !options.skipHash) {
      location.hash = options.editId ? "#/eintrag/" + options.editId : "#/stunde";
    } else if (name === "home" && !options.skipHash) {
      location.hash = "#/";
    } else if (name === "member-detail" && currentMemberDetailId && !options.skipHash) {
      location.hash = "#/mitglied/" + currentMemberDetailId;
    } else if (name === "activities" && !options.skipHash) {
      location.hash = "#/taetigkeiten";
    } else if (name === "timer" && !options.skipHash) {
      location.hash = "#/timer";
    } else if (name === "filter-export" && !options.skipHash) {
      location.hash = "#/export";
    } else if (name === "admin" && !options.skipHash) {
      location.hash = "#/admin";
    }
  }

  function formatCloudTimestamp(ts) {
    if (!ts || typeof ts.toDate !== "function") return "—";
    try {
      return ts.toDate().toLocaleString("de-DE");
    } catch {
      return "—";
    }
  }

  function mountAdminFirestore() {
    tearDownAdmin();
    const tbody = $("#admin-pending-body");
    const empty = $("#admin-pending-empty");
    const table = $("#admin-pending-table");
    if (!tbody || !empty) return;

    if (!window.JCFirestore || !JCFirestore.isReady()) {
      tbody.innerHTML = "";
      empty.textContent =
        "Firebase ist nicht konfiguriert. Tragen Sie die Projektdaten in js/firebase-config.js ein und laden Sie die Seite neu.";
      empty.classList.remove("hidden");
      if (table) table.classList.add("hidden");
      return;
    }

    if (table) table.classList.remove("hidden");
    empty.textContent = "Keine ausstehenden Einträge.";
    empty.classList.add("hidden");

    adminFirestoreUnsub = JCFirestore.subscribePendingEntries(
      (rows) => {
        empty.classList.toggle("hidden", rows.length > 0);
        tbody.innerHTML = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" +
            escapeHtml(formatCloudTimestamp(row.createdAt)) +
            "</td>" +
            "<td>" +
            escapeHtml(String(row.name || "")) +
            "</td>" +
            "<td>" +
            escapeHtml(String(row.activity || "")) +
            "</td>" +
            "<td>" +
            escapeHtml(formatHours(Number(row.hours) || 0)) +
            "</td>" +
            '<td class="col-actions"></td>';
          const td = tr.querySelector(".col-actions");
          const ap = document.createElement("button");
          ap.type = "button";
          ap.className = "btn btn--primary btn--small";
          ap.textContent = "Approve";
          ap.addEventListener("click", () => {
            JCFirestore.approveEntry(row.id)
              .then(function (ok) {
                if (ok) showToast("Approved.");
              })
              .catch((e) => showToast(e.message || "Fehler"));
          });
          const rj = document.createElement("button");
          rj.type = "button";
          rj.className = "btn btn--danger btn--small";
          rj.textContent = "Reject";
          rj.addEventListener("click", () => {
            JCFirestore.setEntryStatus(row.id, "rejected")
              .then(() => showToast("Rejected."))
              .catch((e) => showToast(e.message || "Fehler"));
          });
          td.appendChild(ap);
          td.appendChild(rj);
          tbody.appendChild(tr);
        });
      },
      (err) => {
        console.error(err);
        showToast(err.message || "Firestore-Fehler");
      }
    );
  }

  function parseHash() {
    const raw = (location.hash || "#/").replace(/^#/, "") || "/";
    const pathOnly = raw.split("?")[0];
    const parts = pathOnly.split("/").filter(Boolean);

    if (parts[0] === "submit") {
      tearDownAdmin();
      const params =
        typeof JCUrlParams !== "undefined" ? JCUrlParams.getMergedParams() : {};
      const expectedKey =
        typeof JC_MEMBER_SUBMIT_KEY !== "undefined" ? JC_MEMBER_SUBMIT_KEY : "";
      if (params.role !== "member" || !params.key || params.key !== expectedKey) {
        setAppMode("restricted");
        showView("access-denied", { skipHash: true });
        return;
      }
      setAppMode("member");
      showView("member-submit", { skipHash: true });
      return;
    }

    setAppMode("default");

    if (parts[0] !== "admin") {
      tearDownAdmin();
    }

    if (parts[0] === "admin") {
      showView("admin", { skipHash: true });
      mountAdminFirestore();
      return;
    }

    if (parts[0] === "mitglied" && parts[1]) {
      currentMemberDetailId = parts[1];
      if (getMember(currentMemberDetailId)) {
        showView("member-detail", { skipHash: true });
        renderMemberDetail();
        return;
      }
    }
    if (parts[0] === "eintrag" && parts[1]) {
      openEntryForm(parts[1], { skipHash: true });
      return;
    }
    if (parts[0] === "stunde") {
      openEntryForm(null, { skipHash: true });
      return;
    }
    if (parts[0] === "taetigkeiten") {
      showView("activities", { skipHash: true });
      renderActivities();
      return;
    }
    if (parts[0] === "timer") {
      showView("timer", { skipHash: true });
      fillTimerNewForm();
      renderTimerList();
      return;
    }
    if (parts[0] === "export") {
      showView("filter-export", { skipHash: true });
      renderFilterExport();
      return;
    }
    currentMemberDetailId = null;
    showView("home", { skipHash: true });
    renderHome();
  }

  window.addEventListener("hashchange", parseHash);

  // --- Rendering: Home ---
  function sortMembersForHome(list) {
    const copy = [...list];
    if (prefs.memberSort === "hours") {
      copy.sort((a, b) => {
        const ha = memberTotalHours(a.id);
        const hb = memberTotalHours(b.id);
        if (hb !== ha) return hb - ha;
        return a.name.localeCompare(b.name, "de", { sensitivity: "base" });
      });
    } else {
      copy.sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
    }
    return copy;
  }

  function renderHome() {
    const sortSel = $("#member-sort");
    if (sortSel) sortSel.value = prefs.memberSort;

    const list = $("#member-list");
    const empty = $("#member-empty");
    list.innerHTML = "";
    if (state.members.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    const sorted = sortMembersForHome(state.members);
    sorted.forEach((m) => {
      const total = memberTotalHours(m.id);
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-card";
      btn.dataset.memberId = m.id;
      btn.innerHTML =
        '<span class="member-card__name"></span><span class="member-card__hours"></span>';
      const nameEl = btn.querySelector(".member-card__name");
      nameEl.textContent = m.name;
      if (total >= HOURS_GOAL) {
        nameEl.classList.add("member-card__name--goal");
      }
      btn.querySelector(".member-card__hours").textContent =
        formatHours(total) + " h";
      btn.addEventListener("click", () => {
        currentMemberDetailId = m.id;
        showView("member-detail");
        renderMemberDetail();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function formatHours(n) {
    return (Math.round(n * 100) / 100).toLocaleString("de-DE", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  // --- Mitglied hinzufügen ---
  const dialogMember = /** @type {HTMLDialogElement} */ ($("#dialog-member"));

  function openMemberDialog() {
    $("#dialog-member-name").value = "";
    dialogMember.showModal();
    $("#dialog-member-name").focus();
  }

  $("#btn-add-member").addEventListener("click", openMemberDialog);
  $("#dialog-member-cancel").addEventListener("click", () => dialogMember.close());

  $("#member-sort").addEventListener("change", () => {
    const v = $("#member-sort").value;
    prefs.memberSort = v === "hours" ? "hours" : "alpha";
    savePrefs();
    renderHome();
  });

  $("#btn-theme-toggle").addEventListener("click", () => {
    prefs.darkMode = !prefs.darkMode;
    savePrefs();
    applyTheme();
  });

  $("#form-member-dialog").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = $("#dialog-member-name").value.trim();
    if (!name) return;
    state.members.push({ id: newId(), name });
    saveState();
    dialogMember.close();
    showToast("Mitglied gespeichert.");
    renderHome();
    fillMemberSelects();
    fillTimerNewForm();
  });

  // --- Dropdowns füllen ---
  function fillMemberSelects() {
    const optionsHtml = (includeEmpty) => {
      let o = includeEmpty ? '<option value="">Alle</option>' : "";
      [...state.members]
        .sort((a, b) => a.name.localeCompare(b.name, "de"))
        .forEach((m) => {
          o += `<option value="${escapeAttr(m.id)}">${escapeHtml(m.name)}</option>`;
        });
      return o;
    };
    $("#entry-member").innerHTML = '<option value="">Bitte wählen…</option>' + optionsHtml(false);
    $("#filter-member").innerHTML = optionsHtml(true);
  }

  function fillTimerNewForm() {
    const optionsHtmlMembers = () => {
      let o = "";
      [...state.members]
        .sort((a, b) => a.name.localeCompare(b.name, "de"))
        .forEach((m) => {
          o += `<option value="${escapeAttr(m.id)}">${escapeHtml(m.name)}</option>`;
        });
      return o;
    };
    const sortedActs = [...state.activities].sort((a, b) =>
      a.name.localeCompare(b.name, "de", { sensitivity: "base" })
    );
    let actOpts = '<option value="">Bitte wählen…</option>';
    sortedActs.forEach((a) => {
      actOpts += `<option value="${escapeAttr(a.id)}">${escapeHtml(a.name)}</option>`;
    });
    $("#timer-new-member").innerHTML = '<option value="">Bitte wählen…</option>' + optionsHtmlMembers();
    $("#timer-new-activity").innerHTML = actOpts;
  }

  function fillActivitySelects() {
    const sorted = [...state.activities].sort((a, b) =>
      a.name.localeCompare(b.name, "de", { sensitivity: "base" })
    );
    let opts = '<option value="">Bitte wählen…</option>';
    sorted.forEach((a) => {
      opts += `<option value="${escapeAttr(a.id)}">${escapeHtml(a.name)}</option>`;
    });
    $("#entry-activity").innerHTML = opts;

    let filterOpts = '<option value="">Alle</option>';
    sorted.forEach((a) => {
      filterOpts += `<option value="${escapeAttr(a.name)}">${escapeHtml(a.name)}</option>`;
    });
    $("#filter-activity").innerHTML = filterOpts;

    if ($("#timer-new-activity")) {
      let tOpts = '<option value="">Bitte wählen…</option>';
      sorted.forEach((a) => {
        tOpts += `<option value="${escapeAttr(a.id)}">${escapeHtml(a.name)}</option>`;
      });
      $("#timer-new-activity").innerHTML = tOpts;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  // --- Stundenformular ---
  function setTodayDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    $("#entry-date").value = `${y}-${m}-${day}`;
  }

  /**
   * @param {string|null} entryId
   * @param {{ skipHash?: boolean }} [opts]
   */
  function openEntryForm(entryId, opts) {
    const skipHash = opts && opts.skipHash;
    $("#form-entry").reset();
    $("#entry-id").value = "";
    $("#entry-computed-duration").textContent = "";
    setTodayDate();
    fillMemberSelects();
    fillActivitySelects();

    if (entryId) {
      const e = state.entries.find((x) => x.id === entryId);
      if (e) {
        $("#entry-id").value = e.id;
        $("#entry-heading").textContent = "Eintrag bearbeiten";
        $("#entry-member").value = e.memberId;
        $("#entry-date").value = e.date;
        const act = state.activities.find((a) => a.name === e.activity);
        $("#entry-activity").value = act ? act.id : "";
        $("#entry-hours-direct").value = String(e.hours);
        $("#entry-start").value = "";
        $("#entry-end").value = "";
      }
    } else {
      $("#entry-heading").textContent = "Stunde erfassen";
    }

    const editId = $("#entry-id").value || undefined;
    showView("add-entry", { fromNav: true, skipHash, editId });
    updateComputedDuration();
  }

  function updateComputedDuration() {
    const start = $("#entry-start").value;
    const end = $("#entry-end").value;
    const out = $("#entry-computed-duration");
    if (!start || !end) {
      out.textContent = "";
      return;
    }
    const h = durationHoursFromStartEnd(start, end);
    if (h === null || h <= 0) {
      out.textContent = "Ungültige Zeiten.";
      return;
    }
    out.textContent = "Berechnete Dauer: " + formatHours(h) + " h";
  }

  ["input", "change"].forEach((evt) => {
    $("#entry-start").addEventListener(evt, updateComputedDuration);
    $("#entry-end").addEventListener(evt, updateComputedDuration);
  });

  $("#btn-goto-add-entry").addEventListener("click", () => {
    location.hash = "#/stunde";
  });

  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      if (v === "home") {
        location.hash = "#/";
      } else if (v === "add-entry") {
        location.hash = "#/stunde";
      } else if (v === "activities") {
        location.hash = "#/taetigkeiten";
      } else if (v === "timer") {
        location.hash = "#/timer";
      } else if (v === "filter-export") {
        location.hash = "#/export";
      } else if (v === "admin") {
        location.hash = "#/admin";
      }
    });
  });

  $("#form-member-cloud-submit").addEventListener("submit", function (ev) {
    ev.preventDefault();
    const name = $("#cloud-submit-name").value.trim();
    const activity = $("#cloud-submit-activity").value.trim();
    const hours = parseFloat(String($("#cloud-submit-hours").value).replace(",", "."));
    if (!name || !activity || !Number.isFinite(hours) || hours < 0) {
      showToast("Bitte alle Felder gültig ausfüllen.");
      return;
    }
    if (!window.JCFirestore || !JCFirestore.isReady()) {
      showToast("Firebase ist nicht konfiguriert.");
      return;
    }
    JCFirestore.submitMemberEntry({ name: name, activity: activity, hours: hours })
      .then(function () {
        showToast("Eingereicht – Status: pending.");
        ev.target.reset();
      })
      .catch(function (e) {
        showToast(e.message || "Senden fehlgeschlagen");
      });
  });

  $("#form-entry").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const memberId = $("#entry-member").value;
    const date = $("#entry-date").value;
    const activityId = $("#entry-activity").value;
    const direct = $("#entry-hours-direct").value.trim();
    const start = $("#entry-start").value;
    const end = $("#entry-end").value;

    if (!memberId || !date || !activityId) {
      showToast("Bitte Mitglied, Datum und Tätigkeit ausfüllen.");
      return;
    }

    let hours = null;
    if (direct !== "") {
      const parsed = parseFloat(direct.replace(",", "."));
      if (!Number.isFinite(parsed) || parsed < 0) {
        showToast("Bitte gültige Stunden eingeben.");
        return;
      }
      hours = Math.round(parsed * 100) / 100;
    }
    if (hours === null && start && end) {
      hours = durationHoursFromStartEnd(start, end);
      if (hours === null || hours <= 0) {
        showToast("Start- und Endzeit prüfen.");
        return;
      }
    }
    if (hours === null) {
      showToast("Entweder Stunden oder Start- und Endzeit angeben.");
      return;
    }

    const activityName = activityNameForEntry(activityId);
    const existingId = $("#entry-id").value;

    if (existingId) {
      const idx = state.entries.findIndex((x) => x.id === existingId);
      if (idx >= 0) {
        state.entries[idx] = {
          ...state.entries[idx],
          memberId,
          date,
          activity: activityName,
          hours,
        };
      }
    } else {
      state.entries.push({
        id: newId(),
        memberId,
        date,
        activity: activityName,
        hours,
      });
    }
    saveState();
    showToast(existingId ? "Eintrag aktualisiert." : "Eintrag gespeichert.");
    if (currentMemberDetailId && getMember(currentMemberDetailId)) {
      location.hash = "#/mitglied/" + currentMemberDetailId;
    } else {
      location.hash = "#/";
    }
  });

  $("#btn-cancel-entry").addEventListener("click", () => {
    if (currentMemberDetailId && getMember(currentMemberDetailId)) {
      location.hash = "#/mitglied/" + currentMemberDetailId;
    } else {
      location.hash = "#/";
    }
  });

  // --- Tätigkeiten ---
  function renderActivities() {
    const ul = $("#activity-list");
    ul.innerHTML = "";
    const sorted = [...state.activities].sort((a, b) =>
      a.name.localeCompare(b.name, "de", { sensitivity: "base" })
    );
    if (sorted.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-hint";
      li.style.listStyle = "none";
      li.textContent = "Noch keine Tätigkeiten – oben einen Namen eintragen und hinzufügen.";
      ul.appendChild(li);
      return;
    }
    sorted.forEach((a) => {
      const li = document.createElement("li");
      li.className = "activity-item";
      li.innerHTML = `<span>${escapeHtml(a.name)}</span>`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn--ghost btn--small";
      del.textContent = "Löschen";
      del.addEventListener("click", () => {
        if (!confirm("Tätigkeit wirklich löschen? Bestehende Einträge behalten den Namen als Text."))
          return;
        state.activities = state.activities.filter((x) => x.id !== a.id);
        saveState();
        renderActivities();
        fillActivitySelects();
        fillTimerNewForm();
        showToast("Tätigkeit gelöscht.");
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  $("#form-new-activity").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = $("#new-activity-name").value.trim();
    if (!name) return;
    if (state.activities.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      showToast("Diese Tätigkeit gibt es schon.");
      return;
    }
    state.activities.push({ id: newId(), name });
    saveState();
    $("#new-activity-name").value = "";
    renderActivities();
    fillActivitySelects();
    fillTimerNewForm();
    showToast("Tätigkeit hinzugefügt.");
  });

  const dialogActivity = /** @type {HTMLDialogElement} */ ($("#dialog-activity"));
  $("#btn-quick-add-activity").addEventListener("click", () => {
    $("#dialog-activity-name").value = "";
    dialogActivity.showModal();
    $("#dialog-activity-name").focus();
  });
  $("#dialog-activity-cancel").addEventListener("click", () => dialogActivity.close());
  $("#form-activity-dialog").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = $("#dialog-activity-name").value.trim();
    if (!name) return;
    if (state.activities.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      showToast("Diese Tätigkeit gibt es schon.");
      dialogActivity.close();
      return;
    }
    const id = newId();
    state.activities.push({ id, name });
    saveState();
    fillActivitySelects();
    $("#entry-activity").value = id;
    fillTimerNewForm();
    $("#timer-new-activity").value = id;
    dialogActivity.close();
    showToast("Tätigkeit hinzugefügt.");
  });

  // --- Mitglied-Detail ---
  function renderMemberDetail() {
    const m = getMember(currentMemberDetailId);
    if (!m) {
      location.hash = "#/";
      return;
    }
    const nameEl = $("#detail-member-name");
    nameEl.textContent = m.name;
    const total = memberTotalHours(m.id);
    nameEl.classList.toggle("member-card__name--goal", total >= HOURS_GOAL);
    $("#detail-total-hours").textContent = formatHours(total);

    const tbody = $("#detail-entries-body");
    tbody.innerHTML = "";
    const rows = state.entries
      .filter((e) => e.memberId === m.id)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

    $("#detail-empty").classList.toggle("hidden", rows.length > 0);
    $("#detail-entries-table").classList.toggle("hidden", rows.length === 0);

    rows.forEach((e) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.activity)}</td>
        <td>${escapeHtml(formatHours(e.hours))}</td>
        <td class="col-actions"></td>`;
      const td = tr.querySelector(".col-actions");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn--ghost btn--small";
      editBtn.textContent = "Bearbeiten";
      editBtn.addEventListener("click", () => {
        location.hash = "#/eintrag/" + e.id;
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn--danger btn--small";
      delBtn.textContent = "Löschen";
      delBtn.addEventListener("click", () => {
        if (!confirm("Eintrag wirklich löschen?")) return;
        state.entries = state.entries.filter((x) => x.id !== e.id);
        saveState();
        renderMemberDetail();
        showToast("Eintrag gelöscht.");
      });
      td.appendChild(editBtn);
      td.appendChild(delBtn);
      tbody.appendChild(tr);
    });
  }

  $("#btn-back-from-detail").addEventListener("click", () => {
    location.hash = "#/";
  });

  // --- Timer (mehrere parallel) ---
  /**
   * @typedef {{ id: string, memberId: string, activityId: string, startedAt: number }} ActiveTimer
   */

  /** @type {ActiveTimer[]} */
  let activeTimers = [];
  let timerRaf = 0;

  function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function stopTimerLoop() {
    if (timerRaf) {
      cancelAnimationFrame(timerRaf);
      timerRaf = 0;
    }
  }

  function timerLoop() {
    if (activeTimers.length === 0) {
      timerRaf = 0;
      return;
    }
    const now = Date.now();
    activeTimers.forEach((t) => {
      const esc =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(t.id)
          : t.id;
      const el = document.querySelector(
        '.timer-active-item__display[data-timer-id="' + esc + '"]'
      );
      if (el) el.textContent = formatMs(now - t.startedAt);
    });
    timerRaf = requestAnimationFrame(timerLoop);
  }

  function ensureTimerLoop() {
    if (!timerRaf && activeTimers.length > 0) {
      timerRaf = requestAnimationFrame(timerLoop);
    }
  }

  function renderTimerList() {
    const ul = $("#timer-active-list");
    const empty = $("#timer-active-empty");
    if (!ul || !empty) return;

    ul.innerHTML = "";
    if (activeTimers.length === 0) {
      empty.classList.remove("hidden");
      stopTimerLoop();
      return;
    }
    empty.classList.add("hidden");
    const now = Date.now();

    activeTimers.forEach((t) => {
      const m = getMember(t.memberId);
      const actName = activityNameForEntry(t.activityId);
      const li = document.createElement("li");
      li.className = "timer-active-item";

      const info = document.createElement("div");
      info.className = "timer-active-item__info";
      const meta = document.createElement("div");
      meta.className = "timer-active-item__meta";
      meta.textContent = m ? m.name : "?";
      const actEl = document.createElement("div");
      actEl.className = "timer-active-item__activity";
      actEl.textContent = actName || "—";
      info.appendChild(meta);
      info.appendChild(actEl);

      const display = document.createElement("div");
      display.className = "timer-active-item__display";
      display.dataset.timerId = t.id;
      display.textContent = formatMs(now - t.startedAt);

      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "btn btn--danger btn--large";
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", () => stopTimerSession(t.id));

      li.appendChild(info);
      li.appendChild(display);
      li.appendChild(stopBtn);

      ul.appendChild(li);
    });

    ensureTimerLoop();
  }

  const dialogTimerSave = /** @type {HTMLDialogElement} */ ($("#dialog-timer-save"));

  /** @type {{ memberId: string, activityId: string, hours: number, date: string } | null} */
  let pendingTimerSave = null;

  $("#btn-timer-add").addEventListener("click", () => {
    const memberId = $("#timer-new-member").value;
    const activityId = $("#timer-new-activity").value;
    if (!memberId || !activityId) {
      showToast("Bitte Mitglied und Tätigkeit für den neuen Timer wählen.");
      return;
    }
    activeTimers.push({
      id: newId(),
      memberId,
      activityId,
      startedAt: Date.now(),
    });
    renderTimerList();
    showToast("Timer gestartet.");
  });

  function stopTimerSession(timerId) {
    const idx = activeTimers.findIndex((x) => x.id === timerId);
    if (idx < 0) return;
    const t = activeTimers[idx];
    activeTimers.splice(idx, 1);
    renderTimerList();

    const elapsedMs = Date.now() - t.startedAt;
    const hours = Math.round((elapsedMs / 3600000) * 100) / 100;
    const d = new Date();
    const dateStr =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");

    if (!t.memberId || !t.activityId || hours <= 0) {
      showToast("Timer zu kurz oder ungültig – kein Eintrag.");
      pendingTimerSave = null;
      return;
    }

    const m = getMember(t.memberId);
    const actName = activityNameForEntry(t.activityId);

    pendingTimerSave = {
      memberId: t.memberId,
      activityId: t.activityId,
      hours,
      date: dateStr,
    };

    $("#timer-save-summary").innerHTML =
      "<strong>Dauer:</strong> " +
      formatHours(hours) +
      " h<br>" +
      "<strong>Datum:</strong> " +
      escapeHtml(dateStr) +
      "<br>" +
      "<strong>Mitglied:</strong> " +
      escapeHtml(m ? m.name : "—") +
      "<br>" +
      "<strong>Tätigkeit:</strong> " +
      escapeHtml(actName || "—");

    dialogTimerSave.showModal();
  }

  $("#form-timer-save").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!pendingTimerSave) {
      dialogTimerSave.close();
      return;
    }
    const activityName = activityNameForEntry(pendingTimerSave.activityId);
    state.entries.push({
      id: newId(),
      memberId: pendingTimerSave.memberId,
      date: pendingTimerSave.date,
      activity: activityName,
      hours: pendingTimerSave.hours,
    });
    saveState();
    pendingTimerSave = null;
    dialogTimerSave.close();
    showToast("Timer-Eintrag gespeichert.");
    renderHome();
  });

  $("#dialog-timer-discard").addEventListener("click", () => {
    pendingTimerSave = null;
    dialogTimerSave.close();
  });

  dialogTimerSave.addEventListener("close", () => {
    pendingTimerSave = null;
  });

  // --- Filter & Export ---
  let lastFilteredEntries = [];

  function getFilteredEntries() {
    const mid = $("#filter-member").value;
    const act = $("#filter-activity").value;
    const from = $("#filter-date-from").value;
    const to = $("#filter-date-to").value;

    return state.entries.filter((e) => {
      if (mid && e.memberId !== mid) return false;
      if (act && e.activity !== act) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      return true;
    });
  }

  function renderFilterTable(entries) {
    const tbody = $("#filter-results-body");
    tbody.innerHTML = "";
    $("#filter-empty").classList.toggle("hidden", entries.length > 0);

    const sorted = [...entries].sort(
      (a, b) => b.date.localeCompare(a.date) || a.memberId.localeCompare(b.memberId)
    );

    sorted.forEach((e) => {
      const m = getMember(e.memberId);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(m ? m.name : "?")}</td>
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.activity)}</td>
        <td>${escapeHtml(formatHours(e.hours))}</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderFilterExport() {
    fillMemberSelects();
    fillActivitySelects();
    lastFilteredEntries = getFilteredEntries();
    renderFilterTable(lastFilteredEntries);
  }

  $("#form-filters").addEventListener("submit", (ev) => {
    ev.preventDefault();
    lastFilteredEntries = getFilteredEntries();
    renderFilterTable(lastFilteredEntries);
    showToast(lastFilteredEntries.length + " Einträge angezeigt.");
  });

  function rowsForExport(entries) {
    const header = ["Mitglied", "Datum", "Tätigkeit", "Stunden"];
    const lines = [header];
    const sorted = [...entries].sort(
      (a, b) => a.date.localeCompare(b.date) || (getMember(a.memberId)?.name || "").localeCompare(getMember(b.memberId)?.name || "")
    );
    sorted.forEach((e) => {
      const m = getMember(e.memberId);
      lines.push([
        m ? m.name : "",
        e.date,
        e.activity,
        String(e.hours).replace(".", ","),
      ]);
    });
    return lines;
  }

  /** CSV mit Semikolon und UTF-8 BOM für Excel (DE) */
  function exportCSV() {
    const lines = rowsForExport(lastFilteredEntries);
    const body = lines
      .map((row) =>
        row
          .map((cell) => {
            const s = String(cell);
            if (/[;\n\r"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
          })
          .join(";")
      )
      .join("\r\n");
    const bom = "\ufeff";
    downloadBlob(bom + body, "arbeitsstunden.csv", "text/csv;charset=utf-8");
    showToast("CSV heruntergeladen.");
  }

  /**
   * Excel-kompatibel: SpreadsheetML (XML), öffnet direkt in Excel
   * Keine externe Bibliothek nötig.
   */
  function exportExcelXml() {
    const lines = rowsForExport(lastFilteredEntries);
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    let rowsXml = "";
    lines.forEach((row, i) => {
      rowsXml += '<Row>\n';
      row.forEach((cell) => {
        rowsXml += `<Cell><Data ss:Type="String">${esc(cell)}</Data></Cell>\n`;
      });
      rowsXml += "</Row>\n";
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Stunden">
<Table>
${rowsXml}
</Table>
</Worksheet>
</Workbook>`;

    downloadBlob(xml, "arbeitsstunden.xls", "application/vnd.ms-excel");
    showToast("Excel-Datei heruntergeladen.");
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $("#btn-export-csv").addEventListener("click", () => {
    lastFilteredEntries = getFilteredEntries();
    renderFilterTable(lastFilteredEntries);
    exportCSV();
  });

  $("#btn-export-excel").addEventListener("click", () => {
    lastFilteredEntries = getFilteredEntries();
    renderFilterTable(lastFilteredEntries);
    exportExcelXml();
  });

  // --- Init: Firestore-Modul (ESM) laden, dann App starten ---
  function startApp() {
    applyTheme();
    fillMemberSelects();
    fillActivitySelects();
    fillTimerNewForm();
    parseHash();
  }

  function stubFirestore() {
    window.JCFirestore = {
      isReady: function () {
        return false;
      },
      submitMemberEntry: function () {
        return Promise.reject(new Error("Firestore-Modul nicht geladen."));
      },
      subscribePendingEntries: function (_onNext, onError) {
        if (onError) onError(new Error("Firestore-Modul nicht geladen."));
        return function () {};
      },
      setEntryStatus: function () {
        return Promise.reject(new Error("Firestore-Modul nicht geladen."));
      },
      approveEntry: function () {
        return Promise.resolve(false);
      },
    };
  }

  import("./firestore-service.js")
    .then(startApp)
    .catch(function (err) {
      console.error("[boot] firestore-service:", err);
      if (!window.JCFirestore) stubFirestore();
      startApp();
    });
})();
