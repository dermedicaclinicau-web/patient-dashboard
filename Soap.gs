const SHEET_ID = '1LaLsIKdw_1ib7oOblHRPBvnjc1XoNMyu1E3icd8bXMg'; // Main Spreadsheet ID
const LOG_SHEET_NAME = 'Recorder';
const PRODUCT_SHEET_NAME = 'Product Names'; // Name of sheet with product list

const TC_SHEET_ID = '1Mu_CNbqKjrnAo8fwV6NYXS9xnJOEjRIcYjANXus_UMg';
const TC_SHEET_NAME = 'TREATMENT-CONFIGURATIONS';

// Audit log for emails sent from "TREATMENT INFO TO EMAIL"
const EMAIL_LOG_SHEET_ID = '1nbab_cc0hfgGEsjzERwsYv8whH-oJ1CSwgu0vSJ-uGk';
const EMAIL_LOG_SHEET_NAME = 'treatment_info_emailed';

// 2. AI CONFIGURATION
const GEMINI_MODEL = 'gemini-2.5-pro';

const SOAP_PROMPTS = {
  subjective: `
    You are generating the SUBJECTIVE section.
    Return a STRING. 
    
    STRICT RULES:
    1. ONLY include bullet points for information explicitly mentioned in the transcript.
    2. IF A CATEGORY IS NOT MENTIONED OMIT THE LINE ENTIRELY.
    3. Do NOT write "Not stated", "Not mentioned", "None", or "Denies".
    4. ***EXCLUSION RULE***: Do NOT include specific Medication names, Occupation, or Employer details here. These MUST be placed in their dedicated JSON sections (Medication/Social History).
    
    POTENTIAL CATEGORIES (Include ONLY if applicable):
    [Age] 
    - [Reasons for visit / chief complaints]
    - [Patient progress satisfaction]
    - [Duration/timing/severity of complaints]
    - [Aggravating/Alleviating factors]
    - [Progression of symptoms]
    - [Impact on daily activities]
    - [Associated symptoms]
    - [Relevant history/contributing factors]
    - [Expression lines] (If "facial movement lines" mentioned)
    
    MOTIVATION
    - [Motivation, emotions, events] (Omit if none)
    
    FEAR AND OBJECTIONS:
    - [Objections or Fears] (Omit if none)

    REFERRAL (Include ONLY if a referral is explicitly mentioned — otherwise OMIT this whole block):
    - [Referred by: <name/source>] (Use when the patient was referred TO the clinic by someone. Capture the referrer's name if stated — e.g. "Referred by: Dr Smith", "Referred by: existing patient Jane". If only a source is given with no name, capture the source — e.g. "Referred by: Instagram", "Referred by: friend".)
    - [Referral given: <name>] (Use when the patient mentions referring, recommending, or bringing in ANOTHER person to the clinic. Capture that person's name if stated — e.g. "Referral given: sister Amy".)
    `,

  objective: `
    You are generating the OBJECTIVE section.
    Return a STRING. 
    
    STRICT RULES:
    1. ONLY include findings explicitly observed or stated by the clinician.
    2. If a category (like Vitals) is not mentioned, DO NOT include the header or line.
    
    POTENTIAL CATEGORIES:
    - Vital signs
    - Physical exam findings (visible skin/face/body conditions)
    - Investigations with RESULTS (Only completed investigations)
    `,

  assessment: `
    You are generating the ASSESSMENT & PLAN section.
    Return a STRING.
    
    STRICT RULES:
    1. Omit empty sections. If there is no "Differential Diagnosis", do not write "Differential Diagnosis: None".
    
    FORMAT:
    [Outline the plan, one line per point]

    [1. Issue Name (condition name and area of concern only)]
    - Assessment, likely diagnosis for Issue 1: [condition name including face or body area]
    - Differential diagnosis for Issue 1: [only if explicitly mentioned]
    - Investigations planned for Issue 1: [only if explicitly mentioned]
    - Treatment planned for Issue 1: [only if explicitly mentioned]
    - Relevant referrals for Issue 1: [only if explicitly mentioned]

    [2. Issue Name (condition name and area of concern only)]
    - Assessment, likely diagnosis for Issue 2: [condition name including face or body area]
    - Differential diagnosis for Issue 2: [only if explicitly mentioned]
    - Investigations planned for Issue 2: [only if explicitly mentioned]
    - Treatment planned for Issue 2: [only if explicitly mentioned]
    - Relevant referrals for Issue 2: [only if explicitly mentioned]

    [3. Issue Name etc...]
    (Continue pattern for Issues 3, 4, 5 etc.)

    Other Comments:
    - (Patient sentiment about treatment, experience, expectations, results — only if mentioned)
    - (Booking comments: holiday, conflicting appointments, urgency, delays — only if mentioned)
    
    
    *Price Rules:* - "One five nine five" -> $1595
    - "Fifteen dollars ninety five" -> $15.95
    `,

  treatment_plan: `
    You are generating the IN-CLINIC TREATMENT PLAN.

    *** INTENT DECISION TREE (decide FIRST, before extracting anything) ***
    Work top to bottom and STOP at the first match. Set "intent" accordingly.

    STEP 1 — REVIEWING AN EXISTING PLAN ("reviewing_existing"):
    Choose this if the clinician anchors the discussion on a prior/active/existing treatment plan rather than building a fresh one. Cues include: "based on your last treatment plan", "the plan we made", "your current/existing plan", "let's review your plan", "as per your plan", "continuing your plan", "how did you go with [a treatment from the plan]".
    When intent = "reviewing_existing":
      - DO NOT create any concerns and DO NOT build a timeline. Leave all "concerns" entries and "timeline" empty.
      - Summarise the review in "discussion_notes" (what was reviewed, patient feedback/progress, any decisions).
      - If a new treatment is mentioned in passing during the review, note it IN WORDS inside "discussion_notes" only — do NOT create a concern or plan for it.

    STEP 2 — CREATING / BUILDING A NEW PLAN ("new_plan"):
    Choose this (only if STEP 1 did not match) if EITHER is true:
      a) The clinician explicitly says they are making a plan (e.g., "let's create a new treatment plan", "treatment plan for today", "let me put a plan together"); OR
      b) The clinician actively introduces NEW treatment recommendations this session (a treatment name + area, with or without a quote) for the patient's concerns.
    When intent = "new_plan": populate "concerns" and "timeline" using the rules below.

    STEP 3 — NEITHER ("none"):
    If neither applies, set intent = "none" and leave "concerns", "timeline", and "discussion_notes" empty.

    *** CONCERN IDENTIFICATION RULES (READ CAREFULLY) ***

    A "concern" is ANY issue the patient wants addressed, OR any issue the clinician identifies and discusses. Concerns almost NEVER use the word "concern" in conversation — listen for the INTENT.

    Capture a concern if you hear ANY of these patterns:
      • Patient complains about something: "I hate these lines", "it bothers me that...", "I don't like my...", "I want to get rid of...", "I've been worried about..."
      • Patient asks about something: "can we do something about...", "what can we do for...", "is there anything for..."
      • Patient describes a physical issue: "my skin is dry", "I've got these spots", "my jaw looks heavy", "I'm getting jowls"
      • Clinician observes on the patient: "I can see some volume loss", "there's crepey skin here", "you've got some pigmentation", "the texture here is..."
      • Clinician recommends without explicit patient prompt: "we should also address...", "I'd like to treat...", "we could improve..."
      • Treatment is discussed for a specific area/issue — reverse-engineer the concern from the treatment target.

    *** CAPTURE CONCERNS EVEN WITHOUT FULL TREATMENT DETAILS ***
    If a concern is raised but treatment details (quote, frequency) are not yet given:
      - STILL create the concern entry.
      - Fill "description" with the concern + area.
      - Fill "treatment" with the recommended treatment name if mentioned, even without quote.
      - Leave "frequency_interval", "quote", "comments" as empty strings.
    DO NOT drop a concern just because its quote or frequency hasn't been discussed.

    *** ORDERING ***
    - Order concerns A → F by priority: patient's first-mentioned / most emphasised concern is A, next is B, etc.
    - If the patient didn't raise it but the clinician did, place it AFTER any patient-raised concerns.
    - Each distinct concern gets its own entry. If two body areas share ONE concern type (e.g., pigmentation on face AND chest), combine them into one entry.
    *** ONE CONCERN PER CATEGORY ***
    Each concern_category can only appear ONCE across all concerns (A–F).
    If two or more issues fall in the same category (e.g., frown lines AND jaw slimming both fall
    under "Expression Lines & Muscle Movement"), merge them into ONE concern entry.

    When merging, keep the sub-issues in the SAME ORDER in every field, one per line, so each line
    of "treatment", "frequency_interval" and "quote" corresponds to the same-numbered sub-issue:
    - "description": list each sub-issue with its area, separated by "; "
        e.g., "Frown lines in the glabella; heavy jaw muscle from clenching"
    - "treatment": one treatment per line, in the same order as the description
    - "frequency_interval": one per line, in the same order. If a sub-issue has no frequency, write "—"
      on its line so the lines stay aligned.
    - "quote": one per line, in the same order, each quote prefixed with its treatment name and area
      so it is unambiguous which sub-issue it belongs to. If a sub-issue has no quote, omit that line.
    - "comments": combine, prefixing each with the area it refers to.
    DO NOT collapse two sub-issues into one vague phrase. "Expression lines on the face" is WRONG when
    the patient raised frown lines and jaw clenching — name both.

    *** DESCRIPTION FIELD RULES ***
    The "description" MUST include BOTH the concern type AND the specific area. Examples:
      ✅ "Crepey skin around the periorbital area and smile lines"
      ✅ "Volume loss in the mid-cheeks"
      ✅ "Pigmentation on the forehead and upper cheeks"
      ✅ "Jowling along the lower jawline"
      ✅ "Acne scarring on the chin and jawline"
      ❌ "Crepey skin" (missing area)
      ❌ "Eyes" (missing concern type)
      ❌ "Ageing" (too vague)

    *** WORKED EXAMPLES ***

    Transcript: "So I really hate these lines around my eyes, they make me look so tired. And my jaw, it's just heavy now, I've noticed it getting worse."
    Clinician: "Yeah I can see what you mean. For the eyes we could do RestoraGlow — that's going to be $499 per session, we'd do 2 sessions a month apart. For the jaw we should do Ulthera, $1400 per session, once a year."
    
    Output concerns:
    {
      "concern_a": {
        "description": "Crepey skin and fine lines around the periorbital area",
        "concern_category": "Skin Texture",
        "treatment": "RestoraGlow Eyes",
        "frequency_interval": "2 sessions, 1 month apart",
        "quote": "RestoraGlow Eyes — $499 per session",
        "comments": ""
      },
      "concern_b": {
        "description": "Heaviness and jowling along the lower jaw",
        "concern_category": "Skin Laxity",
        "treatment": "Ulthera",
        "frequency_interval": "Once a year",
        "quote": "Ulthera — $1400 per session",
        "comments": ""
      }
    }

    Transcript: "The patient's chin is looking a bit recessed. I'd like to put some filler there, we'll discuss pricing at the next visit."
    
    Output concerns:
    {
      "concern_a": {
        "description": "Recessed chin projection",
        "concern_category": "Volume Loss / Contours",
        "treatment": "Dermal Filler (chin)",
        "frequency_interval": "",
        "quote": "",
        "comments": "Pricing to be discussed at next visit"
      }
    }

    *** CONCERN CATEGORY MAPPING ***
    For EVERY concern, set "concern_category" to exactly one of these 9 canonical names.
    Copy the name EXACTLY, character for character. Never invent, abbreviate or re-word a category.
    - "Expression Lines / Muscle Movement"
    - "Volume Loss / Contours"
    - "Skin Texture"
    - "Skin Laxity"
    - "Pigmentation"
    - "Redness / Sensitive Skin"
    - "Collagen Replenishment"
    - "Body Contouring"
    - "Active Acne"

    *** HOW TO CHOOSE THE CATEGORY (precedence order) ***
    RULE 1 — SYMPTOM FIRST. The category describes the PATIENT'S CONCERN, not the treatment.
             Match the symptom/complaint against the SYMPTOM TRIGGERS below. This is the primary signal.
    RULE 2 — TREATMENT AS TIEBREAK ONLY. Use the TREATMENT SIGNALS below only when the symptom word
             appears under more than one category (see AMBIGUOUS TERMS), or when no symptom was named
             and you are reverse-engineering the concern from the treatment.
    RULE 3 — Never choose a category from a treatment's brand name. "Firm & Contour Treatment" contains
             the word "Contour" but is a SKIN LAXITY treatment, NOT "Volume Loss / Contours".

    ── 1. "Expression Lines / Muscle Movement" ──
    SYMPTOM TRIGGERS: frown lines, glabella, "11s", crow's feet, smile lines around the eyes,
      forehead lines, lip lines/lip flip/gummy smile, sad face, downturned corners of the mouth,
      DAO, chin dimpling/pebbling/orange peel chin, neck bands, platysmal bands, "turkey neck" bands,
      bruxism, teeth grinding/clenching, jaw slimming, masseter/square jaw, heavy jaw muscle,
      lines that appear or worsen ON MOVEMENT (when smiling / frowning / squinting).
    TREATMENT SIGNALS: Wrinkle Relaxer, Wrinkle Relaxer for Jaw Muscle.
    NOTE: If the concern is muscle-driven movement, use THIS category even if the area (neck, chin,
      jaw, mouth) also appears under another category.

    ── 2. "Volume Loss / Contours" ──
    SYMPTOM TRIGGERS: flattening of the cheeks, hollow/deflated/sunken cheeks or temples,
      "looking tired", tired or gaunt appearance, nasolabial folds/lines, marionette lines,
      tear trough, hollow under-eyes, dark circles under the eyes, loss of facial contour/projection,
      recessed or weak chin, undefined jawline from volume loss, thin lips / lip volume.
    TREATMENT SIGNALS: Filler, Dermal Filler, Radiesse.
    SCOPE GUARD: FACIAL volume and facial contour ONLY. Body fat, tummy fat, double-chin fat and
      body circumference go to "Body Contouring" — never here.

    ── 3. "Skin Texture" ──
    SYMPTOM TRIGGERS: enlarged pore size, rough or uneven texture, smile lines as fine surface
      etched lines, scars, acne scarring, sleep lines/pillow creases, crepey or papery skin
      (under-eyes, neck, chest/décolletage), dull skin, fine lines at rest, dehydrated/lacklustre skin.
    TREATMENT SIGNALS: Filler, Radiesse, DermaGlow, RestoraGlow Face, RestoraGlow Eyes, Peel,
      Stimulating Peel + LED, Genesis Glow.

    ── 4. "Skin Laxity" ──
    SYMPTOM TRIGGERS: sagging or drooping skin, jowls, loose skin under the chin, submental laxity,
      loss of jawline definition, saggy neck, loose or lax skin on the abdomen/tummy,
      loose skin on arms/thighs, skin that "hangs" or needs "lifting/tightening".
    TREATMENT SIGNALS: Ulthera, Firm & Contour Treatment, Firm & Hydrate Treatment,
      Skin Lifting, eSkin Tight.
    SCOPE GUARD: This is LOOSE SKIN. If the complaint is FAT or bulk rather than loose skin,
      use "Body Contouring".

    ── 5. "Redness / Sensitive Skin" ──
    SYMPTOM TRIGGERS: rosacea, sensitive or reactive skin, easily irritated skin, broken capillaries,
      telangiectasia, facial veins, flushing, blushing, persistent redness, stinging/burning skin.
    TREATMENT SIGNALS: Genesis Glow, OPL, Vascular laser, Soolantra, ZO Rozatrol, Azelaic acid, Finacea.

    ── 6. "Pigmentation" ──
    SYMPTOM TRIGGERS: melasma, sunspots, sun damage, freckles, age spots, brown patches,
      post-inflammatory hyperpigmentation, uneven skin tone.

    ── 7. "Collagen Replenishment" ──
    SYMPTOM TRIGGERS: general collagen loss, overall skin rejuvenation, preventative/maintenance
      "collagen building" with no other specific symptom named.
    NOTE: Use this ONLY when no more specific category above fits. It is the fallback, not the default.

    ── 8. "Body Contouring" ──
    SYMPTOM TRIGGERS: double chin fat, stubborn fat pockets, body sculpting, muscle toning,
      tummy/flank/thigh fat, circumference reduction.

    ── 9. "Active Acne" ──
    SYMPTOM TRIGGERS: active breakouts, pimples, congestion, blackheads, cystic acne, oily skin.
    NOTE: ACTIVE spots go here. Acne SCARRING goes to "Skin Texture".

    *** AMBIGUOUS TERMS — RESOLVE IN THIS ORDER ***
    - "jowls" / "jowling": if the treatment discussed is Ulthera, Firm & Contour Treatment,
      Firm & Hydrate Treatment, Skin Lifting or eSkin Tight → "Skin Laxity".
      If the treatment is Filler or Radiesse → "Volume Loss / Contours".
      If NO treatment is named → default to "Skin Laxity".
    - "smile lines": if described as a FOLD, or as nasolabial, or treated with Filler/Radiesse for
      volume → "Volume Loss / Contours". If described as fine surface lines, or treated with
      DermaGlow / RestoraGlow / Peel / Genesis Glow → "Skin Texture".
      Around the EYES on movement → "Expression Lines / Muscle Movement".
    - "neck": muscle bands → "Expression Lines / Muscle Movement".
      Crepey neck skin texture → "Skin Texture". Sagging/loose neck skin → "Skin Laxity".
    - "chin": muscle dimpling/pebbling → "Expression Lines / Muscle Movement".
      Recessed/weak projection → "Volume Loss / Contours".
      Loose skin under the chin → "Skin Laxity". Fat under the chin → "Body Contouring".
    - "jaw": heavy masseter muscle / bruxism / jaw slimming → "Expression Lines / Muscle Movement".
      Loss of jawline from loose skin → "Skin Laxity". Loss of jawline from volume → "Volume Loss / Contours".
    - "under the eyes": dark circles / hollowing / tear trough → "Volume Loss / Contours".
      Crepey or textured under-eye skin → "Skin Texture".
      Crow's feet / lines on smiling → "Expression Lines / Muscle Movement".
    - Filler and Radiesse appear under BOTH "Volume Loss / Contours" and "Skin Texture".
      They can NEVER decide the category on their own — the symptom must decide.
      Only if no symptom is recoverable at all, default Filler/Radiesse to "Volume Loss / Contours".
    - Genesis Glow appears under BOTH "Skin Texture" and "Redness / Sensitive Skin".
      Rosacea / flushing / capillaries → "Redness / Sensitive Skin". Pores / scars / dullness → "Skin Texture".

    Return a JSON OBJECT:
    {
      "intent": "One of: new_plan | reviewing_existing | none. Decide using the INTENT DECISION TREE above BEFORE filling anything else.",
      "discussion_notes": "Used ONLY when intent is reviewing_existing: a short factual summary of the review of the existing/prior plan. If a new treatment is mentioned in passing, note it here in words only — never as a concern. Empty string for all other intents.",
      "concerns": {
         "concern_a": { 
          "description": "Clear description of the concern including the specific area of face or body",
          "concern_category": "One of the 9 canonical category names listed above",
          "area": "ONLY the anatomical area(s) for this concern, comma separated, Title Case, no treatment names and no adjectives. Examples: 'Eyes', 'Crow's Feet, Frown', 'Full Face', 'Neck, Decolletage'. Empty string if no area is identifiable.",
            "treatment": "Treatment name AND treatment area. One line per point if multiple treatments.",
            "frequency_interval": "Frequency or interval only if mentioned. Empty string if not mentioned.",
            "quote": "Quote with treatment name, area, and number of treatments. More expensive quote first. Whole numbers = $ no decimals (e.g. 'one five nine five' = $1595). Dollars and cents = decimals (e.g. 'fifteen dollars ninety five' = $15.95). If a program/package: include program name, inclusions, and total price. Empty string if not mentioned.",
            "comments": "Additional comments or notes for this concern. Empty string if not mentioned."
         },
         "concern_b": { "description": "", "concern_category": "", "area": "", "treatment": "", "frequency_interval": "", "quote": "", "comments": "" },
        "concern_c": { "description": "", "concern_category": "", "area": "", "treatment": "", "frequency_interval": "", "quote": "", "comments": "" },
        "concern_d": { "description": "", "concern_category": "", "area": "", "treatment": "", "frequency_interval": "", "quote": "", "comments": "" },
        "concern_e": { "description": "", "concern_category": "", "area": "", "treatment": "", "frequency_interval": "", "quote": "", "comments": "" },
        "concern_f": { "description": "", "concern_category": "", "area": "", "treatment": "", "frequency_interval": "", "quote": "", "comments": "" }
      },
      "timeline": [
         { 
           "date": "Format as 'MMMM YYYY'. Calculate from the Record Date in your context. If transcript says 'in 2 weeks' add 2 weeks to the Record Date. If no specific date, use the earliest logical date.",
           "treatment": "Treatment name and area in bullet point format",
           "pretreatment_instructions": "Exact instruction text from the rules below. Empty string if treatment has no instructions."
         }
      ],
      "booking_comments": "Any comments about rebooking, holiday conflicts, or scheduling constraints. Empty string if none."
    }

    *** STRICT FORMATTING RULES ***
    
    - SMART DATES: Use the "Current Date of this recording" from your system context as the baseline for ALL date calculations. Do NOT use your own internal date.
    - ORDER concerns A → F strictly by patient priority from the transcript.
    - SKIP any field not mentioned — use empty string "".
    - QUOTE: Always include treatment name AND area. More expensive option listed first. Use $ only, never £.
    - TIMELINE: Chronological order, earliest date first. Format dates as "MMMM YYYY".
    - DO NOT repeat the treatment plan content. Each concern appears once only.
    - In the "description" and "treatment" fields, never write "facial movement lines" or "facial muscle movement" — always write "expression lines". This restriction does NOT apply to "concern_category", which must always be copied exactly as "Expression Lines / Muscle Movement".

    *** EXACT TREATMENT NAME REPLACEMENTS (apply everywhere) ***
    - Exilis / eSkin tightening / eSkin tight → "eSkin Tight" (never use the word Exilis)
    - Firm and Fresh → "Firm & Fresh Treatment"
    - Add on Firm and Fresh → "Add-on Firm & Fresh Treatment"
    - Firm and Contour / fomenclanto / femm and contour → "Firm & Contour Treatment"
    - Add on Firm and Contour → "Add-on Firm & Contour Treatment"
    - Firm and Hydrate → "Firm & Hydrate Treatment"
    - Add on Firm and Hydrate → "Add-on Firm & Hydrate Treatment"
    - High-Intensity Ultrasound / HIFU → "Skin Lifting" (never use HIFU)
    - Stimulating peel and LED → "Stimulating Peel + LED"
    - Botox → "Wrinkle Relaxer"
    - Jaw Muscle / Masseter Muscle Hypertrophy → "Wrinkle Relaxer for Jaw Muscle"
    - Clear complexion light laser / Compaction light → "Clear complexion Lite Laser" (never "light")
    - Hydro Repair / HydroRepair → "HydraRepair"
    - Radius → "Radiesse"
    - Ultherapy → "Ulthera"

    APPROVED EXACT NAMES (use these exact spellings):
    Clear complexion Max Laser, Clear complexion carbon Laser, Clear complexion Lite Laser, CoolSculpting, DermaGlow, OPL, Fat Dissolve Injection, Fat freezing, Filler, Dermal Filler, Genesis Glow, Hair Removal, HydraRepair, Laser Facial, Laser Tattoo Removal, LED, MediFacial, MonoThreads, Peel, PRP, Radiesse, ReFresh Microneedling, ReJuvaDerm Ageless, Rejuran, RestoraGlow Face, RestoraGlow Eyes, Skin Lifting, Skin Remodelling Face, Skin Remodelling Eyes, Skin Needling, TruSculpt Flex, TruSculpt iD, Ulthera, Vascular laser, Vanquish, Vibro, Wrinkle Relaxer,
    ZO Gentle Cleanser, ZO Exfoliating Cleanser, ZO Daily Power Defence, ZO Brightalive, ZO Retinol Skin Brightener, ZO Recovery Creme, ZO Hydrating Creme, ZO Firming serum, ZO Rozatrol, ZO Complexion Renewal Pads, ZO Growth Factor Serum, ZO Growth Factor Eye serum, ZO AOX serum, ZO Wrinkle & Texture Repair serum, Collagen Activator (may be called as Peptides treatment),
    Dermedica Hyaluronic serum, Dermedica UltraMoist moisturiser, Dermedica Gentle Soothing Cleanser, Dermedica Essential Cleanser, Dermedica ProB Plus serum,
    K-Ceutic cream, Soolantra, Azelaic acid, Finacea, Epiduo, Tranexamic acid tablet, Hydroquinone, Prescription.

    *** PRETREATMENT INSTRUCTIONS — output EXACTLY as written below in 'pretreatment_instructions' ***
    - Clear complexion Max Laser: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - Clear complexion carbon Laser: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - Clear complexion Lite Laser: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - DermaGlow Standard: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - DermaGlow Max: "Special instructions BEFORE your appointment: Use ALL the 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment. Buy this from Dermedica before the treatment so you can apply it at home. In addition, DO NOT get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - OPL: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - eSkin Tight: "Special instructions BEFORE your appointment: Drink at least 6 to 8 big glasses of water before you attend the clinic."
    - Dermal Filler / Filler / Radiesse: "Special instructions BEFORE your appointment: Stop taking the following 1 week before your appointment to minimise bruising- Fish oil, anti oxidants, green tea and anti inflammatories."
    - Firm & Contour Treatment: "Special instructions BEFORE your appointment: if you want to make the treatment more comfortable: You can take 1 to 2 tablets of Panadeine. In addition, you may apply ALL 2 tubes of numbing cream-LMX onto the treatment area 30 minutes before your appointment."
    - Genesis Glow: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - Hair Removal: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - HydraRepair: "Special instructions BEFORE your appointment: Use ALL the 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment."
    - Laser Tattoo Removal: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - MonoThreads: "Special instructions BEFORE your appointment: Use ALL the 2 tubes of numbing cream-LMX onto the full face 30 minutes before your appointment."
    - ReFresh Microneedling: "Special instructions BEFORE your appointment: Use ALL the 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment. Buy this from Dermedica before the treatment so you can apply it at home. Drink at least 6 to 8 big glasses of water before you attend the clinic."
    - ReJuvaDerm Ageless: "Special instructions BEFORE your appointment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment. We cannot treat over fake tan."
    - Rejuran: "Special instructions BEFORE your appointment: To make the treatment more comfortable, use ALL the 1 tube of numbing cream-LMX on the treatment area 30 minutes before your appointment. Buy this from Dermedica before the treatment so you can apply it at home."
    - RestoraGlow Face: "Special instructions BEFORE your appointment: Use ALL the 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment. Buy this from Dermedica before the treatment so you can apply it at home."
    - RestoraGlow Eyes: NO pre-treatment instructions. Leave pretreatment_instructions as empty string "".
    - Skin Lifting: "Special instructions BEFORE your appointment if you want to make the treatment more comfortable: You can take 1 to 2 tablets of Panadeine. In addition, apply ALL 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment."
    - Skin Remodelling Face: "Special instructions BEFORE your appointment: Use ALL the 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment. Buy this from Dermedica before the treatment so you can apply it at home."
    - Skin Remodelling Eyes: "Special instructions BEFORE your treatment: Numbing will be applied in the clinic. Stop taking the following 1 week before your appointment to minimise bruising- Fish oil, anti oxidants, green tea and anti inflammatories."
    - Skin Needling: "Special instructions BEFORE your treatment: Use ALL the 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment. Buy this from Dermedica before the treatment so you can apply it at home."
    - TruSculpt iD: "Special instructions BEFORE your treatment: Drink at least 6 to 8 big glasses of water before you attend the clinic."
    - Ulthera: "Special instructions BEFORE your treatment: if you want to make the treatment more comfortable: You can take 1 to 2 tablets of Panadeine. In addition, apply ALL 2 tubes of numbing cream-LMX on the treatment area 30 minutes before your appointment."
    - Vanquish: "Special instructions BEFORE your treatment: Drink at least 6 to 8 big glasses of water before you attend the clinic."
    - Vascular laser: "Special instructions BEFORE your treatment: Do not get a tan 4 weeks before treatment. If you use fake tan, you must completely remove this before the treatment."
    - Wrinkle Relaxer: "Special instructions BEFORE your treatment: If you are prone to bruising, stop taking the following 1 week before your appointment to minimise bruising- Fish oil, anti oxidants, green tea and anti inflammatories."
    - Laser Facial / Vibro / Stimulating Peel + LED / Peel / Firm & Fresh Treatment / Firm & Hydrate Treatment / LED / MediFacial / PRP / TruSculpt Flex / CoolSculpting / Fat freezing / Fat Dissolve Injection: NO pre-treatment instructions. Leave pretreatment_instructions as empty string "".
    `,

  social_history: `
    You are generating the SOCIAL HISTORY section.
    Return a JSON OBJECT.
    
    STRICT RULES:
    1. ***PRIORITY***: Actively look for the patient's job or workplace. (e.g., "PE Teacher" -> Occupation).
    2. Capture lifestyle habits (sun exposure, diet, smoking, alcohol).
    {
      "age": "",
      "occupation": "",
      "holiday_travel": "",
      "personal_life_events": "",
      "booking_related_comments": "",
      "other_relevant_social_history": "Include sun exposure frequency/habits here"
    }
    `,

  personality: `
    You are generating the PERSONALITY section.
    Return a JSON OBJECT:
    {
      "summary": "3-5 sentences on behavior/tone",
      "disc_profile": "DISC profile if determinable"
    }
    `,

  medication: `
    You are generating the MEDICATION section.
    Return a JSON OBJECT.

    STRICT RULES:
    1. ***CONVERSATIONAL CAPTURE***: If the clinician mentions a medication (e.g., "Any meds besides Dexamphetamine?") and the patient confirms or doesn't deny it, you MUST include it.
    2. Separate current baseline medications from newly prescribed items.
    3. ***ONE FACT PER FIELD — NEVER MERGE.*** Each field carries only its own data type:
       - "name": the drug name ONLY. No dose, no timing, no commentary. e.g. "Panadeine Forte"
       - "dose": strength and/or quantity ONLY. e.g. "500mg", "1-2 tablets". "" if not stated.
       - "frequency": timing ONLY, MAXIMUM 12 WORDS. e.g. "PRN", "Twice daily", "30 min before treatment". "" if not stated.
       - "indication": what it is for, MAXIMUM 8 WORDS. e.g. "Procedural pain relief". "" if not stated.
       - "notes": ONE short caveat the clinician must action, MAXIMUM 25 WORDS. "" if there is nothing to flag.
    4. ***NEVER WRITE YOUR REASONING INTO THE RECORD.*** The following are BANNED in every field of this section:
       "Note:", "Transcript says", "Clarify if", "For now, documenting as", "as per transcript",
       "it is unclear", "may be", "assuming", or any sentence about what you decided to do.
       If a drug name is ambiguous, put the transcribed name in "name" and ONE imperative caveat in "notes"
       (e.g. "Confirm Panadeine vs Panadeine Forte") — nothing more.
    5. Patient counselling and logistics (driving advice, arrive-early instructions, how long effects last)
       are NOT medication fields. They belong in the clinical notes / booking sections. Leave them out here.
    6. Any field not stated in the transcript returns "". Never invent, never pad, never explain.

    {
      "current_medications": [ { "name": "", "dose": "", "frequency": "", "indication": "", "notes": "" } ],
      "new_medications":     [ { "name": "", "dose": "", "frequency": "", "indication": "", "notes": "" } ]
    }
    `,

  medical_conditions: `
    You are generating the MEDICAL CONDITIONS section.
    Return a JSON ARRAY of strings:
    [ "Condition 1", "Condition 2" ]
    `,

  allergies: `
    You are generating the ALLERGIES section.
    Return a JSON ARRAY of objects.

    STRICT RULES:
    1. ONLY include an entry if a specific allergy or allergic reaction is explicitly mentioned in the transcript.
    2. If no allergy is mentioned, or the patient says they have no allergies, return an EMPTY ARRAY: []
    3. Do NOT record "No allergies", "None", "Nil", "No known allergies", or any equivalent negative statement as an entry.
    4. Only real, named substances with a confirmed or implied reaction qualify.

    [ { "substance": "", "reaction": "" } ]
    `,

  treatment_info_to_email: `
    You are generating the TREATMENT INFO TO EMAIL section.
    Trigger: Look for ANY phrase indicating the staff will email or send treatment information to the patient (e.g., "I'll email you the info", "information I'll be sending", "sending you an email").
    Return a JSON ARRAY of strings containing the specific treatments/info mentioned from the approved list.
    `,

  book_next_appointment: `
    You are generating the BOOK NEXT APPOINTMENT section.
    Return a JSON ARRAY of objects:
    [ { "appointment_number": "Appt 1", "date_range": "", "treatment_and_area": "" } ]
    `,

  personal_notes: `
    You are generating the PERSONAL NOTES section.
    Capture the patient's PERSONAL PREFERENCES and comfort items that staff should remember and repeat at EVERY future visit.

    INCLUDE things like:
    1. Comfort/setup preferences (e.g., "Place a rolled towel under the neck", "Apply ice pack prior to treatment", "Prefers firm pressure", "Prefers room warm").
    2. Companions, people, or pets the patient brings or mentions bringing each time (e.g., "Always brings her pet cat for calmness", "Daughter Sarah attends with her").
    3. Names the patient mentions that staff should remember (family members, carers, pets).
    4. Any recurring treatment-delivery preference or ritual the patient requests.

    STRICT RULES:
    - Return a JSON ARRAY of short strings. Each string is ONE preference, written as an actionable reminder for staff (e.g., "Apply ice pack prior to treatment (patient preference)").
    - Do NOT include clinical findings, medications, conditions, allergies, pricing, or booking details — those belong in other sections.
    - If no personal preferences are mentioned, return an EMPTY ARRAY: []
    `
};

