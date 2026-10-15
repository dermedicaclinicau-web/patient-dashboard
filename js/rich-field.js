// Rich text answer: a formatted box staff type into on the live form (bold, lists, headings, links).
// Optional starting text with merge tags. Until staff start typing, it follows the tags (e.g. a specialist chosen above).
import { createRichEditor } from "./rich-editor.js";
import { cleanRichHtml, richText } from "./rich-html.js";
import { fillTagsHtml } from "./form-tags.js";

const MAX = 60000;

// saved given (even null): show a saved form. Otherwise: the live editor. tags: merge tag values to start with.
export function mountRichTextField(w, f, { saved, onChange = () => {}, tags = null } = {}) {
  const host = w && w.querySelector("[data-rt-host]");
  if (!host) return;
  if (saved !== undefined) {
    host.outerHTML = typeof saved === "string" && richText(saved)
      ? `<div class="fe-rich rt-view">${cleanRichHtml(saved)}</div>`
      : '<p class="fe-help">Not answered.</p>';
    return;
  }

  const ed = createRichEditor(host, { button: false });
  let edited = false;
  let lastStart = null;
  // Tags with no value yet stay as typed, so they can still fill in later
  const start = (vals) => {
    const html = f.starter ? fillTagsHtml(f.starter, vals || {}, null) : "";
    if (html === lastStart) return;
    lastStart = html;
    ed.setHtml(html);
  };
  start(tags);

  host.addEventListener("input", () => { edited = true; onChange(); });

  w.rtRead = () => {
    const html = ed.getHtml();
    return richText(html) ? cleanRichHtml(html).slice(0, MAX) : "";
  };
  w.rtWrite = (v) => {
    if (typeof v !== "string" || !v) return;
    edited = true;
    ed.setHtml(v);
  };
  // Answers above changed (e.g. a specialist chosen): the starting text follows, until staff start typing
  w.rtRetag = (vals) => { if (!edited) start(vals); };
}