// ═══════════════════════════════════════════════
// /api/webhook.js — Stripe Webhook Handler
// Listens for checkout.session.completed events
// Grants credits or blueprint unlock in Supabase
// ═══════════════════════════════════════════════

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Stripe requires the raw body for signature verification
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const amountPaid = session.amount_total; // in cents

    if (!email) {
      console.error('No email in Stripe session:', session.id);
      return res.status(200).json({ received: true }); // 200 so Stripe doesn't retry
    }

    // Look up Supabase user by email
    const { data: users, error: lookupError } = await supabase.auth.admin.listUsers();
    if (lookupError) {
      console.error('User lookup failed:', lookupError.message);
      return res.status(500).json({ error: 'User lookup failed' });
    }

    const user = users?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

    if (!user) {
      // User paid but hasn't created an account yet — store pending grant
      // They'll get credits when they sign up (handled by handle_new_user trigger + pending_grants table)
      console.log(`Paid user ${email} not yet registered — storing pending grant`);
      await storePendingGrant(email, amountPaid);
      return res.status(200).json({ received: true });
    }

    // Apply the grant
    await applyGrant(user.id, amountPaid);
  }

  return res.status(200).json({ received: true });
}

async function applyGrant(userId, amountCents) {
  if (amountCents === 900) {
    // $9 — add 50 credits
    const { data: profile } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .single();

    const current = profile?.credits || 0;
    await supabase.from('profiles')
      .update({ credits: current + 50, updated_at: new Date().toISOString() })
      .eq('id', userId);

    console.log(`Granted 50 credits to user ${userId}`);

  } else if (amountCents === 1900) {
    // $19 — unlock full blueprint
    await supabase.from('profiles')
      .update({ bp_unlocked: true, updated_at: new Date().toISOString() })
      .eq('id', userId);

    console.log(`Unlocked full blueprint for user ${userId}`);
  }
}

async function storePendingGrant(email, amountCents) {
  // Store in a pending_grants table so we can apply when they sign up
  await supabase.from('pending_grants').upsert({
    email: email.toLowerCase(),
    amount_cents: amountCents,
    created_at: new Date().toISOString()
  }, { onConflict: 'email' });
}
