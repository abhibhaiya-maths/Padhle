// ABHI BHAIYA AI COGNITIVE CORE v6.10 (image/vision input support)
//
// CHANGES FROM v6.9 — WHY:
//
// v6.10 adds OPTIONAL IMAGE INPUT support on top of the existing text
// pipeline. Nothing about the text-only flow changes: if the frontend does
// not send an `image` field, behaviour is byte-for-byte identical to v6.9
// (same model, same params, same math-repair passes, same Telegram routing).
//
// What's new:
//   1. The request body may now include an `image` field: a base64 data URL
//      string (e.g. "data:image/png;base64,....") produced client-side via
//      FileReader — the same free, no-cost pattern already used for text.
//   2. When `image` is present and passes a light validity check, the
//      Worker switches the Groq model for THAT turn from the text model
//      (openai/gpt-oss-120b) to Groq's free vision-capable model
//      (meta-llama/llama-4-scout-17b-16e-instruct) and reshapes the user's
//      turn into Groq's multimodal content format:
//        content: [
//          { type: "text", text: <message> },
//          { type: "image_url", image_url: { url: <image data URL> } }
//        ]
//   3. The two GPT-OSS-specific reasoning controls (reasoning_effort,
//      include_reasoning) are OMITTED for the vision model — they are a
//      GPT-OSS-only feature and are not meaningful for the Llama vision
//      model, so sending them would just be dead weight.
//   4. A malformed/oversized `image` value is silently dropped (treated as
//      "no image" and the normal text flow proceeds) rather than crashing
//      the whole request — a bad photo should never break the chat.
//
// COST NOTE: meta-llama/llama-4-scout-17b-16e-instruct is on the SAME free,
// no-credit-card Groq tier as the text model — only the per-minute/per-day
// rate limits apply, there is no separate charge for using it.
//
// Everything below this notice that isn't explicitly about image handling —
// identity, student profile, prompt rules, language-mode detection,
// sanitizeMathFormatting, validateChartUrls, the math-repair helpers, retry
// logic, and the Telegram webhook block — is unchanged from v6.9.

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------
const TEXT_MODEL = "openai/gpt-oss-120b";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// A request body containing an image larger than this (as a base64 string,
// which runs ~33% larger than the raw binary) is rejected client-side too,
// but this is the server-side backstop. Groq's own hard cap is 20MB binary;
// ~27MB of base64 text comfortably corresponds to that.
const MAX_IMAGE_DATA_URL_LENGTH = 27 * 1024 * 1024;

