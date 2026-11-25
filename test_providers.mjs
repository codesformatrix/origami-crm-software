// Direct LLM provider test — runs all three providers with the new system prompt
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

const systemPrompt = `You are Ali, a freelance business development person who writes cold emails that actually get replies. Your writing sounds like a competent human sent it from their phone — short sentences, natural rhythm, zero corporate polish. You read the prospect's company before writing and reference something real from their world. The email should feel like it was written for this specific person, not templated.

Writing style:
- Write like you are texting a smart colleague, not writing a marketing email.
- Short sentences. Varying sentence length. Natural rhythm. No corporate polish.
- Use plain, common words. If a 5th grader couldn't follow it, simplify.
- Be direct. State the observation, connect it to their situation, ask one question. That is the whole email.
- No filler: no "I wanted to reach out", no "I hope this finds you well", no throat-clearing, no preamble.
- Sound like you are on the prospect's side, not pitching them.

Hard rules:
- Plain text only. No bullets, no dashes, no markdown.
- No buzzwords: leverage, streamline, synergy, solutions, optimize, utilize, empower, seamless, etc.
- No pitch dump. One idea per email.
- No fake flattery. If you mention something positive, make it specific and grounded.
- Never repeat an angle or phrase from earlier emails in the thread.
- Subject line: lowercase, 2-5 words, curious but not clickbait.

Touch 1: 60 to 110 words. Open with one specific detail from the research. Tie it to a real problem they likely have. Ask one low-pressure question.

Include the exact unsubscribe URL in the footer.

Return JSON only: {"emails":[{"step_number":1,"subject":"...","body":"...","hook_used":"...","sources":["url1"]}]}. No markdown fences.`;

const userPrompt = JSON.stringify({
  context: {
    prospect: {
      name: "Rajesh Kumar",
      company: "Bharati IoT Systems",
      domain: "bharatiot.in",
      title: "Founder",
      location: "Jaipur, India",
    },
    research: {
      sources: [
        { url: "https://bharatiot.in/about", summary: "Bharati IoT builds low-power sensor gateways for Indian agriculture and water management." },
        { url: "https://techcrunch.com/bharat-iot", summary: "Company recently launched a new irrigation monitoring product line." },
      ],
      talking_points: ["Low-power sensor gateways for agriculture", "New irrigation monitoring product", "Operating in Indian agricultural market"],
      pain_points: ["Agricultural water waste is a massive problem in India", "Farmers struggle with unpredictable irrigation"],
    },
    previous_emails: [],
  },
  step_number: 1,
  unsubscribe_url: "https://origami-crm-software.pages.dev/api/track/u/test123",
});

async function testGroq() {
  console.log("=== Testing Groq (llama-3.3-70b-versatile) ===\n");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 800,
      temperature: 0.35,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.log(`ERROR: HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const msg = data.choices?.[0]?.message || {};
  const content = msg.content || msg.reasoning_content || msg.reasoning || "";
  console.log("Status:", res.status);
  console.log("Model:", data.model);
  console.log("Response:\n", content);
  console.log("\n--- JSON Parse Test ---");
  try {
    const clean = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(clean);
    console.log("Valid JSON: YES");
    console.log("Has emails array:", Array.isArray(parsed.emails));
    if (parsed.emails?.[0]) {
      console.log("Subject:", parsed.emails[0].subject);
      console.log("Body length:", parsed.emails[0].body?.length, "words:", parsed.emails[0].body?.split(/\s+/).length);
      console.log("Body:\n", parsed.emails[0].body);
    }
  } catch (e) {
    console.log("Valid JSON: NO — plain text fallback needed");
    console.log("First 200 chars:", content.substring(0, 200));
  }
}

async function testGemini() {
  console.log("\n\n=== Testing Gemini (gemini-3.5-flash) ===\n");
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 800, temperature: 0.35 },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.log(`ERROR: HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const content = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
  console.log("Status:", res.status);
  console.log("Response:\n", content);
  console.log("\n--- JSON Parse Test ---");
  try {
    const clean = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(clean);
    console.log("Valid JSON: YES");
    console.log("Has emails array:", Array.isArray(parsed.emails));
    if (parsed.emails?.[0]) {
      console.log("Subject:", parsed.emails[0].subject);
      console.log("Body length:", parsed.emails[0].body?.length, "words:", parsed.emails[0].body?.split(/\s+/).length);
      console.log("Body:\n", parsed.emails[0].body);
    }
  } catch (e) {
    console.log("Valid JSON: NO — plain text fallback needed");
    console.log("First 200 chars:", content.substring(0, 200));
  }
}

async function testOpenRouter() {
  console.log("\n\n=== Testing OpenRouter (google/gemma-4-31b-it:free) ===\n");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "https://origami.consulting",
      "X-Title": "OrigamiOutreach",
    },
    body: JSON.stringify({
      model: "google/gemma-4-31b-it:free",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 800,
      temperature: 0.35,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.log(`ERROR: HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const msg = data.choices?.[0]?.message || {};
  const content = msg.content || msg.reasoning_content || msg.reasoning || "";
  console.log("Status:", res.status);
  console.log("Model:", data.model);
  console.log("Response:\n", content);
  console.log("\n--- JSON Parse Test ---");
  try {
    const clean = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(clean);
    console.log("Valid JSON: YES");
    console.log("Has emails array:", Array.isArray(parsed.emails));
    if (parsed.emails?.[0]) {
      console.log("Subject:", parsed.emails[0].subject);
      console.log("Body length:", parsed.emails[0].body?.length, "words:", parsed.emails[0].body?.split(/\s+/).length);
      console.log("Body:\n", parsed.emails[0].body);
    }
  } catch (e) {
    console.log("Valid JSON: NO — plain text fallback needed");
    console.log("First 200 chars:", content.substring(0, 200));
  }
}

await testGroq();
await testGemini();
await testOpenRouter();
console.log("\n\n=== ALL TESTS COMPLETE ===");