function getProductNames() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(PRODUCT_SHEET_NAME);
    if (!sheet) return []; // Return empty if sheet doesn't exist

    // Get range A2 to A (last row)
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    // Flatten array and filter out empty cells
    const products = values.flat().filter(p => p !== "" && p !== null);
    return products;
  } catch (e) {
    Logger.log("Error fetching product names: " + e.toString());
    return []; // Fail gracefully with empty list
  }
}
/**
 * Wraps UrlFetchApp.fetch with retry + fallback logic for Gemini 503/429 errors.
 * Retries Pro 3 times, then falls back to Flash.
 */
function fetchGeminiWithRetry_(url, options, maxRetries) {
  maxRetries = maxRetries || 3;
  var delays = [3000, 8000, 20000]; // 3s → 8s → 20s (tighter to avoid Apps Script timeout)

  // --- Primary model retries ---
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();

    if (code >= 200 && code < 300) return resp;

    if ((code === 503 || code === 429) && attempt < maxRetries) {
      var waitMs = delays[attempt] || 45000;
      console.warn('Gemini ' + code + ' on attempt ' + (attempt + 1) + '. Retrying in ' + (waitMs / 1000) + 's...');
      Utilities.sleep(waitMs);
      continue;
    }

    // Non-retryable — throw immediately
    if (code !== 503 && code !== 429) {
      throw new Error('Gemini HTTP ' + code + ': ' + resp.getContentText().slice(0, 500));
    }
  }

  // --- Fallback: swap Pro → Flash after retries exhausted ---
  console.warn('gemini-2.5-pro exhausted all retries. Falling back to gemini-2.5-flash...');
  var fallbackUrl = url.replace(GEMINI_MODEL, 'gemini-2.5-flash');
  if (fallbackUrl === url) {
    throw new Error('Gemini: primary model exhausted and no fallback could be built ' +
                    '(GEMINI_MODEL="' + GEMINI_MODEL + '" is already the fallback, or the URL did not match).');
  }
  var fallbackDelays = [3000, 10000];

  for (var fb = 0; fb <= 2; fb++) {
    var fbResp = UrlFetchApp.fetch(fallbackUrl, options);
    var fbCode = fbResp.getResponseCode();

    if (fbCode >= 200 && fbCode < 300) {
      console.warn('gemini-2.5-flash fallback succeeded on attempt ' + (fb + 1));
      return fbResp;
    }

    if ((fbCode === 503 || fbCode === 429) && fb < 2) {
      var fbWait = fallbackDelays[fb] || 10000;
      console.warn('Flash fallback ' + fbCode + ' on attempt ' + (fb + 1) + '. Retrying in ' + (fbWait / 1000) + 's...');
      Utilities.sleep(fbWait);
      continue;
    }

    throw new Error('Gemini fallback (flash) HTTP ' + fbCode + ': ' + fbResp.getContentText().slice(0, 500));
  }

  // Safety net: should never reach here, but guarantees we never return undefined
  throw new Error('Gemini: all retries and fallbacks exhausted with no response.');
}

