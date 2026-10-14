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
        "Your PIN is yours alone. Never share it or log in for someone else.",
        "Too many wrong PINs locks logins for everyone for up to 15 minutes. An Admin can unlock it straight away.",
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
        "Open Chat (the round button at the bottom right) and choose **Help**.",
        "Type your question and send it. Every Admin can see and answer it.",
        "If nobody reads it within about 10 minutes, the Admins are emailed.",
      ], tips: [
        "If an Admin is away, you'll see when they're back at the top of your Help chat.",
      ] },
      { id: "dm", q: "Messaging a colleague", steps: [
        "In Chat, press **New message** and choose the person.", // CHECK button name
        "Only the two of you can see the conversation.",
      ] },
      { id: "group", q: "Starting a group chat", steps: [
        "In Chat, press **New message**, then **+ New group**.",
        "Give it a name and tick the people to include. The role buttons tick everyone in that role at once.",
      ], tips: ["Who's in a group is set when it's made. To change it, start a new group."] },
      { id: "away", q: "Setting yourself as away (Admins)", admin: true, steps: [
        "In Chat, open **Away** and choose the day you're back.", // CHECK
        "Staff see that you're away in their Help chat, and reminder emails pause.",
        "It switches off by itself on your back date, or press **I'm back**.",
      ] },
    ],
  },

  {
    id: "dashboard", title: "My dashboard", icon: "🏠",
    need: ["dash.attention", "dash.appts", "dash.tasks", "dash.kit", "dash.records", "dash.usage", "dash.requests", "dash.stock", "dash.overview"],
    intro: "Your home page. It shows what needs your attention today.",
    topics: [
      { id: "cards", q: "What the dashboard shows", steps: [
        "**Needs my attention**: things waiting on you, like notes to review or a count to do.",
        "**My appointments today**: your patients for the day.",
        "**My requests**: your order requests and where they're up to.",
        "Click any item to go straight to it.",
      ], tips: ["You only see the cards your role uses."] },
      { id: "day", q: "Start and end of day", steps: [
        "Press **Start my day** in the top bar when you arrive, and **End my day** before you leave.",
        "Each one lists what needs doing, such as the opening count or notes still to sign off.",
        "Need to change your start of day answers? Press **Edit start of day**.",
      ] },
    ],
  },

  {
    id: "patients", title: "Patients", icon: "🧑‍⚕️", need: ["menu.patients"],
    intro: "Finding patients and keeping their details up to date.",
    topics: [
      { id: "find", q: "Finding a patient", steps: [
        "Open [Patient List](#/patients) and type part of their name or their patient ID.",
        "Click the patient to open their page.",
      ] },
      { id: "edit", q: "Updating a patient's details", need: ["patients.edit"], steps: [
        "Open the patient, then **Edit**.", // CHECK
        "Change what's needed and press **Save**.",
      ] },
      { id: "merge", q: "Merging a duplicate patient", need: ["patients.merge"], steps: [
        "Open the patient you want to keep, then **Merge**.", // CHECK
        "Choose the duplicate. Its records move across and the duplicate is removed.",
      ], tips: ["Double-check it's the same person (date of birth, phone) before merging. This can't be undone."] },
      { id: "plan", q: "Treatment plans", need: ["clinical.view"], steps: [
        "Open the patient and go to their **Treatment plan**.",
        "Add each concern, the treatments for it, how many sessions, and the quote.",
        "As the patient has appointments, sessions are ticked off automatically.",
      ] },
      { id: "plan-send", q: "Sending a treatment plan to the patient", need: ["send.patients"], steps: [
        "On the treatment plan, choose **Email** or **Print**.", // CHECK
        "The patient copy is made as a PDF, and each send is recorded on the plan.",
      ] },
    ],
  },

  {
    id: "consults", title: "Recording consultations", icon: "🎙️", need: ["consult.record"],
    intro: "Record the consultation and the notes are written for you to check.",
    topics: [
      { id: "record", q: "Recording a consultation", steps: [
        "**Always ask the patient first** and only record if they agree.",
        "Open the patient's page and press **Start appointment** in the top bar.", // CHECK
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
    id: "tasks", title: "Task Manager", icon: "✅", need: ["menu.tasks", "tasks.run"],
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
        "If a count doesn't match, someone else is asked to recount. Admins review anything that still doesn't match.",
      ], tips: ["If it isn't finished by its due time, a reminder email is sent."] },
      { id: "build", q: "Making or scheduling a task (Admins)", need: ["tasks.build"], steps: [
        "In Task Manager, open the Task Builder, write the email and choose who it goes to.",
        "To send it automatically, set a schedule, e.g. every weekday at 8am. Use **Send a test to me** to check it.",
      ] },
    ],
  },

  {
    id: "ssp", title: "Skin Script Protocols", icon: "🧴", need: ["ssp.create", "ssp.config"],
    intro: "A personalised skincare routine for the patient.",
    topics: [
      { id: "make", q: "Creating a protocol", need: ["ssp.create"], steps: [
        "From the patient, choose **Skin Script Protocol**.", // CHECK
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
    id: "receive", title: "Receiving a delivery", icon: "📦", need: ["inventory.receive", "inventory.order", "inventory.manage"],
    intro: "When a box arrives, record it against its purchase order so the stock is right.",
    topics: [
      { id: "pick", q: "1. Find the order", steps: [
        "Open [Inventory → Receive delivery](#/inventory/receive).",
        "Choose the order the box is for. Match the supplier, or the PO number on the docket.",
      ], tips: ["Can't see the order? It has to be sent to the supplier first. Ask the ordering team."] },
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
        "Click a product to see its batches, expiry dates and recent activity.",
      ] },
      { id: "move", q: "Moving stock between the Shelf and JT storage", need: ["inventory.order", "inventory.manage"], steps: [
        "Click the product, then **Move Shelf ⇄ JT**.",
        "Choose the direction (and batch, if asked), enter how many, and save.",
      ] },
      { id: "opened", q: "Opened products shared between patients", need: ["inventory.order", "inventory.manage", "consult.record"], steps: [
        "Products like numbing cream are opened once and used for several patients.",
        "Click the product, then **+ Open a new…** when you start a new one.",
        "When it's empty or past its use-by date, press **Finished**.",
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
      ], tips: ["When the order is sent, the requests it covers change to Ordered and the requesters are emailed."] },
      { id: "new", q: "A purchase order without a request", steps: [
        "Open [Purchase orders](#/inventory/orders) and press **+ New purchase order**.",
        "Choose the supplier. Tick **Start with this supplier's low stock** to fill it in for you.",
      ] },
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
        "When you press **Start my day**, you're asked how many units are left. Count them and type the number.",
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
      { id: "notify", q: "Who gets inventory emails", steps: [
        "Open [Inventory → Notifications](#/inventory/notifications).",
        "Each rule says what happens (e.g. stock runs low) and who's emailed. Use **Send test to me** to check.",
      ] },
    ],
  },

  {
    id: "reports", title: "Reports", icon: "📈", need: ["menu.reports"],
    intro: "Counts, wastage, kits and usage across the clinic.",
    topics: [
      { id: "variance", q: "Count differences", steps: [
        "Open [Reporting](#/reports/variance) to see counts that didn't match the system.",
        "Accept each difference, or look into it if it's unexpected.",
      ] },
      { id: "short", q: "Saved short", steps: [
        "A treatment was saved when the system showed less stock than was used.",
        "Count the product, accept the difference, then mark it resolved. The patient's record is already right.",
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
        "Press **Add staff**. Give them the PIN shown, which is only shown once.",
      ] },
      { id: "pin", q: "Resetting a PIN", steps: [
        "In Staff, press **Reset PIN** next to the person. Their old PIN stops working straight away.",
      ] },
      { id: "roles", q: "Changing what a role can do", steps: [
        "Open Staff → **Roles & access**.",
        "Tick or untick for each role, then press **Save role access**. Staff get the change within a minute.",
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
];