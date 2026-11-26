// Test APInex.bond free models — run locally with: node test_apinex.mjs
const APINEX_KEY = "sk-apxc47a81113532444adc7e765c70f2e4730ccafd76d9fd82a";
const BASE = "https://api.apinex.bond/v1/chat/completions";

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

const modelsToTest = [
  "free/gpt-6-luna",
  "free/qwen-3.8-max",
  "free/glm-5.3-flash",
  "free/gemini-4-hydrogen",
  "free/deepseek-v4.1-flash",
  "free/kimi-k3",
];

async function testModel(model) {
  console.log(`\n=== Testing ${model} ===\n`);
  try {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${APINEX_KEY}`,
      },
      body: JSON.stringify({
        model,
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
      console.log(JSON.stringify(data, null, 2).slice(0, 500));
      return false;
    }
    const msg = data.choices?.[0]?.message || {};
    const content = msg.content || msg.reasoning_content || msg.reasoning || "";
    console.log("Status:", res.status);
    console.log("Response:\n", content);
    console.log("\n--- JSON Parse Test ---");
    try {
      const clean = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      const parsed = JSON.parse(clean);
      console.log("Valid JSON: YES");
      if (parsed.emails?.[0]) {
        console.log("Subject:", parsed.emails[0].subject);
        const words = parsed.emails[0].body?.split(/\s+/).length || 0;
        console.log("Body length:", parsed.emails[0].body?.length, "words:", words);
        console.log("Body:\n", parsed.emails[0].body);
      }
    } catch (e) {
      console.log("Valid JSON: NO — plain text fallback needed");
      console.log("First 200 chars:", content.substring(0, 200));
    }
    return true;
  } catch (e) {
    console.log(`NETWORK ERROR: ${e.message}`);
    return false;
  }
}

console.log("Testing APInex.bond free models...\n");
let workingModels = [];
for (const model of modelsToTest) {
  const ok = await testModel(model);
  if (ok) workingModels.push(model);
  // Small delay between requests
  await new Promise(r => setTimeout(r, 2000));
}

console.log("\n\n=== SUMMARY ===");
console.log(`Working models: ${workingModels.length}`);
for (const m of workingModels) console.log(`  ✓ ${m}`);
if (workingModels.length === 0) console.log("  None worked — check the API key or network.");
