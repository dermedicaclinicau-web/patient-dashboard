// Date blanks for previews and the Recall compose window: {Today}, {Today + 30 days}, {Today + 2 weeks}, {Today + 3 months}.
// The same as flowDateTokens_ in Code.gs, which fills them in when flow messages are sent.
const SP = "(?:\\s|&nbsp;|\\u00a0)*";
const RE = new RegExp(`\\{${SP}today${SP}(?:([+-])${SP}(\\d{1,4})${SP}(days?|weeks?|months?|years?)?)?${SP}\\}`, "gi");

export function fillDateTokens(s) {
  if (s === null || s === undefined) return s;
  return String(s).replace(RE, (all, sign, num, unit) => {
    let n = num ? Number(num) : 0;
    if (sign === "-") n = -n;
    const u = String(unit || "days").toLowerCase();
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    if (/^day/.test(u)) d.setDate(d.getDate() + n);
    else if (/^week/.test(u)) d.setDate(d.getDate() + 7 * n);
    else {
      const months = /^year/.test(u) ? 12 * n : n;
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + months);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    }
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  });
}

// The "Add a date" control under the blanks
export const dateInsertHtml = () => `<div class="ef-dateins">
  <span>Add a date: today +</span>
  <input class="fe-input" type="number" min="0" max="999" step="1" value="30" data-di="n" aria-label="How many" />
  <select class="fb-select" data-di="u" aria-label="Days, weeks or months">
    <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select>
  <button type="button" class="lh-btn is-quiet" data-act="date-ins">Insert</button>
</div>`;
export function dateInsertName(box) {
  const n = Math.max(0, Math.min(999, Math.floor(Number(box.querySelector('[data-di="n"]').value) || 0)));
  const u = box.querySelector('[data-di="u"]').value;
  return n ? `Today + ${n} ${n === 1 ? u.replace(/s$/, "") : u}` : "Today";
}