function callGeminiComplex(transcript, dateContext) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const dateObj = dateContext ? new Date(dateContext) : new Date();
  const dateStr = Utilities.formatDate(dateObj, "Australia/Perth", "EEEE, MMMM d, yyyy");

  // 1. Fetch Skincare Products
  const productList = getProductNames();
  const productListString = productList.length > 0 ? productList.join(", ") : "None provided";

  const skinHealthPrompt = `
    You are generating the SKIN SCRIPT PROTOCOL (Home Care).
    Return a JSON OBJECT.
    Rules:
    - Only include home skincare products here.
    - **CRITICAL**: Map any mentioned product to the CLOSEST match in the "Official Product List" below.
    *** OFFICIAL PRODUCT LIST ***
    ${productListString}
  `;

  // 2. NEW: Fetch dynamic treatment names for email mapping
  let treatmentListString = "None provided";
  try {
    const tcRes = getTreatmentConfigs(); // Pulls directly from your new configuration sheet
    if (tcRes.status === 'success' && tcRes.data && tcRes.data.length > 0) {
      treatmentListString = tcRes.data.map(t => t.name).join(", ");
    }
  } catch (e) {
    console.warn("Failed to fetch treatment configs for AI prompt");
  }

  // 3. NEW: Override the generic prompt with a strictly mapped one
  const treatmentInfoPrompt = `
    You are generating the TREATMENT INFO TO EMAIL section.
    Return a JSON ARRAY of OBJECTS: [{ "name": "", "dynamic_areas": [{ "areaName": "", "quote": "", "comment": "" }] }]

    *** WHEN TO INCLUDE A TREATMENT ***
    Include a treatment if ANY of these are true in the transcript:
      (a) The clinician explicitly says they will email/send info about it ("I'll email you the info", "let me send that through", "I'll follow up with details").
      (b) The clinician recommends it as a real option for this patient (e.g., "you could try skin needling", "what I'd suggest is...", "a good option would be...", "we're going to do...").
      (c) The clinician gives a QUOTE, PRICE, or FREQUENCY for a specific treatment (even without an explicit offer to email).
    If none of (a), (b), or (c) apply, do NOT include the treatment.

    *** CRITICAL RULE #1: TREATMENT NAME IS LOCKED ***
    The "name" field MUST be an EXACT, character-for-character copy of one entry from the OFFICIAL TREATMENT LIST below.
    - Do NOT invent, shorten, pluralise, or rephrase names.
    - Do NOT split compound names (e.g., "Acne/acne scarring" stays as one).
    - If a mentioned treatment does not match any entry in the list, DROP IT. Do not guess.
    - Matching is fuzzy on the INPUT side. The clinician or transcript may have MISSPELLED or MIS-TRANSCRIBED the treatment name due to audio-to-text errors. Be generous:
        • "needling" → "Skin Needling"
        • "peptides", "peptide", "peptide treatment", "collagen activator", "collagen activation" → "Collagen Activator"
        • "RestoreGlow", "Restore Glow", "Restora glow" → "RestoraGlow" (if that's in the list)
        • "Ultra therapy", "Ulthera", "ultherapy" → "Ultherapy"
      Use phonetic similarity and partial matching to find the correct official name.

    *** HARD GUARD — DO NOT CONFUSE THESE TWO TREATMENTS ***
    "Collagen Activator" (also called "Peptides" / "Peptide treatment") and "Skin Needling" are DIFFERENT treatments.
    NEVER map "Collagen Activator", "Collagen Activation", "Peptides", or "Peptide" to "Skin Needling".
    If the clinician says "Collagen Activator" or "Peptides", the name MUST be "Collagen Activator" — only if that exact name is in the OFFICIAL TREATMENT LIST below. If it is not in the list, DROP it; never substitute "Skin Needling".

    *** CRITICAL RULE #2: ALWAYS POPULATE dynamic_areas WHEN ANY DETAIL EXISTS ***
    This rule is MANDATORY. You MUST create at least ONE entry in "dynamic_areas" if ANY of the following were mentioned for this treatment:
      - A body area ("for your eyes", "on the face", "the chest")
      - A price or quote ("$499", "four ninety-nine", "1400 per session")
      - A frequency, session count, or interval ("once a year", "two series", "one month apart", "every 4 weeks")
      - A comment, caveat, or rationale ("this addresses rejuvenation", "for glowing skin")

    NEVER return an empty "dynamic_areas": [] array if a price, frequency, OR area was mentioned. This is the #1 failure mode — avoid it.

    Only return "dynamic_areas": [] if the treatment was named with ZERO other detail (e.g., "I'll email you info on LED therapy" — nothing else said).

    *** FIELD GUIDANCE ***
    - "areaName": The body area mentioned (e.g., "Full Face", "Eyes", "Chest"). Empty string "" if no area was mentioned. DO NOT skip the entry just because the area is empty — still create the entry if there's a quote or comment.
    - "quote": The PRICE or QUOTE. Number rules (same as treatment_plan section):
         • Whole numbers = $ no decimals. e.g. "four ninety-nine" = "$499", "fourteen hundred" = "$1400", "one five nine five" = "$1595"
         • Dollars and cents = decimals. e.g. "fifteen dollars ninety five" = "$15.95"
         • Include "per treatment" / "per session" if said.
         • Empty string "" if no price was mentioned.
    - "comment": ANY other info — frequency, number of sessions, intervals, downtime, expected results, rationale, caveats. Combine into ONE string with line breaks (\\n). Empty string "" if nothing else was said.

    *** WORKED EXAMPLE (pay close attention — this matches the style of real transcripts) ***
    Transcript: "You're going to have a RestoreGlow treatment. This is gonna be for your eyes. As I mentioned last time, this is gonna be 499 per treatment. We're gonna do two series, one month apart. At the same time, for total rejuvenation, we will do Ultherapy. So Ultherapy is basically 1,400 per session. We're gonna do that once a year. This addresses the entire facial rejuvenation."

    Correct output:
    [
      {
        "name": "RestoraGlow",
        "dynamic_areas": [{
          "areaName": "Eyes",
          "quote": "$499 per treatment",
          "comment": "2 sessions, 1 month apart"
        }]
      },
      {
        "name": "Ultherapy",
        "dynamic_areas": [{
          "areaName": "",
          "quote": "$1400 per session",
          "comment": "Once a year\\nAddresses entire facial rejuvenation"
        }]
      }
    ]

    Notice: Ultherapy had NO specific area mentioned but DID have a price and comment — so dynamic_areas still has ONE entry with areaName: "".

    *** OFFICIAL TREATMENT LIST (use these names EXACTLY) ***
    ${treatmentListString}
  `;

  // 4. Build the final Master Instruction
  const systemInstruction = `
    You are an expert Medical Scribe.
    *** CRITICAL CONTEXT ***
    - The Current Date of this recording is: ${dateStr}
    - ALL relative dates MUST be calculated based on this Current Date.
    *** DATA CATEGORIZATION PRIORITY RULES (STRICT) ***
    1. EXCLUSIVITY: If a fact belongs in a specific JSON section (Medication, Social History, Medical Conditions, Allergies), it MUST be placed there and MUST NOT appear in the "subjective" string.
    2. OCCUPATION: Any mention of a job title (e.g., "PE Teacher") or workplace MUST be placed in "social_history.occupation".
    3. CONVERSATIONAL MEDS: If a clinician asks about a medication (e.g., "Any meds besides dexamphetamine?") and it is confirmed or not denied, it MUST be captured in "medication.current_medications".
    4. EMPTY SECTIONS: If no relevant data is found for a section, return empty strings ("") or empty arrays ([]).
    Analyze the transcript and adhere strictly to these instructions:
    1. "subjective": ${SOAP_PROMPTS.subjective}
    2. "objective": ${SOAP_PROMPTS.objective}
    3. "assessment": ${SOAP_PROMPTS.assessment}
    4. "treatment_plan": ${SOAP_PROMPTS.treatment_plan}
    5. "skin_health_protocol": ${skinHealthPrompt}
    6. "social_history": ${SOAP_PROMPTS.social_history}
    7. "personality": ${SOAP_PROMPTS.personality}
    8. "medication": ${SOAP_PROMPTS.medication}
    9. "medical_conditions": ${SOAP_PROMPTS.medical_conditions}
    10. "allergies": ${SOAP_PROMPTS.allergies}
    11. "treatment_info_to_email": ${treatmentInfoPrompt}
    12. "book_next_appointment": ${SOAP_PROMPTS.book_next_appointment}
    13. "personal_notes": ${SOAP_PROMPTS.personal_notes}
    14. "referral": Return an object with three string fields:
        - "referred_by": the NAME of whoever referred THIS patient to the clinic, if explicitly mentioned. Otherwise "".
        - "referral_given": the NAME of anyone this patient says they are referring or recommending to the clinic, if explicitly mentioned. Otherwise "".
        - "relationship_type": how that person is related to THIS patient, IF stated. Use EXACTLY one of: Mother, Father, Daughter, Son, Sister, Brother, Spouse, Partner, Friend, Other. Otherwise "".
        Use "" for any field not mentioned. Do NOT guess.
  `;

  const generationConfig = {
    temperature: 0.3,
    maxOutputTokens: 65536,
    thinkingConfig: { thinkingBudget: 8192 },
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        subjective: { type: "STRING" },
        objective: { type: "STRING" },
        assessment: { type: "STRING" },
        treatment_plan: {
          type: "OBJECT",
          properties: {
            intent: { type: "STRING", enum: ["new_plan", "reviewing_existing", "none"] },
            discussion_notes: { type: "STRING" },
            concerns: {
              type: "OBJECT",
              properties: {
                concern_a: { type: "OBJECT", properties: { description: { type: "STRING" }, concern_category: { type: "STRING" }, area: { type: "STRING" }, treatment: { type: "STRING" }, frequency_interval: { type: "STRING" }, quote: { type: "STRING" }, comments: { type: "STRING" } }, required: ["description", "concern_category", "area", "treatment", "frequency_interval", "quote", "comments"] },
                concern_b: { type: "OBJECT", properties: { description: { type: "STRING" }, concern_category: { type: "STRING" }, area: { type: "STRING" }, treatment: { type: "STRING" }, frequency_interval: { type: "STRING" }, quote: { type: "STRING" }, comments: { type: "STRING" } }, required: ["description", "concern_category", "area", "treatment", "frequency_interval", "quote", "comments"] },
                concern_c: { type: "OBJECT", properties: { description: { type: "STRING" }, concern_category: { type: "STRING" }, area: { type: "STRING" }, treatment: { type: "STRING" }, frequency_interval: { type: "STRING" }, quote: { type: "STRING" }, comments: { type: "STRING" } }, required: ["description", "concern_category", "area", "treatment", "frequency_interval", "quote", "comments"] },
                concern_d: { type: "OBJECT", properties: { description: { type: "STRING" }, concern_category: { type: "STRING" }, area: { type: "STRING" }, treatment: { type: "STRING" }, frequency_interval: { type: "STRING" }, quote: { type: "STRING" }, comments: { type: "STRING" } }, required: ["description", "concern_category", "area", "treatment", "frequency_interval", "quote", "comments"] },
                concern_e: { type: "OBJECT", properties: { description: { type: "STRING" }, concern_category: { type: "STRING" }, area: { type: "STRING" }, treatment: { type: "STRING" }, frequency_interval: { type: "STRING" }, quote: { type: "STRING" }, comments: { type: "STRING" } }, required: ["description", "concern_category", "area", "treatment", "frequency_interval", "quote", "comments"] },
                concern_f: { type: "OBJECT", properties: { description: { type: "STRING" }, concern_category: { type: "STRING" }, area: { type: "STRING" }, treatment: { type: "STRING" }, frequency_interval: { type: "STRING" }, quote: { type: "STRING" }, comments: { type: "STRING" } }, required: ["description", "concern_category", "area", "treatment", "frequency_interval", "quote", "comments"] }
              },
              required: ["concern_a", "concern_b", "concern_c", "concern_d", "concern_e", "concern_f"]
            },
            timeline: { type: "ARRAY", items: { type: "OBJECT", properties: { date: { type: "STRING" }, treatment: { type: "STRING" }, pretreatment_instructions: { type: "STRING" } }, required: ["date", "treatment", "pretreatment_instructions"] } },
            booking_comments: { type: "STRING" }
          },
          required: ["intent", "discussion_notes", "concerns", "timeline", "booking_comments"]
        },
        skin_health_protocol: {
          type: "OBJECT",
          properties: {
            products: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, instruction: { type: "STRING" } } } },
            comments: { type: "STRING" }
          }
        },
        social_history: {
          type: "OBJECT",
          properties: { age: { type: "STRING" }, occupation: { type: "STRING" }, holiday_travel: { type: "STRING" }, personal_life_events: { type: "STRING" }, booking_related_comments: { type: "STRING" }, other_relevant_social_history: { type: "STRING" } }
        },
        personality: { type: "OBJECT", properties: { summary: { type: "STRING" }, disc_profile: { type: "STRING" } } },
        medication: {
          type: "OBJECT",
          properties: {
            current_medications: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, dose: { type: "STRING" }, frequency: { type: "STRING" }, indication: { type: "STRING" }, notes: { type: "STRING" } } } },
            new_medications: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, dose: { type: "STRING" }, frequency: { type: "STRING" }, indication: { type: "STRING" }, notes: { type: "STRING" } } } }
          }
        },
        medical_conditions: { type: "ARRAY", items: { type: "STRING" } },
        allergies: { type: "ARRAY", items: { type: "OBJECT", properties: { substance: { type: "STRING" }, reaction: { type: "STRING" } } } },
        treatment_info_to_email: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              dynamic_areas: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    areaName: { type: "STRING" },
                    quote: { type: "STRING" },
                    comment: { type: "STRING" }
                  },
                  required: ["areaName", "quote", "comment"]
                }
              }
            },
            required: ["name", "dynamic_areas"]
          }
        },
        book_next_appointment: { type: "ARRAY", items: { type: "OBJECT", properties: { appointment_number: { type: "STRING" }, date_range: { type: "STRING" }, treatment_and_area: { type: "STRING" } } } },
        personal_notes: { type: "ARRAY", items: { type: "STRING" } },
        referral: {
          type: "OBJECT",
          properties: {
            referred_by:       { type: "STRING" },
            referral_given:    { type: "STRING" },
            relationship_type: { type: "STRING" }
          },
          required: ["referred_by", "referral_given", "relationship_type"]
        }
      },
      // THIS ARRAY FORCES GEMINI TO POPULATE EVERY BOX
      required: ["subjective", "objective", "assessment", "treatment_plan", "skin_health_protocol", "social_history", "personality", "medication", "medical_conditions", "allergies", "treatment_info_to_email", "book_next_appointment", "personal_notes", "referral"]
    }
  };

  const payload = {
    contents: [{ parts: [{ text: `TRANSCRIPT:\n"${transcript}"` }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: generationConfig
  };

  const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };
  const response = fetchGeminiWithRetry_(url, options);
  const json = JSON.parse(response.getContentText());

  if (json.error) throw new Error("Gemini API: " + json.error.message);

  const candidate = json.candidates?.[0];
  const finishReason = candidate?.finishReason || "";
  let rawText = candidate?.content?.parts?.[0]?.text || "";

  if (!rawText) {
    throw new Error("Gemini returned no text. finishReason=" + finishReason +
      " promptFeedback=" + JSON.stringify(json.promptFeedback || {}));
  }
  if (finishReason && finishReason !== "STOP") {
    throw new Error("Gemini stopped early (finishReason=" + finishReason +
      "). JSON likely truncated — raise maxOutputTokens or shorten the transcript.");
  }

  rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error("Gemini returned invalid JSON (finishReason=" + finishReason +
      "). First 300 chars: " + rawText.slice(0, 300));
  }
}


