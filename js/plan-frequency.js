// "How often" for a treatment: one control used on the master plan, in settings and in the consultation notes.
// Stored as weeks (what tracking uses) plus the unit staff chose, so "14 weeks" never turns into "3 months".
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WEEKS_PER_MONTH = 4.345;
const whole = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

// "w" or "m". Older entries have no unit: months only when the weeks are exactly a whole number of months (13, 26, 52…)
export const unitOf = (weeks, unit) => (unit === "m" || unit === "w" ? unit
  : weeks >= 13 && Math.round(Math.round(weeks / WEEKS_PER_MONTH) * WEEKS_PER_MONTH) === weeks ? "m" : "w");
export const toWeeks = (n, unit) => Math.min(520, unit === "m" ? Math.round(whole(n) * WEEKS_PER_MONTH) : whole(n));
// The number staff see: 26 weeks in months → 6
export const countOf = (weeks, unit) => (!weeks ? 0 : unitOf(weeks, unit) === "m" ? Math.max(1, Math.round(weeks / WEEKS_PER_MONTH)) : weeks);

// "1 every 4 weeks" · "1 every 6 months" · "1 every week" ("" without an interval)
export function everyText(weeks, unit) {
  if (!weeks) return "";
  const n = countOf(weeks, unit);
  const word = unitOf(weeks, unit) === "m" ? "month" : "week";
  return `1 every ${n === 1 ? "" : `${n} `}${word}${n === 1 ? "" : "s"}`;
}

const PATTERNS = [["course", "A course"], ["maintenance", "Ongoing"], ["once", "Once"], ["unknown", "Not set"]];
const QUICK = { w: [1, 2, 3, 4, 6, 8, 12, 16], m: [3, 6, 9, 12] };

// x = { pattern, sessions, intervalWeeks, intervalUnit }. Goes inside a <form>; then call mountFreq(form).
export function freqHtml(x = {}) {
  const pattern = PATTERNS.some(([v]) => v === x.pattern) ? x.pattern : "unknown";
  const unit = unitOf(x.intervalWeeks || 0, x.intervalUnit);
  const seg = (name, list, on) => list.map(([v, l]) =>
    `<label class="fe-seg-btn"><input type="radio" name="${name}" value="${v}"${v === on ? " checked" : ""} /><span>${l}</span></label>`).join("");
  return `<div class="fq" data-fq>
    <span class="lh-label">How often</span>
    <div class="fe-seg fq-pattern">${seg("pattern", PATTERNS, pattern)}</div>
    <div class="fq-line">
      <label class="fq-part" data-fq-sess><input name="sessions" type="number" min="1" max="52" step="1" inputmode="numeric"
        value="${esc(x.sessions || "")}" aria-label="Number of sessions" /><span>sessions,</span></label>
      <span class="fq-part" data-fq-every><span>1 every</span>
        <input name="interval" type="number" min="1" max="520" step="1" inputmode="numeric"
          value="${esc(countOf(x.intervalWeeks || 0, x.intervalUnit) || "")}" aria-label="How many weeks or months" />
        <span class="fe-seg fq-unit">${seg("iunit", [["w", "Weeks"], ["m", "Months"]], unit)}</span></span>
    </div>
    <div class="fq-quick" data-fq-quick></div>
    <p class="fq-sum" data-fq-sum aria-live="polite"></p>
  </div>`;
}

// → { read(), set(x), refresh() }. read() gives { pattern, sessions, intervalWeeks, intervalUnit } ready to save.
export function mountFreq(root) {
  const box = root.querySelector("[data-fq]");
  const f = box.closest("form").elements;
  const part = (k) => box.querySelector(`[data-fq-${k}]`);
  const unit = () => (f.iunit.value === "m" ? "m" : "w");

  function read() {
    const pattern = f.pattern.value || "unknown";
    const n = pattern === "once" ? 0 : whole(f.interval.value);
    return {
      pattern,
      sessions: pattern === "course" ? Math.min(52, whole(f.sessions.value)) : 0,
      intervalWeeks: toWeeks(n, unit()),
      intervalUnit: n ? unit() : "",
    };
  }

  function summary(v) {
    const every = everyText(v.intervalWeeks, v.intervalUnit);
    if (v.pattern === "once") return "One session.";
    if (v.pattern === "course") {
      if (!v.sessions) return "Enter how many sessions the course has.";
      const span = v.intervalWeeks * (v.sessions - 1);
      const long = !span ? "" : span < 9 ? `about ${span} week${span === 1 ? "" : "s"}` : `about ${Math.round(span / WEEKS_PER_MONTH)} months`;
      return `Course of ${v.sessions}${every ? `, ${every}` : ""}${long ? ` · ${long} from first to last` : ""}`;
    }
    if (v.pattern === "maintenance") return every ? `Ongoing, ${every}` : "Ongoing. Add how often to plan the next one.";
    return every ? `${every[0].toUpperCase()}${every.slice(1)}` : "No schedule yet. Sessions can be planned one at a time.";
  }

  function refresh() {
    const p = f.pattern.value;
    const u = unit();
    const n = whole(f.interval.value);
    part("sess").hidden = p !== "course";
    part("every").hidden = p === "once";
    part("quick").hidden = p === "once";
    part("quick").innerHTML = QUICK[u].map((q) => `<button type="button" class="fq-chip${q === n ? " is-on" : ""}" data-fq-n="${q}">${q} ${
      u === "m" ? "mth" : "wk"}${q === 1 ? "" : "s"}</button>`).join("");
    part("sum").textContent = summary(read());
  }

  function set(x = {}) {
    f.pattern.value = PATTERNS.some(([v]) => v === x.pattern) ? x.pattern : "unknown";
    f.sessions.value = x.sessions || "";
    f.iunit.value = unitOf(x.intervalWeeks || 0, x.intervalUnit);
    f.interval.value = countOf(x.intervalWeeks || 0, x.intervalUnit) || "";
    refresh();
  }

  box.addEventListener("input", refresh);
  box.addEventListener("change", refresh);
  box.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-fq-n]");
    if (!chip) return;
    f.interval.value = chip.dataset.fqN;
    refresh();
  });
  refresh();
  return { read, set, refresh };
}