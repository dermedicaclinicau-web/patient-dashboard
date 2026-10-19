// Help & how-to: the wording. Plain English, no technical terms.
// Each section and guide shows only to staff who can use it:
//   need: ["perm", ...]  → shown if they have ANY of these
//   admin: true          → Admins only
//   injector: true       → injectors (and Admins) only
// Formatting: **bold** for buttons, [text](#/page) for links into the portal.
// "// CHECK" = button name not yet confirmed against the screen. Check it and adjust the wording if needed.

export const GUIDE = [
  {
    id: "start", title: "Getting started", icon: "👋",
    intro: "The basics: logging in, your photo, and keeping the portal safe.",
    topics: [
      { id: "login", q: "Logging in", steps: [
        "Open the portal and type your PIN.",
        "You'll see only the menus your role uses. If something you need is missing, ask an Admin.",
      ], tips: [
        "Too many wrong PINs locks logins for 15 minutes. An Admin can unlock them sooner.",
        "A **Refresh** bar at the top means a new version of the portal is ready. Press it when you're at a good stopping point.",
      ] },
      { id: "logout", q: "Logging out on a shared computer", steps: [
        "Click your name in the top bar, then **Log out**.",
        "Always log out when you walk away from a shared computer. If you forget, you're logged out automatically after a few hours.",
      ] },
      { id: "photo", q: "Changing your photo", steps: [
        "Click your name or photo in the top bar, then **My photo**.",
        "Press **Upload photo** (or **Take photo** on a phone or iPad).",
        "It's cropped to a square and saved straight away. **Remove photo** goes back to your initials.",
      ] },
      { id: "name", q: "Changing how your name shows", steps: [
        "Click your name in the top bar, then **Edit my name**, and save.",
      ] },
      { id: "pin", q: "Forgot your PIN?", steps: [
        "Ask an Admin. They can give you a new one in Staff. Your old PIN stops working straight away.",
      ] },
    ],
  },

  {
    id: "chat", title: "Chat and getting help", icon: "💬",
    intro: "Message the Admins for help, message a colleague, or chat as a group.",
    topics: [
      { id: "help", q: "Asking for help", steps: [
        "Open Chat (the round button at the bottom right) and choose **Help** at the top of the list.",
        "Type your question and press Enter to send. Every Admin can see and answer it.",
        "**Include a link to this page** is ticked for you, so the Admin can go straight to what you're looking at.",
        "If nobody reads it within about 10 minutes, the Admins are emailed.",
      ], tips: [
        "If an Admin is away, you'll see when they're back at the top of your Help chat.",
        "Shift + Enter starts a new line without sending.",
      ] },
      { id: "dm", q: "Messaging a colleague", steps: [
        "In Chat, press **New message** and choose the person.",
        "Only the two of you can see the conversation (and the clinic's Admins).",
      ] },
      { id: "group", q: "Starting a group chat", steps: [
        "In Chat, press **New message**, then **New group**.",
        "Give it a name and tick the people to include. The role buttons (and **Injectors**) tick everyone in that group at once. Tap again to untick them.",
        "Press **Create group**, then send the first message.",
      ], tips: ["Who's in a group is set when it's made. To change it, start a new group."] },
      { id: "alerts", q: "Sounds and alerts", steps: [
        "New messages chime, pop up, and show a red number on the Chat button.",
        "The bell at the top of Chat turns the sound on or off.",
        "**Turn on desktop alerts** lets you see new messages even when the portal is in another tab.",
      ] },
      { id: "away", q: "Setting yourself as away (Admins)", admin: true, steps: [
        "In Chat, press **Set away** at the top of the list.",
        "Press **Back tomorrow** or **Back Monday**, or choose a date. Add a note if you like, e.g. \"Urgent? Ask Dr Teh\".",
        "Staff see that you're away in their Help chat, and reminder emails pause.",
        "It switches off by itself on your back date, or press **I'm back**.",
      ] },
      { id: "inbox", q: "Answering help requests (Admins)", admin: true, steps: [
        "Help requests are listed under **Help inbox** in Chat.",
        "Reply as normal. When it's dealt with, press **Mark as sorted**. **Reopen** brings it back.",
        "**All staff chats** shows conversations between other staff. You can read them, but only they can reply.",
      ] },
    ],
  },

  {
    id: "dashboard", title: "My dashboard", icon: "🏠",
    need: ["dash.attention", "dash.appts", "dash.tasks", "dash.kit", "dash.records", "dash.usage", "dash.requests", "dash.stock", "dash.overview"],
    intro: "Your home page. It shows what needs your attention today.",
    topics: [
      { id: "cards", q: "What the dashboard shows", steps: [
        "**Needs my attention**: everything waiting on you, like notes to review, a count to do, or a borrow to confirm. Press the button beside each one to go straight to it.",
        "**My appointments & notes**: today's patients, whether their forms are done, and whether their notes are recorded and reviewed.",
        "**Tasks**: **Mine**, **I assigned** (waiting on others) and **Everyone** (due today). Press **✓ Done** to finish one.",
        "**My requests**: your order requests and JT storage releases, and where they're up to.",
      ], tips: [
        "You only see the cards your role uses.",
        "Press **Customise** to hide cards you don't need. **Refresh** loads the latest.",
      ] },
      { id: "day", q: "Start and end of day", steps: [
        "Press **Start my day** in the top bar when you arrive. You'll see what's on for the clinic and for you today.",
        "If you carry a kit, you're asked how much is left in it. Count it and type the number. Put 0 if you have none.",
        "Press **End my day** before you leave.",
      ], tips: [
        "Typed the wrong kit number this morning? Press **Edit start of day** (in the top bar, or under your name) any time before you end your day.",
        "Pressed **Remind me later**? The **Start my day** button stays in the top bar until your kit is counted.",
      ] },
    ],
  },

  {
    id: "patients", title: "Patients", icon: "🧑‍⚕️", need: ["menu.patients"],
    intro: "Finding patients, their history, and keeping their details up to date.",
    topics: [
      { id: "find", q: "Finding a patient", steps: [
        "Open [Patient List](#/patients) and type part of their name or their patient ID.",
        "Click the patient to open their page.",
      ] },
      { id: "page", q: "What's on the patient's page", steps: [
        "At the top: their details, and buttons to call, SMS, email, add a reminder or **Edit**.",
        "**Pre-Consultation Information**: reminders, today's appointment, personal notes, social history, past and future visits, and packages.",
        "Below that: the treatment plan, skincare, records, saved forms, tasks, billing and clinical history.",
      ], tips: [
        "A red **Overdue treatments** chip at the top lists what they're overdue for.",
        "Press **Refresh** on Pre-Consultation Information to load the latest.",
      ] },
      { id: "visits", q: "Past appointments and record badges", steps: [
        "Each visit shows what was done and who did it. Coloured dots mark injectables, skin treatments and reviews.",
        "Badges show the records saved that day: **Tx Record**, **Cons Record**, **Rx** and **Summary**. Click one to open it.",
        "A red **No Tx Record** means injectables were booked but no treatment record was saved. Please add it.",
      ] },
      { id: "reminder", q: "Adding a reminder for a patient", steps: [
        "On the patient's page, press the bell, or **+ Add** next to Reminders.",
        "Write what needs doing, the due date, and who it's for, then save.",
        "Press **Done** when it's finished. It also shows in that person's Tasks on their dashboard.",
      ] },
      { id: "edit", q: "Updating a patient's details", need: ["patients.edit"], steps: [
        "Open the patient and press **Edit** at the top.",
        "Change what's needed and press **Save changes**.",
      ], tips: ["The patient ID can't be changed."] },
      { id: "merge", q: "Merging a duplicate patient", need: ["patients.merge"], steps: [
        "Open the patient you want to keep, then **Merge**.", // CHECK
        "Choose the duplicate. Its records move across, and a **Merged** chip shows on the patient.",
      ], tips: [
        "Double-check it's the same person (date of birth, phone) before merging.",
        "Merged the wrong one? An Admin can press the **Merged** chip, then **Undo merge**.",
      ] },
      { id: "plan", q: "Treatment plans", need: ["clinical.view"], steps: [
        "Open the patient and go to their **Treatment Plan**.",
        "Each concern lists its treatments, how many sessions, how often, and the quote.",
        "As the patient has appointments, sessions are ticked off automatically: done, booked, due or overdue.",
      ], tips: [
        "Plans written in recorded consultations are under **Consultation plans**. Press **Apply to master plan** to add one to the patient's main plan.",
        "If the patient has an event coming up (like a wedding), you're warned when a treatment with downtime lands just before it.",
      ] },
      { id: "plan-send", q: "Sending a treatment plan to the patient", need: ["send.patients"], steps: [
        "On the treatment plan, choose **Email** or **Print**.", // CHECK
        "The patient copy is made as a PDF, and each send is recorded on the plan. Clinicians' notes are never included.",
      ] },
    ],
  },

  {
    id: "consults", title: "Recording consultations", icon: "🎙️", need: ["consult.record"],
    intro: "Record the consultation and the notes are written for you to check.",
    topics: [
      { id: "record", q: "Recording a consultation", steps: [
        "**Always ask the patient first** and only record if they agree.",
        "Open the patient's page and press **Start appointment** in the top bar.",
        "Keep the device near you and speak normally. Press **Stop** at the end.",
        "The recording uploads by itself. Keep the page open until it says it's uploaded.",
      ], tips: [
        "Logged out by accident during a recording? It's kept on that computer and uploaded at your next login.",
      ] },
      { id: "notes", q: "Checking and signing off the notes", steps: [
        "A few minutes later, draft notes appear on the record.",
        "Read them carefully and fix anything wrong. You're responsible for what's signed off.",
        "When they're right, mark them **Reviewed**. Reviewed notes can't be deleted or rewritten.",
      ], tips: [
        "Notes not good enough? Press **Regenerate** to write them again from the same recording. The old version is kept.",
        "Personal details the patient mentioned (like a wedding coming up) show as suggestions you can add.",
        "Notes waiting for you show in **Needs my attention** on your dashboard.",
      ] },
      { id: "delete", q: "Deleting a recording (wrong patient, by accident)", steps: [
        "Open the record and press **Delete**, then type why.",
        "You can delete your own recordings. Only some staff can delete other people's.",
      ], tips: ["Signed-off (Reviewed) notes can't be deleted."] },
      { id: "email", q: "Emailing treatment information to the patient", need: ["send.patients"], steps: [
        "In the notes panel, open **Treatment Info to Email** and tick the treatments to send.",
        "Press the draft button, check the email, then send.", // CHECK
        "A badge shows it was emailed, and when.",
      ] },
    ],
  },

  {
    id: "forms", title: "Forms and printing", icon: "📝", need: ["menu.forms", "send.patients", "forms.build"],
    intro: "Filling in forms for patients, and emailing or printing them.",
    topics: [
      { id: "fill", q: "Filling in a form for a patient", steps: [
        "On the patient's page, press the tile you need: **Consent record**, **Treatment record**, **Prescription**, **Summary** or **General note**.",
        "Fill it in and save. Your provider, prescriber and AHPRA numbers fill in for you.",
      ], tips: ["Products used on a treatment record come off stock (or your kit) when it's saved."] },
      { id: "send", q: "Emailing or printing a completed form", need: ["send.patients"], steps: [
        "Open the saved form and choose **Email** or **Print**.",
        "Email: check the address, then send. The PDF is attached.",
        "Print: it's sent to the clinic printer.",
      ] },
      { id: "aftercare", q: "Sending aftercare instructions", need: ["send.patients"], steps: [
        "From the patient, choose **Aftercare**, tick the instructions, then email or print.", // CHECK
      ] },
      { id: "build", q: "Building or changing a form", need: ["forms.build"], steps: [
        "Open [Form Builder](#/forms) and choose the form, or make a new one.",
        "Add questions, then publish it so staff can use it.",
      ], tips: ["Pictures for forms and emails live in the Image Bank. Aftercare wording lives in the Aftercare Bank."] },
    ],
  },

  {
    id: "tasks", title: "Task Manager", icon: "✅", need: ["menu.tasks", "tasks.run", "inventory.count"],
    intro: "Ready-made emails, printing, and the daily jobs.",
    topics: [
      { id: "run", q: "Running a task", need: ["tasks.run"], steps: [
        "Open [Task Manager](#/tasks) and choose the task.",
        "Choose the patient (or staff), check the email, and press **Send**.",
        "Everything sent is kept in the task history.",
      ] },
      { id: "print", q: "Printing a form (To Print)", need: ["tasks.run"], steps: [
        "In Task Manager, choose **To Print**.",
        "Pick the form, blank or for a patient, choose how many copies, and send it to the printer.",
      ] },
      { id: "count", q: "The opening count", need: ["inventory.count"], steps: [
        "Each morning, open **Task Manager → Opening count**.",
        "Count what's physically there and type the number. Don't look at what the system says first.",
        "Use the category buttons to count one group at a time. Each shows how many are left.",
        "If a count doesn't match, someone else is asked to recount. Admins review anything that still doesn't match.",
      ], tips: [
        "If it isn't finished by its due time, a reminder email is sent.",
        "Interrupted? Press **Save and finish later**. You, or anyone else who counts, can carry on from Task Manager → Opening count.",
        "Want the list in the order things sit? Press **Arrange order** once, drag the products into place and add headings like \"Fridge\". Tick several to move them together with **Move here**. Everyone's count follows it.",
      ] },
      { id: "build", q: "Making or scheduling a task (Admins)", need: ["tasks.build"], steps: [
        "In Task Manager, open the Task Builder, write the email and choose who it goes to.",
        "To send it automatically, set a schedule, e.g. every weekday at 8am. Use **Send a test to me** to check it.",
      ], tips: ["Schedules can skip weekends, closed days, or days with no appointments."] },
    ],
  },

  {
    id: "ssp", title: "Skin Script Protocols", icon: "🧴", need: ["ssp.create", "ssp.config"],
    intro: "A personalised skincare routine for the patient.",
    topics: [
      { id: "make", q: "Creating a protocol", need: ["ssp.create"], steps: [
        "On the patient's page, press **Skin script (SSP)**.",
        "Add each product and tick AM, PM, or both. The instructions fill in, and you can change them.",
        "Save it, then email it to the patient or print it.",
      ] },
      { id: "products", q: "Adding or changing products", need: ["ssp.config"], steps: [
        "Open the Skin Script products page, edit a product or add a new one, and save.", // CHECK
      ] },
    ],
  },

  {
    id: "requests", title: "Ordering stock (requests)", icon: "🛒", need: ["inventory.request"],
    intro: "Running low on something? Ask the ordering team for it.",
    topics: [
      { id: "new", q: "Requesting an order", steps: [
        "Press [+ Request order](#/tasks/order).",
        "Choose the products and how many, and whether it's for the Shelf or JT storage.",
        "Tick **Urgent** only if it's needed straight away, then send.",
      ], tips: [
        "**Request low stock** on the Stock page fills in everything that's low for you.",
        "You're emailed when it's ordered or declined, and again when it arrives.",
      ] },
      { id: "track", q: "Checking where a request is up to", steps: [
        "Open [Inventory → Requests](#/inventory/requests).",
        "Open → Ordered → Received. Declined requests show the reason.",
        "Changed your mind? Press **Cancel request** on your request (only while it's still Open).",
      ] },
    ],
  },

  {
    id: "scanner", title: "Scanner", icon: "📷", need: ["scanner.billing", "scanner.docket"],
    intro: "Take a photo instead of typing it in. The portal reads it and you check it before anything is saved.",
    topics: [
      { id: "photo", q: "Taking a good photo", steps: [
        "Open [Scanner](#/scanner). If you can do both kinds, choose **Billing sheet** or **Delivery docket** at the top.",
        "Fit the whole page inside the frame and press the round button.",
        "Tap the screen to focus. Use **1×**, **1.5×** or **2×** (or pinch) to zoom, and the lightning button for the torch.",
      ], tips: [
        "Camera not starting? Use **Camera app** or **Upload** at the bottom instead.",
        "Flat, well-lit and not blurry gives the best result.",
      ] },
      { id: "billing", q: "Scanning a billing sheet", need: ["scanner.billing"], steps: [
        "Put the products being given to the patient on or next to the billing sheet, and take the photo with both in it.",
        "Check the patient at the top. If it's the wrong booking, press **change** and pick the right one.",
        "Check each product. Press its name to **change** it if it's wrong. A ✓ means it was seen in the photo.",
        "Check **Off Shelf** (how many come off the Shelf) and the fee for each.",
        "Anything orange or red needs a look. Add a note under **What happened?** if something's different on purpose (e.g. a free sample).",
        "Press **Save and take … off Shelf**.",
      ], tips: [
        "If the same products were already checked out for this patient today, you're asked before they come off again.",
        "The photo is kept with the patient's record.",
      ] },
      { id: "docket", q: "Scanning a delivery docket", need: ["scanner.docket"], steps: [
        "Take a photo of the supplier's docket, packing slip or invoice.",
        "Check each line: the quantity, and the batch and expiry where the product needs them. Type straight into the boxes to fix anything. Changed lines are marked **edited**.",
        "Check the purchase order it's matched to. Each one shows who ordered and sent it, and when.",
        "Carry on to receive it. What you checked is filled in for you on the Receive delivery screen.", // CHECK
      ], tips: ["Batch and expiry boxes only show for products that need them."] },
    ],
  },

  {
    id: "receive", title: "Receiving a delivery", icon: "📦", need: ["inventory.receive", "inventory.order", "inventory.manage"],
    intro: "When a box arrives, record it against its purchase order so the stock is right.",
    topics: [
      { id: "pick", q: "1. Find the order", steps: [
        "Open [Inventory → Receive delivery](#/inventory/receive).",
        "Choose the order the box is for. Match the supplier, or the PO number on the docket.",
      ], tips: [
        "Can't see the order? It has to be sent to the supplier first. Ask the ordering team.",
        "Quicker: scan the docket with the [Scanner](#/scanner) first, and everything is filled in for you.",
      ] },
      { id: "docket", q: "2. Photograph the docket", steps: [
        "Press **Take photo** and photograph the docket or invoice (or **Choose file** for a PDF).",
        "Type the docket or invoice number.",
      ], tips: ["The photo is kept with the order, so nobody has to find the paper later."] },
      { id: "count", q: "3. Enter what arrived", steps: [
        "For each item, use **+** and **−** to enter how many arrived.",
        "If the whole order is there, press **Everything arrived**.",
        "Choose where you put it: the Shelf or JT storage. **Split between storages** if some went to each.",
      ] },
      { id: "batch", q: "4. Batch numbers and expiry dates", steps: [
        "Some products (like Xeomin or Belotero) ask for the batch or lot number and expiry date. Copy them from the box.",
        "Two different batches in one delivery? Press **+ Another batch or storage** and enter each one.",
      ], tips: ["You're warned if an expiry date has already passed or is within 60 days."] },
      { id: "save", q: "5. Save it", steps: [
        "Add a note if something was damaged or missing.",
        "If nothing more is coming on this order, tick **Nothing more is coming on this order**.",
        "Press **Receive stock**. The stock goes up, and anyone who requested it is told it's arrived.",
      ] },
    ],
  },

  {
    id: "stock", title: "Stock and counting", icon: "📊", need: ["inventory.view", "inventory.count", "inventory.order", "inventory.manage"],
    intro: "Seeing what's in stock and keeping the numbers right.",
    topics: [
      { id: "read", q: "Reading the Stock page", steps: [
        "Open [Inventory → Stock](#/inventory/stock). Each product shows how many are on the Shelf and in JT storage.",
        "Orange labels mean low or expiring soon. Red means expired or being investigated.",
        "Click a product to see its batches, expiry dates, its last count and recent activity.",
      ], tips: ["Tick **Only low or expiring** to see just the ones that need attention."] },
      { id: "move", q: "Moving stock between the Shelf and JT storage", need: ["inventory.order", "inventory.manage"], steps: [
        "Click the product, then **Move Shelf ⇄ JT**.",
        "Choose the direction (and batch, if asked), enter how many, and save.",
      ] },
      { id: "opened", q: "Opened products shared between patients", need: ["inventory.order", "inventory.manage", "consult.record"], steps: [
        "Products like numbing cream are opened once and used for several patients.",
        "Click the product, then **+ Open a new…** when you start a new one.",
        "When it's empty or past its use-by date, press **Finished** and choose why.",
      ], tips: ["Opened ones aren't counted in stock. Only sealed ones are."] },
      { id: "recount", q: "Recounts and investigations", need: ["inventory.count", "inventory.order", "inventory.manage", "menu.reports"], steps: [
        "When a count doesn't match, a recount is needed by someone other than the first counter. It shows in **Needs my attention** and in [Inventory → Investigations](#/inventory/investigations).",
        "Count it without looking at the system first, and type what's there.",
        "If the recount confirms the difference, an Admin reviews it, checks records or CCTV, and closes it with what happened.",
      ] },
    ],
  },

  {
    id: "ordering", title: "Ordering team", icon: "📋", need: ["inventory.order", "inventory.manage"],
    intro: "Turning requests into purchase orders and sending them to suppliers.",
    topics: [
      { id: "po", q: "Making a purchase order from requests", steps: [
        "Open [Inventory → Requests](#/inventory/requests) and choose **By supplier**.",
        "Under each supplier, press **Create purchase order**. Everything requested from them is added.",
        "Check the quantities, then send it to the supplier from the order.",
      ], tips: [
        "When the order is sent, the requests it covers change to Ordered and the requesters are emailed.",
        "A product with more than one supplier? Choose who to order from in the **Order from** box first.",
      ] },
      { id: "send", q: "Emailing an order to the supplier", steps: [
        "Open the purchase order and press **Send to supplier**.", // CHECK
        "The subject and message are filled in from the supplier's purchase order email (or the standard wording), with this order's details and items.",
        "Check the email address and the wording, change anything just for this order, then send.",
      ], tips: [
        "The order changes to Sent, and the requests it covers become Ordered. The people who asked are emailed.",
        "Sending the same order again is noted on its history as **Emailed again**.",
        "Ordered by phone or on their website instead? Mark it as sent rather than emailing it.",
        "To change the wording for every order to this supplier, edit their purchase order email (Managing products and suppliers).",
      ] },
      { id: "new", q: "A purchase order without a request", steps: [
        "Open [Purchase orders](#/inventory/orders) and press **+ New purchase order**.",
        "Choose the supplier. Tick **Start with this supplier's low stock** to fill it in for you.",
      ] },
      { id: "add", q: "Adding products to an order", steps: [
        "Press the product box on a line and start typing the name.",
        "This supplier's products are shown first, with how many are in stock. **low** means it's running low, and **on this order** means it's already added.",
        "Use the arrow keys and Enter, or click, to choose.",
      ] },
      { id: "backdate", q: "Entering an order that was placed earlier", steps: [
        "Ordered by phone or email before it was entered here? Change the **Order date** on the order to the day it was really placed.",
        "When you mark it as sent, set the **Date sent** to the real day too.",
      ], tips: ["Backdated orders are marked so everyone knows they were entered later."] },
      { id: "past", q: "Orders received before the portal", need: ["inventory.history"], steps: [
        "Open the order and press **Already received**.",
        "Enter the date it arrived, who received it, and the docket number (and the date sent, if it's still a draft).",
        "Save. It's recorded as received for the history only. Stock isn't changed, because that stock was counted when the portal started.",
      ], tips: ["You're warned if the date you enter is after the portal's starting stock was set. That delivery should be received the normal way."] },
      { id: "answer", q: "Answering a request yourself", steps: [
        "On an open request, press **Mark as ordered** (for example, if you ordered by phone) or **Decline** with a reason.",
        "The person who asked is emailed either way.",
      ] },
    ],
  },

  {
    id: "kits", title: "Injector kits", icon: "💉", injector: true,
    intro: "Your own kit of products such as Xeomin, carried and used across patients.",
    topics: [
      { id: "kit", q: "My kit and the kit check", steps: [
        "Open [Inventory → Kits](#/inventory/kits) to see what's in your kit.",
        "When you press **Start my day**, you're asked how much is left in your kit. Count it and type the number. Put 0 if you have none.",
        "If the morning count doesn't match last night's, it's sent to an Admin to check.",
      ] },
      { id: "jt", q: "Getting more from JT storage", steps: [
        "If there's none on the Shelf, ask for a release from JT storage on the Kits page.",
        "The approver is emailed. Once approved, it moves to the Shelf and you can take it into your kit.",
      ] },
      { id: "borrow", q: "Borrowing from a colleague's opened vial", steps: [
        "Record it on the Kits page: who you took from and how many units.",
        "They're asked to confirm. If the amount is wrong, they can dispute it and an Admin sorts it out.",
      ] },
    ],
  },

  {
    id: "manage", title: "Managing products and suppliers", icon: "🗂️", need: ["inventory.manage"],
    intro: "Setting up products and suppliers, and correcting stock numbers.",
    topics: [
      { id: "product", q: "Adding or changing a product", steps: [
        "Press **+ New product** (or **Edit** on the Products page).",
        "Fill in how it's given to staff (e.g. vial), how it's bought (e.g. box of 10), and when to reorder.",
        "Tick **Needs a batch / lot number and expiry date** for injectables.",
        "Choose how it's used in treatments: one per patient, opened and shared, or carried in kits.",
      ] },
      { id: "po-email", q: "A supplier's purchase order email", steps: [
        "Open the supplier and go to **Purchase order email**.", // CHECK
        "Write the subject and message the way this supplier likes their orders. Leave both empty to use the standard wording.",
        "Use tags for the parts that change with each order. They're filled in when the order is sent: **{Contact first name}**, **{Contact name}**, **{Supplier}**, **{PO number}**, **{Order date}**, **{Account number}**, **{Item count}** and **{My name}**.",
        "Type **{Order table}** where the list of items should go. Leave it out and the items go after your message.",
        "Save the supplier.",
      ], tips: [
        "No contact name on the supplier? {Contact first name} and {Contact name} say \"there\", so \"Hi {Contact first name}\" still reads well.",
        "No account number on the supplier? {Account number} is left blank.",
        "Capitals and spacing in tags don't matter. A tag the portal doesn't know is left exactly as typed, so check the spelling.",
        "The wording can still be changed on each order before it's sent.",
      ] },
      { id: "bulk", q: "Changing many products at once", steps: [
        "On [Products](#/inventory/products), tick the products (or a whole category).",
        "Use the bar that appears: set the supplier, category, opening count, starting stock, or make them inactive.",
      ] },
      { id: "fix", q: "Fixing a stock number", steps: [
        "Stock found or opening balances: click the product, then **Add stock**.",
        "Count corrections: **Count**, or **Update digital count** on the Stock page for many at once.",
        "Damaged or expired: **Write off**, and choose the reason.",
      ], tips: ["Deliveries always go through **Receive delivery**, never **Add stock**, so they match their order."] },
      { id: "services", q: "Linking services to products", steps: [
        "Open [Inventory → Service links](#/inventory/services).",
        "For each booked service, choose the products it uses.",
      ], tips: ["This is how the portal spots bookings where no products were recorded."] },
      { id: "notify", q: "Who gets inventory emails", steps: [
        "Open [Inventory → Notifications](#/inventory/notifications).",
        "Each rule says what happens (e.g. stock runs low) and who's emailed. Use **Send test to me** to check.",
      ] },
    ],
  },

  {
    id: "reports", title: "Reports", icon: "📈", need: ["menu.reports"],
    intro: "Counts, wastage, kits and usage across the clinic. Most reports can be filtered by date and exported with **Export CSV**.",
    topics: [
      { id: "variance", q: "Count differences", steps: [
        "Open [Reporting → Count differences](#/reports/variance) to see counts that didn't match the system.",
        "Press **Accept** to adjust the stock to the count, or **Explain** to leave stock as it is and note why.",
      ] },
      { id: "baseline", q: "Setting the starting stock", need: ["inventory.manage"], steps: [
        "Do today's opening count first.",
        "In Count differences, press **Set the starting stock from today's count**.",
        "Check the changes, then confirm. Every difference after today is a real one.",
      ] },
      { id: "notrecorded", q: "Bookings with no products recorded", steps: [
        "Open [Reporting → Not recorded](#/reports/notrecorded).",
        "Each line is a booking for a service that uses stock, but no treatment record used any. Open the patient and add the record.",
      ] },
      { id: "wastage", q: "Wastage", steps: [
        "Open [Reporting → Wastage](#/reports/wastage) to see leftover product thrown away, kit discards, opened products finished early, and write-offs, with their cost.",
      ] },
      { id: "kitrecon", q: "Kit reconciliation", steps: [
        "Open [Reporting → Kit reconciliation](#/reports/kits). Each injector's kit should add up: taken, minus used, discarded, lent or returned.",
        "A gap means something wasn't recorded. Press **History** to see every change.",
      ] },
      { id: "usage", q: "Usage", steps: [
        "Open [Reporting → Usage](#/reports/usage) to see products used on treatment records by product, staff member, patient or month.",
      ], tips: ["A wrong amount on a record can be fixed with **Correct** (Manage inventory). The original is kept."] },
      { id: "short", q: "Saved short", steps: [
        "A treatment was saved when the system showed less stock than was used.",
        "Count the product, accept the difference, then press **Resolve**. The patient's record is already right.",
      ] },
    ],
  },

  {
    id: "admin", title: "Staff and access (Admins)", icon: "🔐", admin: true,
    intro: "Adding staff, PINs, and who can see what.",
    topics: [
      { id: "add", q: "Adding a staff member", steps: [
        "Open [Staff](#/staff) and press **+ Add staff**.",
        "Enter their name and role, and upload a photo if you have one. Tick **Injector** if they carry a kit.",
        "Add their provider, prescriber and AHPRA numbers if they have them. These fill in on forms.",
        "Press **Add staff**. Give them the PIN shown, which is only shown once.",
      ] },
      { id: "pin", q: "Resetting a PIN", steps: [
        "In Staff, press **Reset PIN** next to the person. Their old PIN stops working straight away.",
      ] },
      { id: "roles", q: "Changing what a role can do", steps: [
        "Open Staff → **Roles & access**.",
        "Tick or untick for each role, then press **Save role access**. Staff get the change within a few minutes.",
        "Need a new role, like Practice Manager? Press **+ Add role**.",
      ], tips: [
        "The **Scanner** ticks control who can open the Scanner, and whether they can scan billing sheets, delivery dockets, or both.",
        "Saving a billing sheet scan takes stock off the Shelf, so that role also needs the usual stock access.",
      ] },
      { id: "except", q: "One person needs something different", steps: [
        "Edit the person and open **Access for this person**.",
        "Set **Always allow** or **Always block** for just them. Each row shows what they'll end up with.",
      ] },
      { id: "off", q: "Someone has left", steps: [
        "Press **Turn off** next to them. They're logged out and can't log in again. Their records are kept.",
      ] },
      { id: "locked", q: "Everyone is locked out", steps: [
        "Too many wrong PINs locks logins. In Staff, press **Unlock now**.",
      ] },
      { id: "activity", q: "Seeing who changed what", steps: [
        "Open Staff → **Activity**. Every staff change is listed, with who made it and when.",
      ] },
    ],
  },

  {
    id: "config", title: "System configuration (Admins)", icon: "⚙️", admin: true,
    intro: "Clinic-wide settings for recordings, treatment plans and wording.",
    topics: [
      { id: "rules", q: "Recording rules", steps: [
        "Open [System configuration → Recording rules](#/settings/recording).",
        "Set reminders to create, points to highlight, or lines to add to notes when certain things come up in a consultation.",
        "Add commonly misheard words and their correct spelling.",
      ] },
      { id: "plans", q: "Treatment plan settings", steps: [
        "Open [System configuration → Treatment plans](#/settings/plans).",
        "**Concerns**: change a concern's colour or the name staff and patients see.",
        "**Services and concerns**: for each service, tick the concerns it treats and its downtime. Mark consultations and reviews **Not a treatment**. **Suggest with AI** fills these in for you to check.",
        "**Patient copy**: the title, colour, welcome, closing and email used when a plan goes to a patient.",
      ] },
      { id: "wording", q: "Changing wording", steps: [
        "Open [System configuration → Wording](#/settings/wording), or press **✎ Edit wording** in a window that has it.",
        "Change the text and save. Everyone sees the new wording.",
      ] },
    ],
  },
];