/**
 * Converts the Strict JSON output into a clean, saveable string.
 * Uses strict type-casting to prevent silent failures.
 */
function formatSoapFromJSON(data) {
  if (!data || typeof data !== 'object') return "";
  let t = "";

  const subj = String(data.subjective || "").trim();
  const obj = String(data.objective || "").trim();
  const assess = String(data.assessment || "").trim();

  if (subj) t += "!!CLINICAL NOTES:\n" + subj + "\n\n";
  if (obj) t += "Objective:\n" + obj + "\n\n";
  if (assess) t += "Assessment & Plan:\n" + assess + "\n\n";

  if (data.skin_health_protocol?.products?.length > 0 || data.skin_health_protocol?.comments) {
    t += "SKIN SCRIPT PROTOCOL (HOME CARE):\n";
    if (Array.isArray(data.skin_health_protocol.products)) {
      data.skin_health_protocol.products.forEach(p => {
        const pName = String(p?.name || "").trim();
        if (pName) t += `- ${pName}: ${String(p.instruction || '').trim()}\n`;
      });
    }
    const sComm = String(data.skin_health_protocol.comments || "").trim();
    if (sComm) t += `(${sComm})\n`;
    t += "\n\n";
  }

  const soc = data.social_history;
  if (soc && typeof soc === 'object') {
    let socText = "";
    if (soc.age) socText += `Age: ${String(soc.age).trim()}\n`;
    if (soc.occupation) socText += `Occupation: ${String(soc.occupation).trim()}\n`;
    if (soc.holiday_travel) socText += `Holidays: ${String(soc.holiday_travel).trim()}\n`;
    if (soc.personal_life_events) socText += `Personal life events: ${String(soc.personal_life_events).trim()}\n`;
    if (soc.other_relevant_social_history) socText += `Other: ${String(soc.other_relevant_social_history).trim()}\n`;
    if (soc.booking_related_comments) socText += `Booking notes: ${String(soc.booking_related_comments).trim()}\n`;
    if (socText) t += "!!SOCIAL HISTORY:\n" + socText + "\n";
  }

  if (data.personality?.summary) {
    t += "!!PERSONALITY:\n" + String(data.personality.summary).trim() + "\n";
    if (data.personality.disc_profile) t += "DISC: " + String(data.personality.disc_profile).trim() + "\n";
    t += "\n";
  }

  if (data.medication && typeof data.medication === 'object') {
    let medText = "";
    // One fact per segment. The old template glued name+dose+frequency with raw spaces,
    // so a blank dose left a double space and a long frequency swallowed the line.
    const medLine = (m) => {
      if (!m) return "";
      const g = (k) => String((typeof m === 'string' ? (k === 'name' ? m : "") : (m[k] || ""))).trim();
      const nm = g('name'), dose = g('dose'), freq = g('frequency');
      const ind = g('indication'), note = g('notes');
      if (!nm && !dose && !freq && !note) return "";
      let line = "- " + (nm || "Unnamed medication");
      const detail = [dose, freq].filter(String).join(" \u00b7 ");
      if (detail) line += " \u2014 " + detail;
      if (ind) line += " (" + ind + ")";
      line += "\n";
      if (note) line += "  Note: " + note + "\n";
      return line;
    };

    if (Array.isArray(data.medication.current_medications) && data.medication.current_medications.length > 0) {
      const currentMeds = data.medication.current_medications.map(medLine).join("");
      if (currentMeds) medText += "Current:\n" + currentMeds;
    }

    if (Array.isArray(data.medication.new_medications) && data.medication.new_medications.length > 0) {
      const newMeds = data.medication.new_medications.map(medLine).join("");
      if (newMeds) medText += "New:\n" + newMeds;
    }
    if (medText) t += "!!MEDICATION:\n" + medText + "\n";
  }

  if (Array.isArray(data.medical_conditions) && data.medical_conditions.length > 0) {
    let condText = "";
    data.medical_conditions.forEach(c => {
      const cClean = String(c || "").trim();
      if (cClean) condText += `- ${cClean}\n`;
    });
    if (condText) t += "!!MEDICAL CONDITIONS:\n" + condText + "\n";
  }

  if (Array.isArray(data.allergies) && data.allergies.length > 0) {
    let algText = "";
    data.allergies.forEach(a => {
      const aName = String(a?.substance || "").trim();
      if (aName) algText += `- ${aName}: ${String(a.reaction || '').trim()}\n`;
    });
    if (algText) t += "!!ALLERGIES:\n" + algText + "\n";
  }

  if (Array.isArray(data.treatment_info_to_email) && data.treatment_info_to_email.length > 0) {
    let emailText = "";
    data.treatment_info_to_email.forEach(e => {
      const eObj = (typeof e === 'string') ? { name: e } : e;
      const eName = String(eObj.name || "").trim();
      if (eName) {
        emailText += `${eName}\n`;
        if (Array.isArray(eObj.dynamic_areas)) {
          eObj.dynamic_areas.forEach(area => {
            const aName = String(area?.areaName || "").trim();
            const aQuote = String(area?.quote || "").trim();
            const aComment = String(area?.comment || "").trim();
            if (aName || aQuote || aComment) {
              emailText += `  * Area: ${aName}\n`;
              if (aQuote) emailText += `    Quote: ${aQuote}\n`;
              if (aComment) emailText += `    Comment: ${aComment.replace(/\n/g, ' | ')}\n`;
            }
          });
        }
      }
    });
    if (emailText) t += "!!TREATMENT INFORMATION TO EMAIL:\n" + emailText + "\n";
  }

  if (data.treatment_plan && typeof data.treatment_plan === 'object') {
    const tp = data.treatment_plan;
    let hasPlan = false;
    let planText = "";

    const tpIntent = String(tp.intent || "").trim().toLowerCase();
    if (tpIntent === 'reviewing_existing') {
      const reviewNotes = String(tp.discussion_notes || "").trim();
      t += "!!TREATMENT PLAN:\nREVIEW OF EXISTING PLAN (no new plan generated)\n";
      if (reviewNotes) t += reviewNotes + "\n";
      t += "\n";
    } else {

      if (tp.concerns && typeof tp.concerns === 'object' && Object.keys(tp.concerns).length > 0) {
        Object.keys(tp.concerns).sort().forEach(k => {
          const c = tp.concerns[k];
          if (!c) return;
          const treat = String(c.treatment || "").trim();
          const desc = String(c.description || "").trim();

          if (treat || desc) {
            hasPlan = true;
            const cat = String(c.concern_category || "").trim();
            const heading = (cat && desc) ? `${cat} — ${desc}` : (cat || desc);
            planText += `${k.toUpperCase().replace('_', ' ')}: ${heading}\n`;
            if (String(c.area || "").trim()) planText += `AREA: ${String(c.area).trim()}\n`;
            if (treat) planText += `TREATMENT:\n${treat}\n`;
            if (c.frequency_interval) planText += `FREQUENCY/INTERVAL:\n${String(c.frequency_interval).trim()}\n`;
            if (c.quote) planText += `QUOTE:\n${String(c.quote).trim()}\n`;
            if (c.comments) planText += `Comments:\n${String(c.comments).trim()}\n`;
            planText += "\n";
          }
        });
      }

      if (Array.isArray(tp.timeline) && tp.timeline.length > 0) {
        hasPlan = true;
        planText += "SUGGESTED TIMELINE:\n";
        tp.timeline.forEach(item => {
          const date = String(item?.date || "").trim();
          const treat = String(item?.treatment || "").trim();
          if (date || treat) {
            planText += `${date}\n`;
            planText += `- ${treat}\n`;
            if (item.pretreatment_instructions) {
              const cleanInstructions = String(item.pretreatment_instructions).trim();
              if (cleanInstructions) planText += `${cleanInstructions}\n`;
            }
            planText += "\n";
          }
        });
      }
      if (hasPlan) t += "!!TREATMENT PLAN:\n" + planText;
    }
  }

  if (Array.isArray(data.book_next_appointment) && data.book_next_appointment.length > 0) {
    let bookText = "";
    data.book_next_appointment.forEach(b => {
      const apptNum = String(b?.appointment_number || "").trim();
      if (apptNum) {
        bookText += `${apptNum}:\nDate Range: ${String(b.date_range || "").trim()}\nTreatment and area: ${String(b.treatment_and_area || "").trim()}\n\n`;
      }
    });
    if (bookText) t += "!!BOOK NEXT APPOINTMENT:\n" + bookText;
  }

  // --- STRUCTURED SIDECAR ---
  // The frontend previously wrote this only on a manual Save, so any record opened
  // before someone clicked Save fell back to flat text. Writing it here means every
  // record rehydrates into rich cards straight out of Phase 3 / regenerate.
  // Encoding must mirror the frontend: btoa(unescape(encodeURIComponent(json))).
  try {
    const sidecar = {
      email: Array.isArray(data.treatment_info_to_email) ? data.treatment_info_to_email : [],
      plan: (data.treatment_plan && typeof data.treatment_plan === 'object') ? data.treatment_plan : null
    };
    const encoded = Utilities.base64Encode(JSON.stringify(sidecar), Utilities.Charset.UTF_8);
    t = t.trim() + "\n\n<!--STRUCTURED_SIDECAR:" + encoded + "-->";
  } catch (e) {
    console.warn("Sidecar build failed: " + e);
  }

  return t.trim();
}

