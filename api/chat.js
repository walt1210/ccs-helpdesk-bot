// ============================================================
// api/chat.js  —  CCS Help Desk Bot · server function (BACKUP COPY)
// ------------------------------------------------------------
// This file runs on VERCEL'S SERVER, never in the student's browser.
// That is why it is safe for it to read the secret API key.
// The browser (index.html) only ever talks to THIS file at /api/chat.
// ============================================================

// Which Gemini model to use. We read it from an environment variable
// so the instructor can switch models in Vercel without editing code.
// If no variable is set, we fall back to a free-tier Flash-Lite model.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

// Server-side safety caps (a second wall behind the guards in index.html).
// Browser guards can be skipped by a clever user; these cannot.
const MAX_USER_CHARS = 300;     // longest allowed student message
const MAX_MESSAGES = 30;        // longest allowed chat history per request
const MAX_SYSTEM_CHARS = 4000;  // longest allowed system prompt (job card + FAQ)
const MAX_REPLY_TOKENS = 800;   // longest reply we let the AI write

// Vercel calls this function every time the browser sends a request to /api/chat.
// "req" = the request that came in, "res" = the response we send back.
module.exports = async function handler(req, res) {
  // 1) Only accept POST requests (the browser sends the chat with POST).
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Please use POST." });
  }

  // 2) OPTIONAL lock: only answer requests coming from our own website.
  //    Set ALLOWED_ORIGIN in Vercel (e.g. https://auf-ccs-helpdesk.vercel.app) to turn it on.
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return res.status(403).json({ error: "This bot only answers its own website." });
  }

  // 3) Read the secret key from the server's environment variables.
  //    It is typed into Vercel's settings, NOT written in any file on GitHub.
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "The server is missing GEMINI_API_KEY. Add it in Vercel, then Redeploy."
    });
  }

  // 4) Read what the browser sent. Vercel turns the JSON text into an object for us.
  const body = req.body || {};
  // "system" = the bot's job card (system prompt). Must be text.
  const system = typeof body.system === "string" ? body.system : "";
  // "messages" = the chat so far: [{ role: "user" | "assistant", content: "..." }]
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // 5) Server guards: reject anything too big or badly shaped.
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: "Send between 1 and " + MAX_MESSAGES + " messages." });
  }
  if (system.length > MAX_SYSTEM_CHARS) {
    return res.status(400).json({ error: "The bot instructions are too long." });
  }
  for (const m of messages) {
    // Every message needs a valid role and some text.
    const okRole = m && (m.role === "user" || m.role === "assistant");
    const okText = m && typeof m.content === "string" && m.content.trim() !== "";
    if (!okRole || !okText) {
      return res.status(400).json({ error: "Each message needs a role and some text." });
    }
    // Student messages have the same 300-character limit as the app's guard.
    if (m.role === "user" && m.content.length > MAX_USER_CHARS) {
      return res.status(400).json({ error: "Messages must be " + MAX_USER_CHARS + " characters or fewer." });
    }
  }

  // 6) Translate our chat into Gemini's format.
  //    Gemini calls the AI's role "model" (not "assistant"),
  //    and puts the text inside a "parts" list.
  const contents = messages.map(function (m) {
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    };
  });

  // 7) Build the request for Gemini.
  const payload = {
    contents: contents,                                   // the chat (memory)
    generationConfig: { maxOutputTokens: MAX_REPLY_TOKENS } // cap the reply length
  };
  // The system prompt travels separately from the chat, as "systemInstruction".
  if (system) {
    payload.systemInstruction = { parts: [{ text: system }] };
  }

  // 8) Call Gemini. The key goes in a header, on the server, out of sight.
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";
  let response;
  let data;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", // we are sending JSON
        "x-goog-api-key": key               // the secret key (server only!)
      },
      body: JSON.stringify(payload)          // turn our object into JSON text
    });
    // Read Gemini's answer. If it is not valid JSON, use an empty object.
    data = await response.json().catch(function () { return {}; });
  } catch (err) {
    // Network problem between Vercel and Google.
    return res.status(502).json({ error: "Could not reach the AI service. Try again." });
  }

  // 9) Gemini's free tier said "too many requests" → pass 429 back to the browser.
  if (response.status === 429) {
    return res.status(429).json({ error: "The free AI quota is busy. Wait a minute and try again." });
  }
  // Any other error from Gemini → friendly message (Google's error text never contains our key).
  if (!response.ok) {
    const msg = (data && data.error && data.error.message) || "The AI service returned an error.";
    return res.status(502).json({ error: msg });
  }

  // 10) Pull the reply text out of Gemini's answer.
  //     The text lives in candidates[0].content.parts[...].text.
  //     We skip any "thought" parts and join the rest together.
  const candidate = (data.candidates && data.candidates[0]) || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const reply = parts
    .filter(function (p) { return !p.thought; })
    .map(function (p) { return p.text || ""; })
    .join("")
    .trim();

  // 11) Read the REAL token counts that Gemini reports (used by the Token & Cost Meter).
  const u = data.usageMetadata || {};
  const usage = {
    input: u.promptTokenCount || 0,                                    // tokens we sent
    output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) // tokens it wrote (thinking counts too)
  };

  // 12) Send the answer back to the browser in the agreed shape: { reply, usage, model }.
  return res.status(200).json({
    reply: reply || "Sorry, I could not answer that. Please try asking another way.",
    usage: usage,
    model: MODEL
  });
};