// Accepts only a well-formed "data:image/<type>;base64,<payload>" string.
// Anything else (wrong prefix, non-base64 characters, oversized, not a
// string at all) is treated as invalid and ignored rather than trusted.
function isValidImageDataUrl(value) {
  if (typeof value !== "string") return false;
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) return false;
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(value);
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== TELEGRAM START =====
    // Telegram sends its webhook update as a POST to a DISTINCT path
    // ("/telegram/webhook"). The frontend always POSTs to the Worker root,
    // so this branch can never intercept an AI chat request — it only
    // fires for that one exact path, then returns immediately. Everything
    // below this block (the AI logic) is completely unreachable from
    // Telegram's requests.
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }
    // ===== TELEGRAM END =====

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const requestJson = await request.json();

      // ===== VOICE TRANSCRIPTION START =====
      // A separate, lightweight action: the frontend records audio with
      // MediaRecorder (works on iOS Safari too, unlike the browser's native
      // SpeechRecognition API) and posts it here as a base64 data URL. This
      // branch ONLY transcribes it via Groq's free Whisper model and
      // returns the text — it does NOT touch the chat/system-prompt
      // pipeline below at all, so it can never affect normal chat requests.
      if (requestJson.action === "transcribe") {
        return handleTranscribeRequest(requestJson, env, corsHeaders);
      }
      // ===== VOICE TRANSCRIPTION END =====

      const {
        message,
        history = [],
        student = {},
        knowledge = "",
        image = null // NEW in v6.10: optional base64 data URL of a photo
      } = requestJson;

      if (!message || typeof message !== "string" || !message.trim()) {
        return new Response(
          JSON.stringify({ reply: "Kuch likho toh bata sakun, Warrior! ??" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Validate the image (if any) up front. An invalid/oversized image is
      // silently dropped — the request still proceeds as a normal text turn
      // instead of failing outright.
      const hasValidImage = image !== null && isValidImageDataUrl(image);

      // Extract personalized student details & memory fields
      const studentName = student?.name || "Warrior";
      const studentClass = student?.class || "Class 10";
      const board = student?.board || "CBSE";
      const studentTarget = student?.target || "Board Exams ??";

      const languagePreference = student?.languagePreference || "Auto";
      const detectedLanguage = student?.detectedLanguage || "Hinglish";
      const detectedScript = student?.detectedScript || "Latin";
      const conversationLanguage = student?.conversationLanguage || "Hinglish";

      const confidenceLevel = student?.confidenceLevel || "Medium";
      const learningStyle = student?.learningStyle || "Visual";
      const speed = student?.speed || "Medium";

      const lastScore = student?.lastScore || null;
      const favouriteSubject = student?.favouriteSubject || "Math";
      const dislikes = student?.dislikes || [];
      const strengths = student?.strengths || [];
      const recentMistakes = student?.recentMistakes || [];
      const weakTopics = student?.weakTopics || [];

      const sessionNumber = student?.sessionNumber || 1;
      const previousTopic = student?.previousTopic || "";

      // Server-side language-mode detection (v6.5). Classifies the CURRENT
      // user message into "english" | "hinglish-latin" | "hindi-devanagari-mix"
      // so the model has an unambiguous, authoritative signal that overrides
      // any stale or default-y client-provided detectedLanguage.
      const languageMode = detectLanguageMode(message);

      // Dynamic Modular Prompt Builder (Only non-empty variables injected)
      let systemPrompt = "";

      if (knowledge && knowledge.trim() !== "") {
        systemPrompt += `# REFERENCE KNOWLEDGE\n(Strictly prioritize this information over general knowledge. Never contradict this.)\n${knowledge}\n\n`;
      }

      systemPrompt += `# IDENTITY\nYou are ABHI Bhaiya (Abhinay Rai), founder of Padhle India and a passionate student-first mentor. You are teaching live in a classroom. Speak naturally, warmly, and motivate like an elder brother sitting beside them.\n- Background: GATE Qualified (IIT Bombay Zone), B.Tech Mechanical. Taught 38L+ students across PW, Unacademy, BYJU'S, and Toppr.\n- Brand Context: Student community are called "Warriors". We believe in concept clarity over rote learning.\n`;

      systemPrompt += `\n# STUDENT PROFILE\n- Name: ${studentName}\n- Class/Grade: ${studentClass} (${board} Board)\n- Goal: ${studentTarget}\n`;
      if (languagePreference) systemPrompt += `- Language Preference Selection: ${languagePreference}\n`;
      if (detectedLanguage) systemPrompt += `- Client Detected Language: ${detectedLanguage}\n`;
      if (detectedScript) systemPrompt += `- Client Detected Script: ${detectedScript}\n`;
      if (conversationLanguage) systemPrompt += `- Conversation History Language: ${conversationLanguage}\n`;
      if (learningStyle) systemPrompt += `- Learning Style Preference: ${learningStyle}\n`;
      if (confidenceLevel) systemPrompt += `- Current Confidence: ${confidenceLevel}\n`;
      if (speed) systemPrompt += `- Learning Pace: ${speed}\n`;
      if (lastScore) systemPrompt += `- Last Score: ${lastScore}%\n`;
      if (favouriteSubject) systemPrompt += `- Favourite Subject: ${favouriteSubject}\n`;

      if (strengths && strengths.length > 0) systemPrompt += `- Strengths: ${strengths.join(", ")}\n`;
      if (weakTopics && weakTopics.length > 0) systemPrompt += `- Weak Topics: ${weakTopics.join(", ")}\n`;
      if (recentMistakes && recentMistakes.length > 0) systemPrompt += `- Recent Mistakes: ${recentMistakes.join(", ")}\n`;
      if (dislikes && dislikes.length > 0) systemPrompt += `- Dislikes: ${dislikes.join(", ")}\n`;
      if (sessionNumber) systemPrompt += `- Session Number: ${sessionNumber}\n`;
      if (previousTopic) systemPrompt += `- Previous Topic: ${previousTopic}\n`;

      // NEW in v6.10: when a photo is attached, tell the model explicitly so
      // it treats the image as the primary source (e.g. a textbook question,
      // handwritten working, a diagram) rather than guessing from text alone.
      if (hasValidImage) {
        systemPrompt += `\n# IMAGE INPUT\nThe student has attached a photo along with their message (e.g. a textbook question, handwritten work, or a diagram). Read the image carefully first, then answer using it as the primary source of truth. If the image is blurry or a key part is unreadable, say so briefly and ask them to retake/re-upload it instead of guessing.\n`;
      }

      systemPrompt += `
# BEHAVIOR RULES

- **LANGUAGE & SCRIPT MODE (CRITICAL — SERVER-DECIDED, NON-NEGOTIABLE):**
  The current user message has been classified server-side into mode: **${languageMode}**. You MUST respond in this mode. Do NOT re-decide the language yourself — this decision is final and already accounts for explicit user commands, script, and vocabulary in the CURRENT message.

  Mode-specific instructions:
  * **"english"** -> respond ENTIRELY in English. Use simple, friendly Indian classroom English (avoid unnecessarily advanced academic vocabulary). Do NOT insert Hindi words like "kya", "batao", "samjho", "yaar", "bacha". Do NOT use a single Devanagari character. All prose, headers, examples, and analogies are in English. Mathematical terms stay in English as usual (HCF, LCM, Derivative, etc.).
  * **"hinglish-latin"** -> respond in Hinglish using ONLY the Latin alphabet. Freely mix everyday Hindi words written in Latin (kya, hai, samjho, batao, maan lo, sabse bada factor, chalo) with English math terms (HCF, LCM, Multiple, Derivative). ABSOLUTELY NO Devanagari characters may appear — not one word, not one ligature. Headers, prose, analogies, and challenge questions are all Hinglish-in-Latin.
  * **"hindi-devanagari-mix"** -> respond in Hindi using Devanagari for regular prose (????, ??, ????, ????, ????, ????) while keeping ALL mathematical terms, formulas, variables, and technical vocabulary in English/Latin (Derivative, HCF, Integration, Product Rule, x, y, u(x), \\frac{}, etc.). This is the natural CBSE Hindi-medium classroom style — Hindi prose with English math. Do NOT translate math terminology into Hindi (write "Derivative" not "?????", write "Product Rule" not "???? ????").

  *STRICT CONSISTENCY:*
  - Maintain the chosen mode for the ENTIRE response. Do not switch scripts within a single paragraph.
  - The Direct Answer, all section headers (Asli Concept / Step-by-Step Solution / etc.), and the Challenge Question must all be in the SAME mode.
  - If the mode is "english", even the section header "Asli Concept (Makkhan Tarika)" must be rendered as an English equivalent like "Core Concept (Simple Analogy)" or "The Real Idea".
  - If the mode is "hindi-devanagari-mix", the same headers can stay in Devanagari-friendly Hinglish (they're brand phrases and read naturally alongside Devanagari prose).

  *Background context only (do NOT let this override the mode above):*
  - Client-detected language hint: ${detectedLanguage}
  - Client-detected script hint: ${detectedScript}
  - Student's saved preference: ${languagePreference}
  These are stale hints from before the current message. The server-decided mode above is always the source of truth.

- **Smart Personalization:** Personalization should feel natural. Do not repeatedly mention the student's profile, name, or past mistakes. Only use them when they genuinely improve learning.
- **Dynamic On-Topic Teaching:** Do not force teaching. Respond naturally. If the student says casual things like "Hi" or "Thank you", chat casually as a big brother. Teach only when the user's intent is educational.
- **Intent Hierarchy:** Prioritize intent in this strict order: Safety -> Math Accuracy -> Student Goal -> Conversation Context -> Teaching Style -> Engagement. If multiple rules conflict, follow this hierarchy strictly.
- **First Principles Philosophy:** Prefer teaching from first principles (intuitive basics) before introducing formulas, unless the student explicitly asks for a shortcut.
- **Anti-Hallucination & Math Verification:** Never invent NCERT content or formulas. If uncertain, state so briefly. Ask one clarifying question if needed, instead of making things up. Double check every numeric calculation step before writing it down; a wrong number in a worked example is worse than a shorter answer.

- **Dynamic Response & Structure Routing (THE CLASSROOM LAYOUT):**
  Structure your responses using these natural, highly engaging bold Hinglish headers on their own standalone lines (Do NOT put bullet points '*' or lists before these headers; write them as clean, standalone markdown headings):
  
  **Direct Answer:** (Give the final answer/statement clearly in bold right away on its own line)
  
  ### Asli Concept (Makkhan Tarika) ??
  (Explain the concept using a relatable analogy)
  
  ### Step-by-Step Solution ??
  (Break down calculations into clear, numbered steps)
  
  ### Examiner's Trap ??
  (Highlight where students usually make silly mistakes)
  
  ### Board Exam Tip ?? / Olympiad Insight ??
  (Share a high-yield writing tip or trick)
  
  ### Challenge Question ??
  (Ask ONE tiny, interactive question to test their understanding)

  For simple non-teaching exchanges (greetings, thanks, small talk), skip this structure entirely — reply in plain conversational text. Always make sure the Challenge Question section is actually included for teaching responses; if you are running low on room, shorten the earlier sections rather than dropping it.

- **Dynamic Greetings & Endings:** Never repeat the same greeting or ending. Rotate naturally (e.g., "Hey ${studentName} Warrior! ??", "Kaise ho, Warrior?", "Welcome back!"). Skip greetings when continuing an ongoing explanation. Do not force motivational endings on every response.
- **Response Length Controller:** Adjust response length automatically. One-line questions get short replies. Complex concepts (like Probability or Trigonometry) naturally receive more depth than simple ones.
- **History & Session Memory:** Use recent conversation history when it helps the student. Do not force references to previous lessons. If the student has already asked the same question, explain it using a completely different method/analogy — vary your wording and structure noticeably from your previous answer, not just the surface phrasing. Connect the current concept to previousTopic whenever meaningful.
- **Learning Style & Pace Adaptation:**
  * If the profile indicates a visual preference, describe diagrams, number lines, and clear mental shapes.
  * If the profile indicates an analytical preference, focus on logic, structural proofs, and deep connections.
  * If the profile indicates a practical preference, use real-life examples (cricket, money, school life, daily objects).
  * If confidence is Low, encourage frequently, slow down, and celebrate small progress. If High, challenge them with deep concepts.
- **Weak Topic Reinforcement:** If the current question is closely related to any weak topic or recent mistake, explain slower and use extra analogies. Mention previous mistakes only if it genuinely helps learning (e.g., "HCF me pichli baar bhi..."), but avoid making the student feel repeatedly reminded of weaknesses.
- **Class-Wise expectations:** If CBSE 9/10, teach strictly according to NCERT and CBSE board expectations. If Olympiad/JEE, provide advanced logic and proofs, but keep it highly intuitive.

- **Math LaTeX & Markdown Formatting (THE SCANNABLE LAYOUT):**
  * ABSOLUTE MATH BOUNDARY RULE (CRITICAL): You MUST wrap every single mathematical variable (e.g. $a$, $b$, $x$, $y$), coefficient, number, math symbol (e.g. $\\neq$, $\\theta$, $\\pi$, $\\Delta$), formula, or equation in standard LaTeX delimiters. Never output a raw mathematical letter or LaTeX command like \\neq, \\theta, or \\pi without wrapping it in single dollar signs $...$ or double dollar signs $$. Even simple expressions like $a \\neq 0$ or $(a, b, c)$ must be strictly wrapped in single dollar signs $...$.
  * WHOLE-EXPRESSION WRAPPING (CRITICAL): When a single mathematical expression contains multiple LaTeX commands (e.g. a fraction with a square root inside it, like the quadratic formula), wrap the ENTIRE expression in ONE pair of $...$ delimiters. NEVER split one expression into multiple separate $...$ pairs command-by-command. For example, write the quadratic formula as exactly one block: $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$ — NOT as $\\frac$, $\\pm$, $\\sqrt$ wrapped separately. This applies just as strictly to longer multi-piece formulas — summation notation ($\\sum_{k=0}^{n}$), bracket groupings ($\\bigl[...\\bigr]$), binomial coefficients ($\\binom{n}{k}$), and spacing commands ($\\,$ $\\;$) are all part of the SAME expression and must sit inside the SAME single $...$ pair as everything else in that formula — never let a bracket, a spacing command, a \\Bigl/\\Bigr/\\left/\\right size modifier, a subscript/superscript, or a variable on either side of an equals sign fall outside the delimiters. Concretely, NEVER write things like "y^{(n-1)} = $\\sum_{...}\\binom{...}{...}\\,u^{(k)}\\,$v^{(n-1-k)}" or "$\\sum ... \\Bigl$[...]$\\Bigr$]" — those place $ delimiters INSIDE the formula and split one expression into invalid pieces. Instead, write the whole formula as ONE block: "$y^{(n-1)} = \\sum_{k=0}^{n-1}\\binom{n-1}{k}\\,u^{(k)}\\,v^{(n-1-k)}$" and "$\\sum_{k=0}^{n-1}\\binom{n-1}{k}\\Bigl[u^{(k+1)}v^{(n-1-k)} + u^{(k)}v^{(n-k)}\\Bigr]$". If you are unsure whether something is "one expression," prefer wrapping more together in a single $...$ rather than splitting it.
  * VECTOR NOTATION (CRITICAL): Represent EVERY vector quantity with an arrow above the letter using \\vec{} — for example $\\vec{F}$, $\\vec{B}$, $\\vec{E}$, $\\vec{v}$, $\\vec{r}$, $\\vec{p}$, $d\\vec{l}$, and $I\\,d\\vec{l}$. Reserve \\hat{} STRICTLY for unit vectors (e.g. $\\hat{r}$, $\\hat{n}$, $\\hat{i}$, $\\hat{j}$, $\\hat{k}$). Do NOT use bold (\\mathbf or \\boldsymbol) as the vector indicator — an actual arrow must sit above the letter so it matches the NCERT classroom convention. Example (Biot–Savart): $d\\vec{B} = \\dfrac{\\mu_0}{4\\pi}\\dfrac{I\\,d\\vec{l} \\times \\hat{r}}{r^2}$. Example (Lorentz force): $\\vec{F} = q(\\vec{E} + \\vec{v} \\times \\vec{B})$.
  * UNITS — KaTeX-SAFE (CRITICAL): NEVER glue a LaTeX operator command directly onto a following letter (writing "\\cdotpm/A" or "\\cdotm/A" produces a red KaTeX error). Always leave a space after \\cdot, \\cdotp, \\times and \\pm. Preferred way to write a physical unit: use a literal middle dot "·" inside \\text and keep the whole quantity in ONE math block, e.g. $\\mu_0 = 4\\pi \\times 10^{-7}\\,\\text{T·m/A}$, or $g = 9.8\\,\\text{m/s}^2$. Do not place a bare \\cdot between unit letters in plain prose.
  * STRICT CODE BLOCK BAN: Never, under any circumstances, use markdown code blocks (such as those using triple backticks, indentations, or preformatted blocks) to write math formulas, equations, or templates (like $T_n = a * r^{n-1}$). All templates, math formulas, and expressions must strictly be written in standard, beautiful LaTeX.
  * **DYNAMIC GRAPH GENERATION ENGINE (CRITICAL - NO ASCII ART & MATHS ONLY):**
    Whenever the student asks to visualize, plot, draw, or explain a mathematical function (such as $y = x^2$, parabolas, quadratic curves, linear equations, trigonometric curves like $\\sin(x)$, statistics, or datasets), you MUST dynamically generate a clean visual graph using the free Image-Charts API. NEVER use plain text ASCII art (using asterisks, hyphens, or slashes) to draw graphs or curves. You must output the graph strictly as a standard markdown image on its own line using this exact, clean, flat URL structure (which contains ZERO nested parentheses or quotes, preventing markdown parser crashes):
    ![Graph Name](https://image-charts.com/chart?cht=lc&chd=a:DATA_POINTS&chs=500x300&chf=bg,s,070b19&chco=3b82f6&chg=20,20&chtt=GRAPH_TITLE)
    (Where DATA_POINTS are comma-separated y-values between 0 and 100 only — Image-Charts' simple-encoding "a:" format requires values in that range, so rescale your actual y-values proportionally into 0-100 before writing them. GRAPH_TITLE is the URL-encoded name of the function, e.g. y%20%3D%20x%5E2. Use 8 to 15 data points — fewer looks jagged, more is unnecessary. Ensure there are NO parentheses used inside the URL parameters, like rgba(), to prevent markdown parsing issues.)
    * **STRICT EXCLUSION:** NEVER attempt to use the Image-Charts API to draw Physics ray diagrams, Chemical setups, or Biology diagrams. For Science diagrams, explain them beautifully and clearly using structured, step-by-step text descriptions. If a valid, pre-hosted high-quality static image URL is provided in the '# REFERENCE KNOWLEDGE' context, you may render that static image using standard markdown: ![Description](image_url). Otherwise, rely purely on clear, textbook-quality textual explanations.
  * Use **rich markdown formatting** to make responses visually appealing. Always use bold bullet points, numbered steps, and comparison tables. Raw unstructured walls of text are strictly forbidden. Students love scanning formatted structures on mobile screens!
  * Prefer natural conversation flow over rigid templates, adjusting formatting naturally to match the topic.

# RESPONSE SELF-CHECK (INTERNAL QUALITY GATE)
Before sending the answer, silently verify:
- Is the answer mathematically correct?
- Is it appropriate for the student's class?
- Is it portfolio-friendly and free of unnecessary repetition?
- Is every math symbol and variable wrapped in $ delimiters, with each full expression — including \\bigl/\\bigr brackets, \\sum/\\binom subscripts, \\, \\; spacing, and the variables on either side of "=" — wrapped as ONE block, with no $ ever placed INSIDE a formula (which would split it into invalid pieces)?
- Is every vector written with \\vec{} (arrow), unit vectors with \\hat{}, and no vector left as bold-only?
- Are all units KaTeX-safe (a space after \\cdot/\\times/\\pm, no operator command glued onto a letter)?
- If any answer is "No", revise the response internally before displaying it.
`;

      // Safe History Mapper (Alternating assistant/user format)
      const formattedHistory = (history || []).map(item => ({
        role: item.role === "model" ? "assistant" : (item.role || "user"),
        content: item.parts && item.parts[0] ? item.parts[0].text : (item.content || "")
      }));

      // ADAPTIVE HISTORY SLICING: Long query = less history; Short query = more history
      const MAX_HISTORY = message.length > 500 ? 8 : 14;
      const recentHistory = formattedHistory.slice(-MAX_HISTORY);

      // NEW in v6.10: build the CURRENT turn's content. Plain string for a
      // normal text-only message (unchanged from v6.9); Groq's multimodal
      // content array — text block + image_url block — when a valid photo
      // is attached.
      const currentUserContent = hasValidImage
        ? [
            { type: "text", text: message },
            { type: "image_url", image_url: { url: image } }
          ]
        : message;

      const messages = [
        { role: "system", content: systemPrompt },
        ...recentHistory,
        { role: "user", content: currentUserContent }
      ];

      const rawKey = env.GROQ_API_KEY || env.GR0Q_API_KEY;
      const apiKey = rawKey ? rawKey.trim() : "";
      const url = "https://api.groq.com/openai/v1/chat/completions";

      if (!apiKey) {
        console.error("Groq API key missing from environment bindings.");
        return new Response(
          JSON.stringify({ reply: "Hey Warrior! ?? Setup issue hai bacha, thodi der baad try karo." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // NEW in v6.10: pick the model per-turn. Vision turns use Groq's free
      // multimodal model; everything else stays on the existing text model.
      const selectedModel = hasValidImage ? VISION_MODEL : TEXT_MODEL;

      const groqPayload = {
        model: selectedModel,
        messages: messages,
        temperature: 0.5,
        top_p: 0.95,
        frequency_penalty: 0.1,
        presence_penalty: 0.0,
        max_tokens: 1400
      };

      // GPT-OSS-specific reasoning controls (see header notes above):
      // low effort + reasoning excluded from the response entirely, so
      // `content` always contains only the clean final answer. These two
      // fields are specific to the GPT-OSS text model — they are omitted
      // entirely for the vision model turn.
      if (!hasValidImage) {
        groqPayload.reasoning_effort = "low";
        groqPayload.include_reasoning = false;
      }

      const requestBody = JSON.stringify(groqPayload);

      // RETRY ONCE on transient failures (network blip or Groq 5xx) before
      // giving up — a single retry covers most transient incidents without
      // making a genuinely broken request hang for too long.
      let apiResponse;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          apiResponse = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            body: requestBody,
          });
          if (apiResponse.ok) break;
          if (apiResponse.status < 500) break; // don't retry 4xx (bad request/auth) — retrying won't help
          lastError = `status ${apiResponse.status}`;
        } catch (networkErr) {
          lastError = networkErr.message;
        }
        if (attempt === 0) await new Promise(r => setTimeout(r, 400));
      }

      if (!apiResponse || !apiResponse.ok) {
        const errorText = apiResponse ? await apiResponse.text() : (lastError || "no response");
        console.error("Groq Error:", errorText);
        // If the vision call itself failed (e.g. bad image, model hiccup),
        // fall back to a plain text explanation rather than a dead end —
        // the student at least gets a reply instead of silence.
        const fallbackReply = hasValidImage
          ? "Hey Warrior! ?? Ye photo abhi process nahi ho payi. Ek clear, achhi roshni wali photo dobara try karo, ya sawaal type karke bhi pooch sakte ho!"
          : "Hey Warrior! ?? AI server thoda busy hai abhi, ek baar phir try karo.";
        return new Response(
          JSON.stringify({ reply: fallbackReply }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await apiResponse.json();
      if (data.error) {
        console.error("Groq API Error payload:", data.error);
        return new Response(
          JSON.stringify({ reply: "Hey Warrior! ?? AI server thoda busy hai abhi, ek baar phir try karo." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let botReply = data?.choices?.[0]?.message?.content?.trim();

      // Defensive fallback: if `content` is unexpectedly empty but the model
      // put something in `reasoning` anyway (the community-reported edge
      // case for gpt-oss), surface that rather than show nothing — it is
      // better than a dead response, even though it shouldn't normally
      // happen with include_reasoning:false.
      if (!botReply) {
        botReply = data?.choices?.[0]?.message?.reasoning?.trim();
      }
      if (!botReply) {
        botReply = "Hey Warrior! ?? Response generate nahi ho pa raha hai bacha, dobara try karo.";
      }

      // ORDER MATTERS:
      //  0. unwrapAccidentalProseMath — FIRST, so a whole sentence the model
      //     mistakenly wrapped in $...$ (e.g. "$- **Forgetting the division
      //     by r!** when converting a permutation count to a
      //     combination.$") gets un-wrapped back to plain prose BEFORE any
      //     other pass sees it and treats it as legitimate (if oddly
      //     shaped) math to preserve/repair.
      //  1. repairMisplacedMathDelimiters — so lines with misplaced $ inside
      //     a formula are reassembled BEFORE the other passes see them
      //     (otherwise those passes treat the broken $...$ as valid math
      //     and skip repairing).
      //  2. normalizeGluedMathOperators — then de-glue unit operators so
      //     the sanitizer's greedy command matcher sees correct boundaries.
      //  3. sanitizeMathFormatting — then wrap any still-bare LaTeX runs.
      //  4. validateChartUrls — finally, guard against malformed chart URLs.
      botReply = unwrapAccidentalProseMath(botReply);
      botReply = repairMisplacedMathDelimiters(botReply);
      botReply = normalizeGluedMathOperators(botReply);
      botReply = sanitizeMathFormatting(botReply);
      botReply = validateChartUrls(botReply);

      return new Response(
        JSON.stringify({ reply: botReply }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } catch (error) {
      console.error("Worker Internal Exception:", error.message);
      return new Response(JSON.stringify({
        reply: "Hey Warrior! ?? Technical issue aa gaya bacha. Thodi der baad try karo."
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
};

// ---------------------------------------------------------------------------
// unwrapAccidentalProseMath(text)   [NEW]
//
// Fixes a distinct class of bug from repairMisplacedMathDelimiters: instead
// of a formula being SPLIT across misplaced $ signs, here the model wraps an
// entire PLAIN-ENGLISH SENTENCE in one (technically well-formed) $...$ pair,
// e.g.:
//   $- **Forgetting the division by r!** when converting a permutation
//   count to a combination.$
// KaTeX renders this "successfully" as one continuous math expression —
// which means every space between words collapses (math mode doesn't
// preserve inter-symbol whitespace the way prose does), producing exactly
// the glued-together, no-spaces italic text seen in production
// ("Forgettingthedivisionbyr!...whenconvertingapermutationcounttoacombination").
// Because the fragment LOOKS structurally valid (balanced braces, no
// dangling operators), repairMisplacedMathDelimiters correctly leaves it
// alone — this needs a different signal entirely: does the fragment's
// CONTENT read like an English sentence rather than a mathematical
// expression? A handful of common English stopwords appearing together
// inside a $...$ fragment is a strong, low-false-positive indicator of
// this — genuine math expressions essentially never contain words like
// "when", "the", "converting", "without" etc. This runs FIRST in the
// pipeline, unwrapping the sentence back to plain prose before any other
// pass gets a chance to treat it as legitimate math.
// ---------------------------------------------------------------------------
function unwrapAccidentalProseMath(text) {
  if (!text) return text;
  const STOPWORDS = /\b(the|a|an|is|are|was|were|when|to|of|in|on|for|and|or|but|that|this|from|by|with|without|you|your|write|writes|writing|forget|forgetting|remember|must|should|number|smaller|larger|always|never|will|would|can|could|not|convert|converting|count|counts|counting|means|mean|meaning|because|since|while|before|after|between|each|every|more|than|once|order|matters|choose|chosen|form|group)\b/gi;

  return text.replace(/\$([^\$\n]*)\$/g, (match, inner) => {
    const trimmed = inner.trim();
    const words = trimmed.split(/\s+/);
    // Very short fragments are essentially never accidentally-wrapped
    // prose — leave them alone to avoid any risk of false positives.
    if (words.length < 5) return match;

    const stopwordHits = (trimmed.match(STOPWORDS) || []).length;
    if (stopwordHits >= 3) {
      return trimmed; // this is a sentence, not math — unwrap it
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// handleTranscribeRequest(requestJson, env, corsHeaders)   [NEW]
//
// Handles the lightweight "action: transcribe" path used by the mic button.
// The frontend records a voice note client-side (MediaRecorder — works on
// iOS Safari, Android, and desktop alike) and posts it here as a base64
// data URL (e.g. "data:audio/webm;base64,...."). This function:
//   1. Validates the payload (well-formed audio data URL, sane size cap).
//   2. Decodes the base64 audio into raw bytes.
//   3. Sends it to Groq's free Whisper transcription endpoint as a
//      multipart/form-data upload (the format Groq's audio API expects —
//      same shape as OpenAI's Whisper endpoint).
//   4. Returns { transcript: "..." } so the frontend can drop the text into
//      the input box for the student to review before sending — exactly
//      like the old (unreliable-on-iOS) SpeechRecognition flow did.
//
// This is entirely separate from the main chat pipeline above: it never
// touches the system prompt, history, or the text/vision chat models.
// ---------------------------------------------------------------------------
const WHISPER_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_DATA_URL_LENGTH = 34 * 1024 * 1024; // ~25MB binary cap, base64-inflated

function parseAudioDataUrl(value) {
  if (typeof value !== "string") return null;
  if (value.length > MAX_AUDIO_DATA_URL_LENGTH) return null;
  const match = value.match(/^data:audio\/([a-zA-Z0-9.+-]+)(?:;codecs=[^;]+)?;base64,([A-Za-z0-9+/]+=*)$/);
  if (!match) return null;
  return { subtype: match[1].toLowerCase(), base64: match[2] };
}

// Maps a MIME subtype to a filename extension Groq's Whisper endpoint will
// recognize. Falls back to .webm (the most common MediaRecorder output).
function extensionForSubtype(subtype) {
  const map = { webm: "webm", mp4: "mp4", "mp4a-latm": "mp4", aac: "aac", ogg: "ogg", wav: "wav", mpeg: "mp3" };
  return map[subtype] || "webm";
}

async function handleTranscribeRequest(requestJson, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const parsed = parseAudioDataUrl(requestJson.audio);
  if (!parsed) {
    return new Response(
      JSON.stringify({ transcript: "", error: "Invalid or oversized audio." }),
      { headers: jsonHeaders }
    );
  }

  const rawKey = env.GROQ_API_KEY || env.GR0Q_API_KEY;
  const apiKey = rawKey ? rawKey.trim() : "";
  if (!apiKey) {
    console.error("Groq API key missing from environment bindings (transcribe path).");
    return new Response(
      JSON.stringify({ transcript: "", error: "Setup issue." }),
      { headers: jsonHeaders }
    );
  }

  try {
    // Decode base64 -> raw bytes. atob() is available in the Workers runtime.
    const binaryString = atob(parsed.base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const mimeType = `audio/${parsed.subtype}`;
    const filename = `voice-note.${extensionForSubtype(parsed.subtype)}`;
    const audioBlob = new Blob([bytes], { type: mimeType });

    const form = new FormData();
    form.append("file", audioBlob, filename);
    form.append("model", WHISPER_MODEL);
    // v6.12 FIX: forcing language="hi" was hurting accuracy on the site's
    // actual speech pattern — CODE-SWITCHED sentences that mix English and
    // Hindi in the same breath (e.g. "Hi ABHI Bhaiya, kaise ho aap"). A hard
    // language lock pushes Whisper to bend genuinely-English words into
    // Hindi-shaped phonetics, producing garbled nonsense ("kaise ho aap"
    // becoming "Kathy Ho-Hop" was observed in production). Auto-detection
    // alone previously caused a different failure (misdetecting Gujarati).
    // The fix: let Whisper auto-detect per its own judgment, but bias its
    // vocabulary/style with a `prompt` example covering exactly this site's
    // code-switched English+Hindi pattern — the standard technique for
    // steering Whisper's output without forcing a single hard language tag.
    form.append(
      "prompt",
      "Hi ABHI Bhaiya, kaise ho aap? Mujhe HCF aur LCM ka fark samjha do please, aur Pythagoras theorem bhi."
    );

    let whisperResponse;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // NOTE: do NOT set a Content-Type header manually here — fetch()
        // generates the correct multipart boundary itself from the
        // FormData body. Setting it manually breaks the upload.
        whisperResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}` },
          body: form
        });
        if (whisperResponse.ok) break;
        if (whisperResponse.status < 500) break;
        lastError = `status ${whisperResponse.status}`;
      } catch (networkErr) {
        lastError = networkErr.message;
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 400));
    }

    if (!whisperResponse || !whisperResponse.ok) {
      const errorText = whisperResponse ? await whisperResponse.text() : (lastError || "no response");
      console.error("Groq Whisper Error:", errorText);
      return new Response(
        JSON.stringify({
          transcript: "",
          error: "Transcription failed.",
          // TEMP DEBUG (v6.13): surfaces the real underlying failure so we
          // can see exactly what's going wrong instead of guessing blindly.
          // Safe to remove once the root cause is confirmed and fixed.
          debug: String(errorText).slice(0, 500)
        }),
        { headers: jsonHeaders }
      );
    }

    const whisperData = await whisperResponse.json();
    let transcript = (whisperData && whisperData.text) ? whisperData.text.trim() : "";

    if (transcript) {
      transcript = await normalizeTranscriptScript(transcript, apiKey);
    }

    return new Response(
      JSON.stringify({ transcript }),
      { headers: jsonHeaders }
    );

  } catch (error) {
    console.error("handleTranscribeRequest exception:", error.message, error.stack);
    return new Response(
      JSON.stringify({
        transcript: "",
        error: "Internal error.",
        // TEMP DEBUG (v6.13): same reasoning as above.
        debug: String(error && (error.stack || error.message) || error).slice(0, 500)
      }),
      { headers: jsonHeaders }
    );
  }
}

// ---------------------------------------------------------------------------
// normalizeTranscriptScript(text, apiKey)   [NEW]
//
// Whisper (tagged language="hi") transcribes Hindi speech in Devanagari
// script by default, but this site's whole chat convention is Hinglish
// written in the LATIN alphabet (matching detectLanguageMode's
// "hinglish-latin" mode) — Devanagari voice output would look completely
// out of place and mismatched next to typed Hinglish. Whisper has no
// built-in "romanize" option, so this does a fast, cheap follow-up pass
// through the same text chat model to transliterate Devanagari -> Hinglish
// Latin, while leaving already-English text untouched.
//
// Fails safe: on any error (bad response, network issue, no key) this
// returns the ORIGINAL Whisper transcript rather than losing the voice
// note — a slightly-wrong script beats no text at all.
// ---------------------------------------------------------------------------
async function normalizeTranscriptScript(text, apiKey) {
  if (!apiKey) return text;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          {
            role: "system",
            content: "You clean up speech-to-text output for a student chat app. Rules, in order: " +
              "(1) If the text contains any Devanagari (Hindi script) characters, transliterate the ENTIRE text into Hinglish using ONLY the Latin/English alphabet, the way Indian students type on WhatsApp (e.g. 'kya hai', 'kaise karu', 'samjhao', 'batao') — never output a single Devanagari character. " +
              "(2) Keep any English words, names, or math/technical terms exactly as English — do not translate them. " +
              "(3) If the text is already fully in the Latin alphabet (English or Hinglish), return it unchanged except for obvious transcription typos. " +
              "(4) Output ONLY the resulting text — no quotes, no explanation, no extra commentary."
          },
          { role: "user", content: text }
        ],
        temperature: 0,
        max_tokens: 400
      })
    });

    if (!response.ok) return text; // fall back to the raw transcript
    const data = await response.json();
    const cleaned = data?.choices?.[0]?.message?.content?.trim();
    return cleaned || text;
  } catch (err) {
    console.error("normalizeTranscriptScript failed, using raw transcript:", err.message);
    return text;
  }
}

// ---------------------------------------------------------------------------
// repairMisplacedMathDelimiters(text)   [v6.8]
//
// Fixes the "red KaTeX error from $ placed INSIDE a formula" class of bug,
// where the model emits lines like:
//   y^{(n-1)} = $\sum_{k=0}^{n-1}\binom{n-1}{k}\,u^{(k)}\,$v^{(n-1-k)}
//   y' = u(x)$\,\underbrace{\lim...\frac{v(x+h)-v(x)}{h}}$_{v'(x)}$...$
//   $\tau$ = (1.0$\times10^{-3})\times$ 500 = 0.5$\,\text{Pa}$.
// i.e. the $ delimiters cut mid-formula, chopping one valid expression into
// several invalid $-wrapped chunks (each an individual KaTeX error) while the
// rest of the formula prints as literal text outside the $ pair.
//
// The other cleanup passes CAN'T fix this because they explicitly skip $...$
// regions (treating them as "already valid math") — so misplaced delimiters
// slip through untouched.
//
// This pass runs first, line-by-line. A line is "broken" if ANY of these
// fire (all effectively zero false-positive on real math):
//  - DANGLING_END: a $...$ fragment ends with something that can't legally
//    terminate an expression — a size opener/closer/spacer, a bare binary
//    operator/relation, or a needs-an-argument command (\frac, \sqrt, ...).
//  - DANGLING_START: a $...$ fragment starts with a size CLOSER (\Bigr etc.).
//  - bracesUnbalanced: a $...$ fragment has unequal { } (incomplete math,
//    regardless of which command caused the split — this is the general
//    signal that catches \underbrace and any future command family).
//  - GAP_LOOKS_LIKE_MATH: the literal text BETWEEN two $ pairs on the line
//    is itself math debris (a bare _{ / ^{ stub or a \command), i.e. a piece
//    of one formula that leaked outside the delimiters.
// On a hit, ALL $ on that line are stripped and the whole line's content is
// re-wrapped in ONE $...$ pair, reassembling the formula into a single valid
// math block.
//
// Verified against real KaTeX 0.16.8: all production-screenshot failures
// repair to 0 errors; legitimate short inline math ($E = mc^2$, $(n-1)^{th}$,
// $a > 0$ and $b > 0$, $\bigl[x\bigr]$, $\left(x+y\right)$, $x \to \infty$)
// is left untouched.
// ---------------------------------------------------------------------------
function repairMisplacedMathDelimiters(text) {
  if (!text) return text;

  // Size/spacing commands that can't validly END an expression.
  const SIZE_SPACE = "\\Bigg?l|\\bigg?l|\\Bigg?r|\\bigg?r|\\left|\\right|\\,|\\;|\\:|\\!";
  // Binary operators / relations that can't validly END an expression.
  const OPS = "\\times|\\cdotp|\\cdot|\\div|\\pm|\\mp|\\ast|\\star|\\circ|\\bullet|" +
              "\\cup|\\cap|\\vee|\\wedge|\\oplus|\\otimes|\\le|\\leq|\\ge|\\geq|" +
              "\\neq|\\ne|\\approx|\\equiv|\\sim|\\propto|\\mapsto|\\implies|\\iff|" +
              "\\leftarrow|\\rightarrow|\\Rightarrow|\\Leftarrow|\\to";
  // Commands that REQUIRE a following argument, so can't be the last token.
  const NEEDS_ARG = "\\frac|\\dfrac|\\tfrac|\\binom|\\sqrt|\\overline|\\underline|" +
                    "\\vec|\\hat|\\bar|\\dot|\\widehat|\\underbrace|\\overbrace|" +
                    "\\sum|\\prod|\\int";

  const DANGLING_END = new RegExp("(" + SIZE_SPACE + "|" + OPS + "|" + NEEDS_ARG + ")\\s*$");
  const DANGLING_START = /^\s*(\\Bigg?r|\\bigg?r|\\right)/;
  const GAP_LOOKS_LIKE_MATH = /^\s*([_^]\{|\\[a-zA-Z])/;

  // A $...$ fragment with unbalanced { } is incomplete math regardless of
  // which command caused it. Escaped braces (\{ \}) are skipped.
  function bracesUnbalanced(inner) {
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\') { i++; continue; } // skip escaped char (\{ \} \\ etc.)
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth < 0) return true; }
    }
    return depth !== 0;
  }

  const lines = text.split('\n');
  const repaired = lines.map(line => {
    if (!line.includes('$')) return line;
    // Match $...$ non-greedily; the inner group is what KaTeX would receive.
    const frags = [...line.matchAll(/\$([^\$\n]*)\$/g)];
    if (!frags.length) return line;

    let triggered;
    if (frags.length === 1) {
      // A single math mention on this line: if IT looks dangling/broken,
      // the whole line really is one incompletely-delimited formula.
      const inner = frags[0][1];
      triggered = DANGLING_END.test(inner) || DANGLING_START.test(inner) || bracesUnbalanced(inner);
    } else {
      // Multiple independent $...$ mentions on one line/paragraph (common
      // in prose that references several short expressions like $r!$,
      // $(n-r)!$, $(r-n)!$). DANGLING_END/DANGLING_START are deliberately
      // NOT used here: a lone, perfectly legitimate spacer fragment like
      // "$\,$" or a fragment that happens to end in an operator for
      // unrelated reasons would otherwise nuke the ENTIRE paragraph into
      // one broken math block (this was a real production bug — glued-
      // together, space-stripped prose). Only unambiguous corruption
      // (unbalanced braces) or a gap that's clearly a leaked math stub
      // count as "broken" when there's more than one fragment on the line.
      const fragBroken = frags.some(m => bracesUnbalanced(m[1]));
      let gapBroken = false;
      for (let i = 1; i < frags.length; i++) {
        const prevEnd = frags[i - 1].index + frags[i - 1][0].length;
        const gap = line.slice(prevEnd, frags[i].index);
        if (GAP_LOOKS_LIKE_MATH.test(gap)) { gapBroken = true; break; }
      }
      triggered = fragBroken || gapBroken;
    }

    if (!triggered) return line;

    // Repair: preserve leading indent, strip ALL $ from the rest of the
    // line, trim, and re-wrap the whole line's content in ONE $...$ pair.
    const indent = (line.match(/^(\s*)/) || ['', ''])[1];
    const stripped = line.slice(indent.length).replace(/\$/g, '').trim();
    if (!stripped) return line; // safety: don't produce an empty $$
    return indent + '$' + stripped + '$';
  });

  return repaired.join('\n');
}

// ---------------------------------------------------------------------------
// normalizeGluedMathOperators(text)   [v6.8]
//
// Fixes the "red \cdotpm KaTeX error" class of bug. The model sometimes
// writes a unit dot as a LaTeX operator command glued straight onto the
// following unit letters with no separating space, e.g. "T\cdotpm/A" or
// "Pa\cdotps". Both KaTeX and sanitizeMathFormatting()'s greedy command
// matcher then read the command + the unit letters as ONE token, which is
// an undefined control sequence and renders as red error text.
//
// This inserts the missing space between a known operator command and a
// directly-following letter, so the command boundary is unambiguous.
//
// Safety (v6.8):
//  - \cdots (the ? ellipsis) is shielded so it is never split into "\cdot s".
//  - \cdotp is now shielded FULLY before \cdot is touched — otherwise, for
//    an already-correct "\cdotp s", the \cdot alternative would match the
//    "\cdot" prefix and corrupt it into "\cdot p s". After the \cdot/\times
//    pass, \cdotp is de-glued on its own, then restored.
// ---------------------------------------------------------------------------
function normalizeGluedMathOperators(text) {
  if (!text) return text;
  const CDOTS = "\uE000"; // private-use placeholder for the ellipsis command
  const CDOTP = "\uE001"; // private-use placeholder for \cdotp
  return text
    .replace(/\\cdots/g, CDOTS)                                    // protect ? first
    .replace(/\\cdotp/g, CDOTP)                                    // protect \cdotp fully
    .replace(/\\(cdot|times)(?=[a-zA-Z])/g, "\\$1 ")             // de-glue \cdot / \times
    .replace(new RegExp(CDOTP + "(?=[a-zA-Z])", "g"), "\\cdotp ") // de-glue \cdotp
    .replace(new RegExp(CDOTP, "g"), "\\cdotp")                    // restore \cdotp
    .replace(new RegExp(CDOTS, "g"), "\\cdots");                   // restore ?
}

// ---------------------------------------------------------------------------
// sanitizeMathFormatting(text)   [unchanged from v6.6]
//
// Safety net for the "ABSOLUTE MATH BOUNDARY RULE" / "WHOLE-EXPRESSION
// WRAPPING" rules in the prompt. Wraps any bare LaTeX-looking RUN of commands
// that ISN'T already inside $...$ or $$...$$ delimiters. Runs AFTER
// repairMisplacedMathDelimiters and normalizeGluedMathOperators.
// ---------------------------------------------------------------------------
function sanitizeMathFormatting(text) {
  if (!text) return text;

  // Split on existing math/code regions so we only operate on plain prose.
  const protectedPattern = /(\$\$[\s\S]*?\$\$|\$[^\$\n]*?\$|`[^`]*`|```[\s\S]*?```)/g;
  const parts = text.split(protectedPattern);

  const nestedBraces = "\\{(?:[^{}]|\\{[^{}]*\\})*\\}";
  const oneCommand = `(?:\\\\[a-zA-Z]+(?:${nestedBraces})*|\\\\[,;:!])`;

  const connector = "[ \\t]*[a-zA-Z0-9+\\-=,./^_(){}\\[\\]]*[ \\t]*";
  const runPattern = new RegExp(`${oneCommand}(?:${connector}${oneCommand})*`, "g");

  const requiresBraces = /^\\(frac|sqrt|binom|overline|underline|vec|hat|bar|dot|widehat)\b/;

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      parts[i] = parts[i].replace(runPattern, (match) => {
        const trimmed = match.trim();
        if (requiresBraces.test(trimmed) && !trimmed.includes("{")) {
          return match; // leave untouched — wrapping it would still be invalid
        }
        return `$${trimmed}$`;
      });
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// detectLanguageMode(message)   [unchanged from v6.5]
//
// Classifies the CURRENT user message into one of three response modes:
//   "english" | "hinglish-latin" | "hindi-devanagari-mix"
// ---------------------------------------------------------------------------
function detectLanguageMode(message) {
  const text = String(message || "");
  if (!text.trim()) return "hinglish-latin";

  // 1. Explicit user command overrides everything
  if (/\b(in|use|explain in|answer in|reply in|respond in|write in|say in)\s+english\b/i.test(text) ||
      /\benglish\s+(me|mein|main)\b/i.test(text)) return "english";
  if (/\b(in|use|explain in|answer in|reply in|respond in|write in|say in)\s+hindi\b/i.test(text) ||
      /\bhindi\s+(me|mein|main)\b/i.test(text)) return "hindi-devanagari-mix";
  if (/\b(in|use|explain in|answer in|reply in|respond in|write in|say in)\s+hinglish\b/i.test(text) ||
      /\bhinglish\s+(me|mein|main)\b/i.test(text)) return "hinglish-latin";

  // 2. Devanagari present -> Hindi + Latin mix
  if (/[\u0900-\u097F]/.test(text)) return "hindi-devanagari-mix";

  // 3. Hinglish markers in Latin-only text -> Hinglish-in-Latin
  const HINGLISH_MARKERS = /\b(kya|kyaa|hai|hain|kaise|kaisa|kaisi|batao|batana|samjhao|samjhana|samjha|samjho|karo|karna|karta|karti|karte|kar|ka|ki|ke|mein|nahi|nahin|haan|kyun|kyu|kyunki|iska|uska|mera|mere|meri|kaun|woh|yeh|vo|ye|bhai|yaar|bacha|bache|chahiye|hoga|hoti|hota|hote|matlab|arey|thoda|jab|tab|jaise|waise|pehle|baad|sabse|bilkul|shayad|acha|accha|theek|thik|toh|par|pe|se|ko|wala|wali|wale|dena|deta|deti|leta|leti|karke|jaana|aana|dekho|dekhna|dekhta|padhna|padhta|likhna|sunna|bolo|bola|kaha|kahaan|jahan|wahan|yahan|phir|fir|kal|aaj|abhi|humara|hamara|hamare|hamari|tumhara|tumhare|tumhari|tera|tere|teri|hum|aap|apka|apki|apke|likh|likho|padh|padho|sun|suno|dikhao|de|do|le|lo|jaldi|zyada|kam|namaste|namaskar|bhaiya|didi|ji|khud|log|logo|logon)\b/i;
  if (HINGLISH_MARKERS.test(text)) return "hinglish-latin";

  // 4. Default: pure English
  return "english";
}

// ---------------------------------------------------------------------------
// validateChartUrls(text)   [unchanged from v6.6]
//
// Guards against malformed Image-Charts markdown images (wrong host, bad data
// list, stray parentheses, out-of-range values) by replacing broken ones with
// a short plain-text note instead of a dead/broken image.
// ---------------------------------------------------------------------------
function validateChartUrls(text) {
  if (!text || !text.includes("image-charts.com")) return text;

  const imagePattern = /!\[([^\]]*)\]\((https:\/\/image-charts\.com\/chart\?[^\n]*?)\)(?=\s|$|[.,;!?])/g;

  return text.replace(imagePattern, (fullMatch, altText, chartUrl) => {
    if (chartUrl.includes("(") || chartUrl.includes(")")) {
      return `*[Graph "${altText}" could not be rendered cleanly — ask me to describe it in words if you'd like.]*`;
    }

    const dataMatch = chartUrl.match(/chd=a:([\d.,\-]+)/);
    if (!dataMatch) {
      return `*[Graph "${altText}" could not be rendered cleanly — ask me to describe it in words if you'd like.]*`;
    }

    const values = dataMatch[1].split(",").map(Number);
    const allValid = values.length >= 2 && values.every(v => Number.isFinite(v) && v >= 0 && v <= 100);

    if (!allValid) {
      return `*[Graph "${altText}" could not be rendered cleanly — ask me to describe it in words if you'd like.]*`;
    }

    return fullMatch;
  });
}

// ===== TELEGRAM START =====
// Everything below this line is unchanged from v6.9. Nothing above it
// (identity, prompt, Groq call, retry logic, math-repair helpers, image
// handling) was modified by adding this block.
//
// FLOW:
//   Telegram -> POST {WORKER_URL}/telegram/webhook -> handleTelegramWebhook()
//     -> parses the update, finds "/start <payload>"
//     -> handleStartCommand() looks up the reply text for that payload in
//        START_PAYLOADS (add new keys here for /start class9, /start class10,
//        /start olympiad, etc. — no other code needs to change)
//     -> sendTelegramMessage() calls the Telegram Bot API using the
//        TELEGRAM_BOT_TOKEN secret (never hardcoded)
//
// Every future command (/help, /resources, /quiz, ...) can be added as a
// new "else if" branch in handleTelegramWebhook() calling its own small
// handler function, following the same pattern as handleStartCommand().
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// START_PAYLOADS
//
// Lookup table for every "/start <payload>" deep-link variant. To support a
// new deep link (e.g. https://t.me/PadhleIndiaBot?start=class9), just add a
// new key here — no routing/parsing code needs to change.
// ---------------------------------------------------------------------------
const START_PAYLOADS = {
  "": {
    text: "?? Welcome Warrior!\n\nYour FREE Study Starter Kit is ready.\n\n?? Access Now\nhttps://padhleindia.com/notes\n\nHappy Learning ??\n— Team Padhle India"
  },
  "starterkit": {
    text: "?? Welcome Warrior!\n\nYour FREE Study Starter Kit is ready.\n\n?? Access Now\nhttps://padhleindia.com/notes\n\nHappy Learning ??\n— Team Padhle India"
  }
  // Future examples — just add entries, nothing else changes:
  // "class9":   { text: "?? Welcome Class 9 Warrior!\n\n..." },
  // "class10":  { text: "?? Welcome Class 10 Warrior!\n\n..." },
  // "olympiad": { text: "?? Welcome Olympiad Warrior!\n\n..." },
};

// ---------------------------------------------------------------------------
// handleStartCommand(chatId, payload, env)
//
// Resolves a "/start <payload>" command to its configured reply and sends
// it. Unknown payloads fall back to the default ("") entry rather than
// silently failing.
// ---------------------------------------------------------------------------
async function handleStartCommand(chatId, payload, env) {
  const entry = START_PAYLOADS[payload] || START_PAYLOADS[""];
  await sendTelegramMessage(chatId, entry.text, env);
}

// ---------------------------------------------------------------------------
// sendTelegramMessage(chatId, text, env)
//
// Thin wrapper around Telegram's Bot API sendMessage call. Token is read
// from the Worker Secret env.TELEGRAM_BOT_TOKEN — never hardcoded, never
// logged. Failures are caught and logged; they never throw up into the
// caller, so a bad Telegram API call can never crash the Worker or affect
// the AI route.
// ---------------------------------------------------------------------------
async function sendTelegramMessage(chatId, text, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Telegram Bot Token missing from environment bindings.");
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        disable_web_page_preview: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Telegram sendMessage failed:", errorText);
    }
  } catch (error) {
    console.error("Telegram sendMessage network error:", error.message);
  }
}

// ---------------------------------------------------------------------------
// handleTelegramWebhook(request, env, ctx)
//
// Entry point for Telegram's webhook POST (routed from fetch() above via the
// "/telegram/webhook" path check). Always resolves with a 200 response so
// Telegram never retry-storms this endpoint, even on internal failure —
// errors are logged via console.error instead of thrown.
//
// Optional hardening: if a TELEGRAM_WEBHOOK_SECRET Worker Secret is set,
// Telegram's "X-Telegram-Bot-Api-Secret-Token" header is verified against
// it (set via setWebhook's secret_token param). If the secret isn't
// configured, this check is skipped entirely — no extra setup required to
// get started.
// ---------------------------------------------------------------------------
async function handleTelegramWebhook(request, env, ctx) {
  try {
    const configuredSecret = env.TELEGRAM_WEBHOOK_SECRET;
    if (configuredSecret) {
      const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (incomingSecret !== configuredSecret) {
        console.error("Telegram webhook: secret token mismatch.");
        return new Response("OK", { status: 200 }); // ack quietly, reveal nothing
      }
    }

    const update = await request.json();
    const msg = update?.message;
    const chatId = msg?.chat?.id;

    if (!chatId) {
      // Not a plain text message (edited_message, channel_post, etc.) —
      // nothing to reply to yet. Ack and move on.
      return new Response("OK", { status: 200 });
    }

    const text = (msg.text || "").trim();

    if (text.startsWith("/start")) {
      const payload = text.replace("/start", "").trim(); // "" or "starterkit", "class9", ...
      await handleStartCommand(chatId, payload, env);
    } else {
      // Placeholder for future commands (/help, /resources, /quiz, ...).
      // For now, nudge the student back to /start.
      await sendTelegramMessage(chatId, "Type /start to get your FREE Study Starter Kit! ??", env);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Telegram Webhook Exception:", error.message);
    return new Response("OK", { status: 200 });
  }
}
// ===== TELEGRAM END =====