/**
 * Emails the onsite team to verify a referral picked up from a transcript.
 * Builds one "referral card" per direction found (referred_by / referral_given).
 * If the mentioned name matches EXACTLY ONE patient in patient_list, the card
 * shows a one-click "Yes" that creates the relationship via the Team app.
 * Otherwise it only offers "Open in Team app to clarify".
 */
function sendReferralNotification_(patientName, patientId, referral, staffName) {
  try {
    if (!referral) return;
    const referredBy    = (referral.referred_by    || "").trim();
    const referralGiven = (referral.referral_given || "").trim();
    const relType       = (referral.relationship_type || "").trim(); // "" -> Team app defaults to "Other"
    if (!referredBy && !referralGiven) return; // nothing to notify

    const pidA   = (patientId   || "").toString().trim();
    const nameA  = (patientName || "").toString().trim();
    const staff  = (staffName   || "").toString().trim();
    const dateStr = Utilities.formatDate(new Date(), "Australia/Perth", "dd MMM yyyy");

    let cards = "";
    if (referredBy)    cards += referralCard_(pidA, nameA, referredBy,    "OTHER_REFERRED_THIS", "B_REFERRED_A", relType, staff);
    if (referralGiven) cards += referralCard_(pidA, nameA, referralGiven, "THIS_REFERRED_OTHER", "A_REFERRED_B", relType, staff);

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;">' +
        '<div style="background:#4f46e5;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">' +
          '<h2 style="margin:0;font-size:18px;">Referral to Verify</h2>' +
        '</div>' +
        '<div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px;">' +
          '<p style="margin:0 0 6px;">Attention Onsite Team,</p>' +
          '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Patient: <strong>' + (nameA || "(unknown)") + '</strong> &nbsp;|&nbsp; ' + dateStr + (staff ? ' &nbsp;|&nbsp; Logged by ' + staff : '') + '</p>' +
          cards +
          '<p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">Automated notification from the Dermedica Recorder.</p>' +
        '</div>' +
      '</div>';

    MailApp.sendEmail({
      to: "info@dermedica.com.au",
      subject: "Referral to verify — " + (nameA || "Patient"),
      htmlBody: html,
      name: "Dermedica Recorder"
    });
  } catch (e) {
    console.error("Referral notification failed:", e); // non-fatal
  }
}

