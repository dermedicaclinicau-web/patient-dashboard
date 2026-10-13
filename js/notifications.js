// Inventory → Notifications: "when X happens, email these people" rules and regular digests.
import { INV_CATEGORIES, catLabel, getCountSettings, COUNT_DUE_DEFAULT } from "./inventory-api.js";
import {
  NOTIFY_EVENTS, DIGEST_SECTIONS, listRules, saveRule, deleteRule, setRuleEnabled, listNotifyLog, testRule,
} from "./notify-api.js";
import { fetchStaffList } from "./task-types.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SKELETON = '<div class="skeleton" style="height:260px;border-radius:14px"></div>';
// An event this version doesn't know is kept as it is (never quietly changed to the first one)
const eventOf = (k) => NOTIFY_EVENTS.find((e) => e.key === k)
  || { key: k, label: `Unknown event (${k || "none"})`, conds: [], involved: "", unknown: true };
const timeText = (t) => {
  const [h, m] = String(t || "08:00").split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
const errText = (err, fb) => (err && err.code === "permission-denied"
  ? "You don't have access. Check the Notifications Firestore rules have been published."
  : err && err.message && !err.code ? err.message : fb);

export async function renderNotifications(body, { staff }) {
  body.innerHTML = SKELETON;
  let rules = [];
  let staffList = [];
  let log = [];
  let dueBy = COUNT_DUE_DEFAULT;
  const nameOf = (id) => (staffList.find((s) => s.id === id) || {}).name || "Unknown staff";
  const roles = () => [...new Set(["Admin", "Clinician", "Reception", ...staffList.map((s) => s.role).filter(Boolean)])];

  async function load() {
    try {
      let cfg;
      [rules, staffList, log, cfg] = await Promise.all([
        listRules(), fetchStaffList().catch(() => []), listNotifyLog(40).catch(() => []),
        getCountSettings().catch(() => ({ dueBy: COUNT_DUE_DEFAULT })),
      ]);
      dueBy = cfg.dueBy;
      if (body.isConnected) draw();
    } catch (err) {
      console.error("Notifications failed:", err);
      if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the notifications."))}</div>`;
    }
  }

  /* ---------- Plain-words summaries ---------- */
  const whenText = (r) => {
    if (r.kind !== "digest") {
      return r.event === "count.overdue" ? `${eventOf(r.event).label} (${timeText(dueBy)})` : eventOf(r.event).label;
    }
    const t = timeText(r.schedule.time);
    return r.schedule.freq === "weekly" ? `Every ${DAYS[r.schedule.day]} at ${t}`
      : r.schedule.freq === "weekdays" ? `Weekdays at ${t}` : `Every day at ${t}`;
  };
  const condText = (r) => {
    const c = r.conditions;
    const allowed = r.kind === "digest" ? ["categories"] : eventOf(r.event).conds;
    return [
      allowed.includes("urgentOnly") && c.urgentOnly && "Urgent requests only",
      allowed.includes("loc") && c.loc !== "any" && (c.loc === "jt" ? "JT storage only" : "Shelf only"),
      allowed.includes("categories") && c.categories.length && c.categories.map(catLabel).join(", "),
      allowed.includes("statuses") && c.statuses.length === 1 && (c.statuses[0] === "ordered" ? "Ordered only" : "Declined only"),
    ].filter(Boolean).join(" · ");
  };
  const toText = (r) => {
    const rc = r.recipients;
    return [
      rc.involved && eventOf(r.event).involved,
      ...rc.staffIds.map(nameOf),
      ...rc.roles.map((x) => `everyone in ${x}`),
      ...rc.emails,
    ].filter(Boolean).join(", ") || "Nobody yet";
  };

  function draw() {
    body.innerHTML = `
      <div class="inv-tools">
        <p class="muted nt-intro">Emails sent automatically when something happens, or as a regular digest. Turn rules on and off at any time.</p>
        <span class="inv-spacer"></span>
        <button type="button" class="btn-primary" data-nt="new">+ New rule</button>
      </div>
      ${rules.length ? `<div class="nt-rules">${rules.map((r) => {
        const conds = condText(r);
        return `
          <article class="nt-rule${r.enabled ? "" : " is-off"}">
            <div class="nt-rule-head">
              <label class="nt-switch" title="${r.enabled ? "On" : "Off"}"><input type="checkbox" data-nt-toggle="${esc(r.id)}"${r.enabled ? " checked" : ""} aria-label="Turn ${esc(r.name)} on or off" /><span></span></label>
              <strong>${esc(r.name)}</strong>
              <span class="inv-flag ${r.kind === "digest" ? "is-info" : "is-ok"}">${r.kind === "digest" ? "Digest" : "Alert"}</span>
              <span class="inv-spacer"></span>
              <button type="button" class="lh-btn" data-nt-test="${esc(r.id)}">Send test to me</button>
              <button type="button" class="lh-btn" data-nt-edit="${esc(r.id)}">Edit</button>
              <button type="button" class="ib-tool is-danger" data-nt-del="${esc(r.id)}" aria-label="Delete" title="Delete">×</button>
            </div>
            <dl class="nt-dl">
              <dt>When</dt><dd>${esc(whenText(r))}</dd>
              ${conds ? `<dt>Only if</dt><dd>${esc(conds)}</dd>` : ""}
              ${r.kind === "digest" ? `<dt>Includes</dt><dd>${esc(DIGEST_SECTIONS.filter(([k]) => r.sections[k]).map(([, l]) => l).join(", "))}</dd>` : ""}
              <dt>Sends to</dt><dd>${esc(toText(r))}</dd>
            </dl>
          </article>`;
      }).join("")}</div>`
        : '<div class="tm-empty">No rules yet. The starter rules are created automatically the first time Apps Script runs, or add your own with <strong>+ New rule</strong>.</div>'}
      <section class="tb-card nt-log">
        <h4>Recent emails</h4>
        ${log.length ? `<div class="rp-scroll"><table class="inv-table">
          <thead><tr><th>When</th><th>Rule</th><th>Subject</th><th>Sent to</th></tr></thead>
          <tbody>${log.map((l) => `<tr><td>${esc(when(l.at))}</td><td>${esc(l.ruleName || "")}</td><td>${esc(l.subject || "")}</td>
            <td>${esc((l.to || []).join(", "))}</td></tr>`).join("")}</tbody></table></div>`
          : '<p class="tb-none">Nothing sent yet.</p>'}
      </section>`;
  }

  /* ---------- The rule editor ---------- */
  function editRule(rule) {
    const isNew = !rule;
    const r = rule || {
      name: "", kind: "event", event: "request.created", enabled: true, message: "",
      conditions: { urgentOnly: false, loc: "any", categories: [], statuses: [] },
      recipients: { involved: true, staffIds: [], roles: [], emails: [], skipActor: true },
      schedule: { freq: "weekly", day: 1, time: "08:00" },
      sections: { low: true, expiring: true, requests: true, deliveries: true, counts: true, short: true, loans: false },
      expiringDays: 60, skipEmpty: true,
    };
    const ck = (on) => (on ? " checked" : "");
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg nt-dlg";
    dlg.innerHTML = `
      <form class="lh-form nt-form" novalidate>
        <div class="lh-dialog-head"><h3>${isNew ? "New notification rule" : `Edit ${esc(r.name)}`}</h3>
          <p>Emails are sent from the clinic's address, in the same design as the portal's other emails.</p></div>

        <label class="lh-field"><span class="lh-label">Name</span>
          <input name="name" maxlength="100" placeholder="e.g. Weekly stock summary for Dr Teh" value="${esc(r.name)}" /></label>

        <div class="lh-field"><span class="lh-label">Type</span>
          <div class="fe-seg">
            <label class="fe-seg-btn"><input type="radio" name="kind" value="event"${ck(r.kind !== "digest")} /><span>Alert: when something happens</span></label>
            <label class="fe-seg-btn"><input type="radio" name="kind" value="digest"${ck(r.kind === "digest")} /><span>Digest: a regular summary</span></label>
          </div></div>

        <div data-show="event">
          <label class="lh-field"><span class="lh-label">When</span>
            <select class="fb-select" name="event">${(NOTIFY_EVENTS.some((e) => e.key === r.event) ? NOTIFY_EVENTS : [eventOf(r.event), ...NOTIFY_EVENTS]).map((e) =>
              `<option value="${esc(e.key)}"${r.event === e.key ? " selected" : ""}>${esc(e.label)}</option>`).join("")}</select></label>
            ${r.event === "stock.low" || isNew ? '<small class="fe-note" data-role="lowhint">Low stock is checked every hour. Each product alerts once when it drops to its reorder level, and again only after it\'s been restocked.</small>' : ""}
          <small class="fe-note" data-role="counthint">Checked once a day at ${esc(timeText(dueBy))}, the due-by time set in
            Task Manager → Opening count (Manage inventory can change it there). Only sent on days with appointments when the clinic isn't closed,
            and lists what's still to count.</small>
            </div>

        <div data-show="digest">
          <div class="inv-two">
            <label class="lh-field"><span class="lh-label">How often</span>
              <select class="fb-select" name="freq">${[["daily", "Every day"], ["weekdays", "Weekdays (Mon–Fri)"], ["weekly", "Once a week"]].map(([v, l]) =>
                `<option value="${v}"${r.schedule.freq === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
            <label class="lh-field" data-role="dayrow"><span class="lh-label">On</span>
              <select class="fb-select" name="day">${[1, 2, 3, 4, 5, 6, 0].map((d) =>
                `<option value="${d}"${Number(r.schedule.day) === d ? " selected" : ""}>${DAYS[d]}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">At (Perth time)</span>
              <input type="time" name="time" step="900" value="${esc(r.schedule.time)}" /></label>
          </div>
          <div class="lh-field"><span class="lh-label">Include</span>
            <div class="nt-checks">${DIGEST_SECTIONS.map(([k, l]) =>
              `<label class="fe-check"><input type="checkbox" name="sec" value="${k}"${ck(r.sections[k])} /> ${esc(l)}</label>`).join("")}</div></div>
          <label class="lh-field nt-days"><span class="lh-label">"Expiring soon" means within</span>
            <span class="nt-inline"><input type="number" name="expiringDays" min="7" max="180" value="${r.expiringDays}" /> days</span></label>
          <label class="fe-check"><input type="checkbox" name="skipEmpty"${ck(r.skipEmpty)} /> Don't send it when there's nothing to report</label>
        </div>

        <fieldset class="nt-box" data-role="conds"><legend>Only if (optional)</legend>
          <label class="fe-check" data-cond="urgentOnly"><input type="checkbox" name="urgentOnly"${ck(r.conditions.urgentOnly)} /> The request is urgent</label>
          <label class="lh-field" data-cond="loc"><span class="lh-label">Storage</span>
            <select class="fb-select" name="loc">${[["any", "Shelf or JT storage"], ["shelf", "Shelf only"], ["jt", "JT storage only"]].map(([v, l]) =>
              `<option value="${v}"${r.conditions.loc === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <div class="lh-field" data-cond="categories"><span class="lh-label">Categories <small class="muted">(none ticked = all)</small></span>
            <div class="nt-checks">${INV_CATEGORIES.map((c) =>
              `<label class="fe-check"><input type="checkbox" name="cat" value="${c.key}"${ck(r.conditions.categories.includes(c.key))} /> ${esc(c.label)}</label>`).join("")}</div></div>
          <div class="lh-field" data-cond="statuses"><span class="lh-label">Send when it's</span>
            <div class="nt-checks">${[["ordered", "Ordered"], ["declined", "Declined"]].map(([v, l]) =>
              `<label class="fe-check"><input type="checkbox" name="status" value="${v}"${ck(!r.conditions.statuses.length || r.conditions.statuses.includes(v))} /> ${l}</label>`).join("")}</div></div>
        </fieldset>

        <fieldset class="nt-box"><legend>Send to</legend>
          <label class="fe-check" data-role="involved"><input type="checkbox" name="involved"${ck(r.recipients.involved)} /> <span data-role="involvedlbl"></span></label>
          <div class="lh-field"><span class="lh-label">Staff</span>
            <input type="search" class="fe-input inv-supfind" data-role="staffind" placeholder="Search staff" autocomplete="off" />
            <div class="inv-supticks nt-staff">${staffList.map((s) => `
              <label class="fe-check" data-find="${esc(s.name.toLowerCase())}"><input type="checkbox" name="sid" value="${esc(s.id)}"${ck(r.recipients.staffIds.includes(s.id))}${s.hasEmail ? "" : " disabled"} />
                ${esc(s.name)} <small class="muted">${esc(s.role || "")}${s.hasEmail ? "" : " · no email on file"}</small></label>`).join("")}</div></div>
          <div class="lh-field"><span class="lh-label">Everyone in a role</span>
            <div class="nt-checks">${roles().map((x) =>
              `<label class="fe-check"><input type="checkbox" name="role" value="${esc(x)}"${ck(r.recipients.roles.includes(x))} /> ${esc(x)}</label>`).join("")}</div></div>
          <label class="lh-field"><span class="lh-label">Other email addresses (optional)</span>
            <textarea name="emails" rows="2" placeholder="One per line, e.g. accounts@dermedica.com.au">${esc(r.recipients.emails.join("\n"))}</textarea></label>
          <label class="fe-check" data-show="event"><input type="checkbox" name="skipActor"${ck(r.recipients.skipActor)} /> Don't email the person who did it (unless they're one of the people involved)</label>
        </fieldset>

        <label class="lh-field"><span class="lh-label">Message at the top of the email (optional)</span>
          <textarea name="message" rows="2" maxlength="1000" placeholder="e.g. Please check the JT storage too before ordering.">${esc(r.message)}</textarea></label>
        <label class="fe-check"><input type="checkbox" name="enabled"${ck(r.enabled)} /> On</label>

        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${isNew ? "Add rule" : "Save"}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const form = dlg.querySelector("form");
    const f = form.elements;
    const err = dlg.querySelector(".lh-error");

    // Shows only what applies to the chosen type and event
    const sync = () => {
      const kind = form.querySelector('[name="kind"]:checked').value;
      const ev = eventOf(f.event.value);
      dlg.querySelectorAll("[data-show]").forEach((el) => { el.hidden = el.dataset.show !== kind; });
      const conds = kind === "digest" ? ["categories"] : ev.conds;
      dlg.querySelectorAll("[data-cond]").forEach((el) => { el.hidden = !conds.includes(el.dataset.cond); });
      dlg.querySelector('[data-role="conds"]').hidden = !conds.length;
      dlg.querySelector('[data-role="involved"]').hidden = kind === "digest" || !ev.involved;
      dlg.querySelector('[data-role="involvedlbl"]').textContent = ev.involved;
      dlg.querySelector('[data-role="dayrow"]').hidden = f.freq.value !== "weekly";
      const hint = dlg.querySelector('[data-role="lowhint"]');
      if (hint) hint.hidden = f.event.value !== "stock.low";
      const ch = dlg.querySelector('[data-role="counthint"]');
      if (ch) ch.hidden = f.event.value !== "count.overdue";
    };
    sync();
    form.addEventListener("change", sync);
    dlg.querySelector('[data-role="staffind"]').addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      dlg.querySelectorAll(".nt-staff [data-find]").forEach((row) => {
        row.hidden = !!q && !row.dataset.find.includes(q) && !row.querySelector("input").checked;
      });
    });
    dlg.querySelector('[data-role="staffind"]').addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());

    const ticked = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map((x) => x.value);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (form.querySelector('[name="kind"]:checked').value === "event" && eventOf(f.event.value).unknown) {
        err.textContent = "This rule's event isn't available in this version of the portal. Choose another event, or refresh the page.";
        err.hidden = false;
        return;
      }
      const kind = form.querySelector('[name="kind"]:checked').value;
      const secs = new Set(ticked("sec"));
      const statuses = ticked("status");
      const data = {
        name: f.name.value, kind, event: f.event.value, enabled: f.enabled.checked, message: f.message.value,
        conditions: {
          urgentOnly: f.urgentOnly.checked, loc: f.loc.value, categories: ticked("cat"),
          statuses: statuses.length === 2 ? [] : statuses,
        },
        recipients: {
          involved: f.involved.checked, staffIds: ticked("sid"), roles: ticked("role"),
          emails: f.emails.value.split(/[\s,;]+/).filter(Boolean), skipActor: f.skipActor.checked,
        },
        schedule: { freq: f.freq.value, day: f.day.value, time: f.time.value },
        sections: Object.fromEntries(DIGEST_SECTIONS.map(([k]) => [k, secs.has(k)])),
        expiringDays: f.expiringDays.value, skipEmpty: f.skipEmpty.checked,
      };
      if (kind === "event" && eventOf(data.event).conds.includes("statuses") && !statuses.length) {
        err.textContent = "Tick Ordered, Declined or both."; err.hidden = false; return;
      }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await saveRule(rule ? rule.id : "", data, staff);
        dlg.close();
        showToast(isNew ? "Rule added" : "Rule saved");
        load();
      } catch (ex) {
        console.error("Save rule failed:", ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    f.name.focus();
  }

  /* ---------- Clicks ---------- */
  body.addEventListener("click", async (e) => {
    if (e.target.closest('[data-nt="new"]')) { editRule(null); return; }
    const ed = e.target.closest("[data-nt-edit]");
    if (ed) { const r = rules.find((x) => x.id === ed.dataset.ntEdit); if (r) editRule(r); return; }
    const del = e.target.closest("[data-nt-del]");
    if (del) {
      const r = rules.find((x) => x.id === del.dataset.ntDel);
      if (!r || !(await confirmDialog({ title: `Delete "${r.name}"?`, message: "It stops sending straight away. Emails already sent stay in the log.", confirmLabel: "Delete", tone: "danger" }))) return;
      try { await deleteRule(r.id); showToast("Rule deleted"); load(); }
      catch (ex) { console.error(ex); showToast(errText(ex, "Couldn't delete. Try again.")); }
      return;
    }
    const ts = e.target.closest("[data-nt-test]");
    if (ts) {
      ts.disabled = true;
      ts.textContent = "Sending…";
      try {
        const res = await testRule(ts.dataset.ntTest);
        showToast(`Test sent to ${res.to}`);
      } catch (ex) {
        console.error("Test failed:", ex);
        showToast(ex && ex.code === "NO_EMAIL" ? "Your staff record has no email address. Add one in Staff."
          : ex && ex.code === "FORBIDDEN" ? "Only Manage inventory can send tests." : "Couldn't send the test. Check Apps Script → Executions.");
      }
      ts.disabled = false;
      ts.textContent = "Send test to me";
    }
  });
  body.addEventListener("change", async (e) => {
    const tg = e.target.closest("[data-nt-toggle]");
    if (!tg) return;
    try {
      await setRuleEnabled(tg.dataset.ntToggle, tg.checked, staff);
      const r = rules.find((x) => x.id === tg.dataset.ntToggle);
      if (r) r.enabled = tg.checked;
      tg.closest(".nt-rule").classList.toggle("is-off", !tg.checked);
      showToast(tg.checked ? "Rule turned on" : "Rule turned off");
    } catch (ex) {
      console.error(ex);
      tg.checked = !tg.checked;
      showToast(errText(ex, "Couldn't change it. Try again."));
    }
  });

  load();
}