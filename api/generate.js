// ═══════════════════════════════════════════════
// /api/generate.js  — Vercel Serverless Function
// Receives: { tools, role, niche, type, token }
// Returns:  { result } — blueprint JSON or string
// ═══════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  // CORS — allow your Vercel domain + local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── 1. Auth — verify Supabase JWT ─────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  // ── 2. Check + deduct credits ─────────────────
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('credits, bp_unlocked')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) return res.status(404).json({ error: 'Profile not found' });

  const { tools, role, niche, type } = req.body; // type = 'quick' | 'full'

  // Full blueprint requires bp_unlocked
  if (type === 'full' && !profile.bp_unlocked) {
    return res.status(403).json({ error: 'Full blueprint not purchased' });
  }

  if (profile.credits <= 0) {
    return res.status(402).json({ error: 'No credits remaining' });
  }

  // Deduct 1 credit atomically
  const { error: deductError } = await supabase
    .from('profiles')
    .update({ credits: profile.credits - 1, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .eq('credits', profile.credits); // optimistic lock — prevents double-spend

  if (deductError) return res.status(500).json({ error: 'Credit deduction failed' });

  // ── 3. Build prompt ───────────────────────────
  const prompt = type === 'full'
    ? buildFullPrompt(tools, role, niche)
    : buildQuickPrompt(tools, role, niche);

  // ── 4. Call Claude ────────────────────────────
  let result = null;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: type === 'full' ? 4096 : 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    result = msg.content[0]?.text || null;
  } catch (e) {
    console.error('Anthropic API error:', e.message);
  }

  if (!result) {
    // Refund the credit if API failed
    await supabase.from('profiles')
      .update({ credits: profile.credits, updated_at: new Date().toISOString() })
      .eq('id', user.id);
    return res.status(502).json({ error: 'API unavailable' });
  }

  // ── 5. Log the spin ───────────────────────────
  await supabase.from('spins').insert({
    user_id: user.id, tools, role, niche
  });

  // ── 6. Return result + updated credit count ───
  return res.status(200).json({
    result,
    creditsRemaining: profile.credits - 1
  });
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildQuickPrompt(tools, role, niche) {
  const t = tools.join(', ');

  if (role === 'Creator') {
    return `You are a business strategy assistant. You have been given 3 AI tools: ${t}
Niche: ${niche}

Respond in 3 stacked parts combined into one JSON output:

PART 1 — Detailed Business Blueprint: what each tool does, how they combine, best business models, ways to use these tools to build a business and make money, a real-world small business example, and how to get started with practical steps.

PART 2 — Simple Inspiring Pitch: a relatable, motivating version for a non-technical audience. Be honest about the effort required. Make it feel achievable.

PART 3 — Merged Final Output: combine both into one visionary but actionable summary. If the tools don't obviously connect, find the most creative but realistic combination for a small business owner.

Return ONLY valid JSON in this exact format:
{
  "vision": "PART 3 merged output — visionary but actionable, 2-3 sentences",
  "monetization": "(1) First revenue stream — specific and direct. (2) Second revenue stream. (3) Third revenue stream or upsell.",
  "roi": "Realistic income estimate e.g. $1,500–$4,000/month within 60-90 days",
  "use_case": "PART 1 — real-world small business example. Start with 'For example, a [specific small business]...' and show exactly how the 3 tools work together for them",
  "steps": [
    {"desc": "TOOL NAME: one punchy sentence — what to do and why. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — what to do and why. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — what to do and why. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — what to do and why. Max 20 words.", "tool_link_ref": "tool name"}
  ],
  "calendar_summary": "PART 2 — simple inspiring pitch for a non-technical audience. Relatable, motivating, honest about effort. 3-4 sentences max."
}

Return ONLY valid JSON. No markdown. No extra text.`;
  }

  if (role === 'Entrepreneur') {
    return `You are a senior business strategist. A business owner in the ${niche} space just spun these 3 Google AI tools: ${t}

Write a revenue-focused blueprint showing exactly how to use these tools to land clients, automate services, and build recurring income. Be specific about retainers, subscriptions, and service fees.

Return ONLY valid JSON:
{
  "vision": "One sentence: how a ${niche} business owner uses ${t} together to build a scalable income stream",
  "monetization": "(1) Primary income stream with price point. (2) Secondary stream or upsell. (3) Recurring revenue or referral model.",
  "roi": "Realistic monthly range e.g. $2,000–$8,000/month with a timeline",
  "use_case": "Start with 'If you run a [specific ${niche} business]' — show in 3-4 sentences exactly how these tools work together to save time and make money",
  "steps": [
    {"desc": "TOOL NAME: one punchy sentence — specific revenue action. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — specific revenue action. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — specific revenue action. Max 20 words.", "tool_link_ref": "tool name"}
  ],
  "calendar_summary": "Month 1: set up and first clients. Month 2: systemize and scale. Month 3: recurring revenue and referrals."
}

Return ONLY valid JSON. No markdown. No extra text.`;
  }

  // Developer
  return `You are a senior technical architect. A developer in the ${niche} space just spun these 3 Google AI tools: ${t}

Write a technical blueprint showing exactly how to build and ship a product using these tools — name real features, APIs, and SDKs. Income model is SaaS, API usage fees, and consulting.

Return ONLY valid JSON:
{
  "vision": "One sentence: what product or service a developer builds by combining ${t}",
  "monetization": "(1) SaaS or API tier pricing model. (2) Consulting or white-label revenue. (3) Marketplace or usage-based upsell.",
  "roi": "Realistic MRR target e.g. $3,000–$10,000/month within 90 days of launch",
  "use_case": "Start with 'Build a [specific product]' — describe in 3-4 sentences the exact technical stack using these 3 tools and what problem it solves",
  "steps": [
    {"desc": "TOOL NAME: one punchy sentence — exact API or feature to use. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — exact API or feature to use. Max 20 words.", "tool_link_ref": "tool name"},
    {"desc": "TOOL NAME: one punchy sentence — exact API or feature to use. Max 20 words.", "tool_link_ref": "tool name"}
  ],
  "calendar_summary": "Month 1: prototype and first paying user. Month 2: paid launch and beta feedback. Month 3: growth and iteration."
}

Return ONLY valid JSON. No markdown. No extra text.`;
}

function buildFullPrompt(tools, role, niche) {
  const t0 = tools[0], t1 = tools[1], t2 = tools[2];
  const n = niche;
  const r = role;

  return `You are a senior business strategist, competitive strategy consultant, and marketing expert with 20+ years helping ${r}s build scalable income systems.

A ${r} in the ${n} space just unlocked these 3 Google AI tools: ${t0}, ${t1}, ${t2}.

Create a FULL IMPLEMENTATION BLUEPRINT. Return ONLY valid JSON in this exact structure (no markdown, no extra text):

{
  "headline": "Punchy 6-10 word title for this exact tool combo",
  "executive_summary": "3-4 sentences: what this system does, who it's for, and realistic income potential within 90 days",
  "value_proposition": "One sentence: the unique value this combo creates that nothing else can replicate",
  "positioning_statement": "For [audience] who [problem], this system is the only [category] that [benefit] — unlike [alternative] which [limitation].",
  "target_audience": {
    "primary": "Specific description of ideal customer with psychographics",
    "pain_points": ["pain 1", "pain 2", "pain 3"],
    "buying_triggers": ["trigger 1", "trigger 2"]
  },
  "competitive_landscape": [
    { "type": "Direct competitor", "name": "Specific competitor name", "weakness": "Their key gap this system exploits" },
    { "type": "Indirect alternative", "name": "What prospects do instead", "weakness": "Why this system wins" },
    { "type": "Do nothing", "name": "Status quo", "weakness": "Cost of inaction — time, money, opportunity lost" }
  ],
  "white_space": "2-3 sentences on the underserved market gap this combo uniquely fills",
  "competitive_positioning": "How to position against the above — the 1-sentence battle cry",
  "revenue_model": {
    "primary": "Main income stream with price point",
    "secondary": "Second income stream",
    "tertiary": "Third income stream or upsell",
    "pricing_rationale": "Why these price points work for this market"
  },
  "income_projection": {
    "month_1": "Conservative realistic range",
    "month_3": "With consistency and iteration",
    "month_6": "Scaled version",
    "assumptions": "What has to be true for these numbers"
  },
  "marketing": {
    "channel_1": { "platform": "Platform name", "tactic": "Specific tactic", "content_type": "What to post/send", "frequency": "How often", "goal": "Metric to hit" },
    "channel_2": { "platform": "Platform name", "tactic": "Specific tactic", "content_type": "What to post/send", "frequency": "How often", "goal": "Metric to hit" },
    "channel_3": { "platform": "Platform name", "tactic": "Specific tactic", "content_type": "What to post/send", "frequency": "How often", "goal": "Metric to hit" }
  },
  "roadmap": {
    "week_1": ["Action 1", "Action 2", "Action 3"],
    "week_2": ["Action 1", "Action 2", "Action 3"],
    "week_3_4": ["Action 1", "Action 2", "Action 3"],
    "month_2": ["Action 1", "Action 2"],
    "month_3": ["Action 1", "Action 2"]
  },
  "ad_copy": [
    { "platform": "Facebook/Instagram", "headline": "Ad headline", "body": "Ad body copy 2-3 sentences", "cta": "Call to action" },
    { "platform": "Google Search", "headline": "Search ad headline", "body": "Description line", "cta": "CTA" },
    { "platform": "TikTok/Reels", "hook": "First 3 seconds spoken line", "script": "15-second script outline", "cta": "CTA" }
  ],
  "tool_configs": [
    { "tool": "${t0}", "setup": "Exact setup steps", "use_case": "Specific use in this system", "pro_tip": "Non-obvious power move" },
    { "tool": "${t1}", "setup": "Exact setup steps", "use_case": "Specific use in this system", "pro_tip": "Non-obvious power move" },
    { "tool": "${t2}", "setup": "Exact setup steps", "use_case": "Specific use in this system", "pro_tip": "Non-obvious power move" }
  ],
  "kpis": [
    { "metric": "KPI name", "target": "Specific number", "timeline": "By when", "how_to_measure": "Tool or method" },
    { "metric": "KPI name", "target": "Specific number", "timeline": "By when", "how_to_measure": "Tool or method" },
    { "metric": "KPI name", "target": "Specific number", "timeline": "By when", "how_to_measure": "Tool or method" }
  ]
}

Be specific. Use real numbers. Name real tools, platforms, and tactics. Write for a ${r} in ${n} who wants to move fast.
Return ONLY valid JSON. No markdown fences. No extra text.`;
}