/** Deployed Team app /exec URL (handles confirmReferral + openRelationship). */
const TEAM_APP_URL = "https://script.google.com/macros/s/AKfycbw2L0uAVRwz_jyorl1lb7HxBeLZvRdW_H3WWy_FWr7MrgZekIAIfoiRPh1FkDciKzBA/exec";

/** Builds one referral card (Yes/clarify buttons) for a single mentioned name. */
function referralCard_(pidA, nameA, mentionedName, relDir, referralCode, relType, staff) {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const directionLabel = (relDir === "OTHER_REFERRED_THIS") ? "Referred by" : "Referral given to";
  const q = (obj) => Object.keys(obj).map((k) => k + "=" + encodeURIComponent(obj[k])).join("&");

  // Resolve the mentioned name against patient_list
  let match = null, ambiguous = false;
  try {
    const matches = findPatientMatchesByName_(mentionedName);
    if (matches.length === 1) match = matches[0];
    else if (matches.length > 1) ambiguous = true;
  } catch (e) {}

  // Clarify link — always available
  const clarifyUrl = TEAM_APP_URL + "?" + q({
    action: "openRelationship",
    pid: pidA, pname: nameA,
    relName: mentionedName, relType: relType, relDir: relDir
  });
  const btnClarify =
    '<a href="' + clarifyUrl + '" style="display:inline-block;background:#fff;border:1px solid #6366f1;color:#4f46e5;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;">Open in Team app to clarify</a>';

  let statusLine, btnYes = "";
  if (match && pidA) {
    const yesUrl = TEAM_APP_URL + "?" + q({
      action: "confirmReferral",
      pidA: pidA, nameA: nameA,
      pidB: match.id, nameB: match.name,
      relType: relType, referral: referralCode,
      createdBy: (staff ? staff + " (email)" : "Referral email")
    });
    btnYes =
      '<a href="' + yesUrl + '" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;margin-right:8px;">&#10003; Yes, that&rsquo;s correct</a>';
    statusLine = 'Matched to <strong>' + esc(match.name) + '</strong> in the database.';
  } else if (ambiguous) {
    statusLine = 'Multiple patients match &ldquo;' + esc(mentionedName) + '&rdquo; &mdash; please open to pick the right one.';
  } else {
    statusLine = 'No patient named &ldquo;' + esc(mentionedName) + '&rdquo; found in the database.';
  }

  return '' +
    '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:14px 0;background:#fafafa;">' +
      '<div style="font-size:14px;margin-bottom:4px;"><span style="color:#6b7280;">' + directionLabel + ':</span> <strong>' + esc(mentionedName) + '</strong>' + (relType ? ' <span style="color:#6b7280;">(' + esc(relType) + ')</span>' : '') + '</div>' +
      '<div style="font-size:13px;color:#4b5563;margin-bottom:12px;">' + statusLine + '</div>' +
      btnYes + btnClarify +
    '</div>';
}

