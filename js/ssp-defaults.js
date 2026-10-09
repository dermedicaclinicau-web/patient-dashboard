// Skin Script defaults: the starting design for the PDF, the wording and the email.
import { SSP_STEPS } from "./ssp-products-api.js";

export const FONTS = {
  Arial: "Arial, Helvetica, sans-serif",
  Helvetica: "Helvetica, Arial, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  Verdana: "Verdana, Geneva, sans-serif",
  "Trebuchet MS": "'Trebuchet MS', Arial, sans-serif",
};

export const PDF_DEFAULTS = {
  title: "Skin Script Protocol",
  titleSize: 17,
  titleColor: "#0f172a",
  font: "Arial",
  fontSize: 10,
  accent: "#0f766e",
  headerBg: "#f4f2ed",
  logo: "right",
  logoSize: 40,
  morning: "Morning",
  evening: "Evening",
  icons: true,
  showPatient: true,
  showRecordDate: true,
  showValidUntil: true,
  showSize: false,
  showWhen: true,
  stepColours: true,
  footer: "",
  steps: Object.fromEntries(SSP_STEPS.map((s) => [s.key, { label: s.label, sub: s.sub, tone: s.tone, ink: s.ink }])),
};

export const CLOSING_TEXT = [
  "This Skin Script Protocol is valid until {Valid until}.",
  "Dr. Teh will then provide you with a personalised skin assessment to ensure your skin health is on track.",
  "For all other questions on the above protocol, please do not hesitate to let us know.",
  "Visit our Online shop should you wish to purchase any of the above items: www.dermedica.com.au/online-store",
].join("\n");

export const CLOSING_HTML =
  "<p>This Skin Script Protocol is valid until {Valid until}.</p>" +
  "<p>Dr. Teh will then provide you with a personalised skin assessment to ensure your skin health is on track.</p>" +
  "<p>For all other questions on the above protocol, please do not hesitate to let us know.</p>" +
  '<p>Visit our Online shop should you wish to purchase any of the above items: ' +
  '<a href="https://www.dermedica.com.au/online-store">www.dermedica.com.au/online-store</a></p>';

export const EMAIL_SUBJECT = "Your Skin Script Protocol - Dermedica";
export const EMAIL_HTML =
  "<p>Hi {First name},</p><p>Please find attached your Skin Script Protocol, valid until {Valid until}.</p>" +
  "<p>If you have any questions, just reply to this email or call us on {Clinic phone}.</p>" +
  "<p>Kind regards,<br>{Staff name}<br>Dermedica</p>";

export const SSP_DEFAULTS = {
  validMonths: 3,
  closing: CLOSING_TEXT,
  closingHtml: CLOSING_HTML,
  signature: "Best Regards,\nDr Joanna Teh and the Team",
  emailTemplate: "",
  emailSource: "custom",
  emailSubject: EMAIL_SUBJECT,
  emailHtml: EMAIL_HTML,
  emailStyle: { background: "#f1f5f9", accent: "#0f766e" },
  pdf: PDF_DEFAULTS,
};