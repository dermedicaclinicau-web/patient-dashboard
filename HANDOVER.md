Dermedica Staff Portal: Handover Summary
Project
What it is: Dermedica Staff Portal, built with GitHub Pages, Firebase (Firestore, Auth, Storage) and Google Apps Script.
Live URL: https://dermedicaclinicau-web.github.io/patient-dashboard/
Repo: https://github.com/dermedicaclinicau-web/patient-dashboard
Local path: C:\Users\Bethany\patient-dashboard
Deploy: .\deploy.ps1 "description" from the local path
Firebase project: disco-serenity-428708-t8
How it works:
Pages are reached by the part of the address after # (#/page/param).
Login uses a PIN. Apps Script returns a Firebase custom token with staffRole, perms and injector, plus a session code for Apps Script calls.
Permissions come from PERMS_ in Code.gs ([key, group, label]). The browser checks them with can() and isAdmin() in perms.js, and the Firestore rules check them with can().
Completed in earlier sessions
Patients: Patient List, patient dashboard (pre-consultation, past appointments with record badges, "No Tx Record" warning), and merging with undo.
Consultations: recording, transcription, SOAP notes, regenerate, delete, Recording rules, and treatment info emails.
Treatment plans: master plan, consultation plans, progress tracking, Service→concern links (with AI suggestions), downtime warnings, and the patient copy.
Forms and documents: Form Builder, Image Bank, Aftercare Bank, letterhead, and email or print PDFs.
Skin Script Protocols.
Task Manager: scheduled tasks, To Print, and the opening count.
Inventory:
Stock, Kits, Investigations, Requests, Receive delivery, Purchase orders, Products, Service links, Suppliers, Activity and Notifications.
Shared (opened) products, starting stock, and bulk actions.
Opening count with walking order, category filters, Arrange order and Save-and-finish-later.
Scanner: billing sheets (sale off the Shelf, booking match) and delivery dockets (editable qty, batch and expiry; batch and expiry only for tracked products; keyboard-safe on iPad).
Reporting: Count differences (plus starting stock), Investigations, Not recorded, Wastage, Kit reconciliation, Usage, Opened containers, Saved short, Treatment plans, and Start & end of day.
Daily check-ins: Start / End of Day (kit counts, overnight check, mood and questions) and My dashboard (customisable cards).
Chat: Help to Admins with an email after 10 minutes, direct messages, groups, and Away mode.
Staff: roles and access matrix, per-person exceptions, photos, registration numbers, and the activity log.
System configuration: Recording rules, Treatment plan settings, and Wording.
Help & how-to page (knowledge-content.js).
Completed this session
Purchase orders:
Backdating: order date and sent date.
Searchable product picker.
Already received (before the portal): recorded only, no stock change.
Scanner access ticks:
PERMS_ in Code.gs has new keys: menu.scanner, scanner.billing, scanner.docket and inventory.history.
perms.js, app.js (PAGE_PERM scanner) and scanner.js (only the allowed tabs) are updated.
scannerAction_ in Code.gs checks the permissions.
grantScannerAccess() was run once so existing roles kept the Scanner.
Bug fixes in inventory.js: the product window's supplier lines, and the orders list wording.
Help page: knowledge-content.js rewritten, with new Scanner and System configuration sections. Remaining // CHECK items:
where the Merge button is
the plan Email/Print button names
the Treatment Info draft button
where Aftercare is opened from
the Skin Script products page name
the button from docket scan to Receive delivery
Supplier PO email template:
cleanSupplier now stores emailSubject and emailBody.
inventory-api.js has PO_EMAIL_TAGS, PO_ORDER_TAG_RE and fillPoTemplate().
The supplier editor (editSupplier in inventory.js) was redesigned: two columns, live preview, Active switch, insert buttons, and password-manager blocking (Company field renamed to company).
The {Order table} placeholder puts the order table at that spot in the email. Without it, the table goes after the message.
sendDialog in purchase-order.js fills the subject and message from the template, starts the sign-off empty when there's a template, and places the table.
Overview documents for the boss and team: a full overview by section, an executive summary, and "Why it matters" lines.
Check these were applied before closing
inventory.js → editSupplier: the last line is f.company.focus(); (not f.name).
purchase-order.js → sendDialog:
the orderwhere and orderlabel wording (data-role)
the syncWhere input listener after editor.setHtml(message)
Firestore inv_pos: historicalOk() and adminPastReceipt() use can('inventory.history'), not isAdmin().
CSS for the supplier editor:
.sup-dlg, .sup-*, .sup-pv-*
.sup-pv-order[hidden]
the {Order table} chip style
the old .inv-emailtpl rules removed
Firestore rules (current state)
scans: create needs scanner.billing or scanner.docket to match the scan's kind.
inv_receipts: create needs invReceive() || can('inventory.history').
inv_sales: create needs invUse().
inv_suppliers: only checks the name, so the template fields need no rule change.
Optional tidy-up: in ssp_records, change the misleading allow update, delete: if false; to allow delete: if false;.
Script Properties (Apps Script)
GEMINI_API_KEY
GEMINI_MODEL (optional, defaults to gemini-2.5-flash)
SCAN_THINKING (optional, defaults to 0)
Still to set: PA_TX_CHECK_FROM. In patient-dashboard.js it's currently a constant, "2026-07-01".
Pending / next
Help page: add a guide for supplier email templates and {Order table}, and resolve the // CHECK items.
Opening in new tabs:
Check auth.js. If the Apps Script session is kept in sessionStorage, move it to localStorage.
Turn clickable rows into real links (patient list first).
Only one tab should play the chat chime and record.
Marking Sets (part of the Form Builder, stored in form_settings/marking_sets): describe it for the overview.
Wire billing-scans.js into the patient dashboard (renderBillingScans(bodyEl, { pttId, name })).
Inventory → Scans and Sales tab: today's scans with photos, flagged ones, and Undo.
Show sales saved short in Reporting → Saved short.
Checkout (POS) screen using recordSale.
Delivery docket scanner: try the Claude API instead of Gemini (scanDocket_ in Code.gs).
Docket freebies: a "Free, not ordered" option, added as found stock.
Optional: a clinic-wide default PO email template, for suppliers without their own.
Optional: let the Start & end of day report be read by people with menu.reports (the inv_kitdays rule).
Other ideas: SMS, Ctrl+K quick patient search, import the old SSP_NEW history, and duplicate a Skin Script for another patient.
Key files
File	Purpose
js/app.js	Router, PAGE_PERM, login handling
js/perms.js	PERM_KEYS, can(), isAdmin(), refreshing access
js/inventory.js	Inventory tabs, product and supplier editors
js/inventory-api.js	All inventory data functions, PO template helpers
js/purchase-order.js	PO editor, send dialog, Already received
js/receive-po.js, js/po-deliveries.js	Receiving deliveries, delivery history
js/scanner.js, js/scanner-api.js, js/scanner-docket.js	Scanner
js/staff-manager.js	Staff, Roles & access
js/knowledge-content.js	Help page wording
js/reports.js, js/my-dashboard.js, js/start-of-day.js, js/chat.js	Reporting, dashboard, day check-in, chat
Code.gs	Apps Script: login, PERMS_, emails, scanner, notifications, syncs