// ===================== Adapters (replace the recorder's library-based versions) =====================

// Same output as the recorder's getTreatmentConfigs(), using Firestore REST (cached 10 min)
function getTreatmentConfigs() {
  try {
    const cache = CacheService.getScriptCache();
    const hit = cache.get('treatment_configs_v1');
    if (hit) return { status: 'success', data: JSON.parse(hit) };

    const docs = fsListAll_(getConfig_(), 'TREATMENT-CONFIGURATIONS');
    const configs = [];

    docs.forEach(function (d) {
      const f = fromFields_(d.fields || {});
      const keys = Object.keys(f);
      const getField = function (wanted) {
        for (let i = 0; i < wanted.length; i++) {
          const k = keys.find(function (key) { return key.trim().toLowerCase() === wanted[i].toLowerCase(); });
          if (k) return String(f[k] == null ? '' : f[k]).trim();
        }
        return '';
      };

      const name = getField(['Treatment Name', 'name', 'treatment']);
      if (!name) return;
      const link = getField(['Link', 'URL', 'Hyperlink']);
      const configString = getField(['Configuration Setting', 'config', 'configuration']);

      let configData = { areas: [] };
      try { if (configString) configData = JSON.parse(configString); } catch (e) { }

      configs.push({ name: name, link: link, areas: configData.areas || [] });
    });

    configs.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    try { cache.put('treatment_configs_v1', JSON.stringify(configs), 600); } catch (e) { }
    return { status: 'success', data: configs };
  } catch (e) {
    console.error('getTreatmentConfigs failed: ' + e);
    return { status: 'error', message: e.message };
  }
}

