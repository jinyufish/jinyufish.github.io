export const config = { runtime: 'edge' };

let cachedGlobalKnowledge = null;
let cachedAt = 0;

const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

async function getGlobalKnowledge() {
  const now = Date.now();

  if (cachedGlobalKnowledge && now - cachedAt < CACHE_TTL) {
    return cachedGlobalKnowledge;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If Supabase env vars are missing, do not crash the chatbot.
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables.');
    return '';
  }

  const url =
    `${supabaseUrl}/rest/v1/global_knowledge_versions` +
    `?select=global_knowledge,version_number,created_at` +
    `&order=created_at.desc` +
    `&limit=1`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Failed to fetch global knowledge:', err);
    return cachedGlobalKnowledge || '';
  }

  const data = await resp.json();
  const latest = data?.[0]?.global_knowledge;

  let globalKnowledge = '';

  if (typeof latest === 'string') {
    globalKnowledge = latest;
  } else if (latest) {
    globalKnowledge = JSON.stringify(latest);
  }

  cachedGlobalKnowledge = globalKnowledge;
  cachedAt = now;

  return globalKnowledge;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const globalKnowledge = await getGlobalKnowledge().catch((err) => {
    console.error('Global knowledge fallback:', err);
    return '';
  });

  const difyResp = await fetch('https://api.dify.ai/v1/chat-messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DIFY_CHAT_API_KEY}`,
    },
    body: JSON.stringify({
      query: body.query,
      inputs: {
        ...(body.inputs ?? {}),
        global_knowledge: globalKnowledge,
      },
      response_mode: 'streaming',
      conversation_id: body.conversation_id ?? '',
      user: body.user ?? 'visitor',
    }),
  });

  if (!difyResp.ok) {
    const err = await difyResp.text();
    return new Response(err, { status: difyResp.status });
  }

  return new Response(difyResp.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}