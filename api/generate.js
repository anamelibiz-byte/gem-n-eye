// ═══════════════════════════════════════════════
// /api/generate.js  — Vercel Serverless Function
// Receives: { tools, role, niche, type, token }
// Returns:  { result } — blueprint JSON or string
// ═══════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role — bypasses RLS
);

const MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-pro'];
const GEMINI_KEY = process.env.GEMINI_API_KEY;

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

  // ── 4. Call Gemini with model fallback ────────
  let result = null;
  for (const model of MODELS) {
    try {
      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: type === 'full' ? 4096 : 1200 }
          })
        }
      );
      const data = await gemRes.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (raw) { result = raw; break; }
    } catch (e) {
      console.error(`Model ${model} failed:`, e.message);
    }
  }

  if (!result) {
    // Refund the credit if Gemini failed entirely
    await supabase.from('profiles')
      .update({ credits: profile.credits, updated_at: new Date().toISOString() })
      .eq('id', user.id);
    return res.status(502).json({ error: 'Gemini unavailable' });
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
  const roleCtx = {
    Creator:      'a content creator focused on audience growth and digital products',
    Entrepreneur: 'a business owner focused on client revenue and scaling services',
    Developer:    'a technical builder focused on shipping SaaS products and APIs',
  }[role] || 'a professional';

  return `You are a senior business strategist and monetization expert.

A ${roleCtx} just spun these 3 Google AI tools: ${t}
Their niche: ${niche}

Write a sharp, practical monetization blueprint in this EXACT JSON format:
{
  "headline": "5-8 word punchy title for this combo",
  "tagline": "One sentence describing the business opportunity",
  "opportunity": "2-3 sentences on WHY this combo is valuable right now",
  "steps": [
    { "title": "Step title", "tool": "which tool", "action": "exactly what to do", "output": "what you get" },
    { "title": "Step title", "tool": "which tool", "action": "exactly what to do", "output": "what you get" },
    { "title": "Step title", "tool": "which tool", "action": "exactly what to do", "output": "what you get" }
  ],
  "income_potential": "Realistic monthly range with a specific number e.g. $2,000–$6,000/month",
  "first_move": "The single most important thing to do in the next 24 hours",
  "scenario": "A relatable real-world example: 'e.g. A local yoga studio uses [tool] to...'",
  "time_to_revenue": "Realistic estimate e.g. 2-4 weeks"
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