// Same output as the recorder's findPatientMatchesByName_(), using Firestore REST (names + IDs only)
function findPatientMatchesByName_(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return [];
  const docs = fsListAll_(getConfig_(), 'patient_list', ['Patient Name', 'PttID']);
  const exact = [], partial = [];
  docs.forEach(function (d) {
    const f = fromFields_(d.fields || {});
    const pName = String(f['Patient Name'] || '').trim();
    const pId = String(f['PttID'] || '').trim();
    if (!pName || !pId) return;
    const low = pName.toLowerCase();
    if (low === target) exact.push({ id: pId, name: pName });
    else if (low.indexOf(target) !== -1) partial.push({ id: pId, name: pName });
  });
  return exact.length ? exact : partial;
}

// The recorder's transcript corrections, unchanged
function applyTranscriptCorrections_(text) {
  if (!text) return "";
  const rules = [
    { pattern: /\bmiddle line(s)?\b/gi, replace: "marionette line$1" },
    { pattern: /\bfomenclanto\b/gi, replace: "Firm & Contour" },
    { pattern: /\bfemm and contour\b/gi, replace: "Firm & Contour" },
    { pattern: /\bfirm and contour\b/gi, replace: "Firm & Contour Treatment" },
    { pattern: /\badd[- ]?on firm and contour\b/gi, replace: "Add-on Firm & Contour Treatment" },
    { pattern: /\bfirm and fresh\b/gi, replace: "Firm & Fresh Treatment" },
    { pattern: /\badd[- ]?on firm and fresh\b/gi, replace: "Add-on Firm & Fresh Treatment" },
    { pattern: /\bfirm and hydrate\b/gi, replace: "Firm & Hydrate Treatment" },
    { pattern: /\badd[- ]?on firm and hydrate\b/gi, replace: "Add-on Firm & Hydrate Treatment" },
    { pattern: /\bexilis\b/gi, replace: "eSkin Tight" },
    { pattern: /\be[- ]?skin tight(ening)?\b/gi, replace: "eSkin Tight" },
    { pattern: /\bhydro repair\b/gi, replace: "HydraRepair" },
    { pattern: /\bclear complexion light laser\b/gi, replace: "Clear complexion Lite Laser" },
    { pattern: /\bbotox\b/gi, replace: "Wrinkle Relaxer" },
    { pattern: /\bmasseter muscle hypertrophy\b/gi, replace: "Wrinkle Relaxer for Jaw Muscle" },
    { pattern: /\bhigh[- ]?intensity ultrasound\b/gi, replace: "Skin Lifting" },
    { pattern: /\bhifu\b/gi, replace: "Skin Lifting" },
    { pattern: /\bstimulating peel and led\b/gi, replace: "Stimulating Peel + LED" }
  ];
  let cleaned = text;
  rules.forEach(function (r) { cleaned = cleaned.replace(r.pattern, r.replace); });
  return cleaned;
}