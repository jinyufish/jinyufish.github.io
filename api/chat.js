export const config = { runtime: 'edge' };

let cachedGlobalKnowledge = null;
let cachedAt = 0;
let refreshInFlight = null;

const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

// Actual network read from Supabase. Updates the module cache on success.
async function fetchGlobalKnowledge() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If Supabase env vars are missing, do not crash the chatbot.
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables.');
    return cachedGlobalKnowledge || '';
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
  cachedAt = Date.now();
  return globalKnowledge;
}

// De-duped background refresh: at most one Supabase read in flight.
function startRefresh() {
  if (!refreshInFlight) {
    refreshInFlight = fetchGlobalKnowledge().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Stale-while-revalidate reader.
// Returns { value, background, cached }:
//   value      — resolves to the knowledge string to use right now.
//                Only blocks on the network when there is NO cache at all (cold).
//   background — a promise to hand to ctx.waitUntil(), or null.
//   cached     — 'fresh' | 'stale' | 'cold' (for timing logs).
function readGlobalKnowledge() {
  const now = Date.now();
  const hasCache = cachedGlobalKnowledge !== null;
  const fresh = hasCache && now - cachedAt < CACHE_TTL;

  if (fresh) {
    return { value: Promise.resolve(cachedGlobalKnowledge), background: null, cached: 'fresh' };
  }
  if (hasCache) {
    // Serve the stale value instantly; refresh in the background so the
    // user never waits on Supabase after the very first read.
    return { value: Promise.resolve(cachedGlobalKnowledge), background: startRefresh(), cached: 'stale' };
  }
  // Cold isolate: nothing cached yet, must wait for the first read.
  return { value: startRefresh(), background: null, cached: 'cold' };
}

export default async function handler(req, ctx) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Warm-up ping: prime this isolate + the Supabase cache WITHOUT calling Dify.
  // The frontend fires this on first user intent (hover / focus) so that the
  // real message a few seconds later skips the cold-start penalty. Zero LLM cost.
  if (body.warmup === true) {
    const { value, background } = readGlobalKnowledge();
    if (background) ctx?.waitUntil?.(background);
    await value.catch(() => {});
    return new Response(JSON.stringify({ warmed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const tStart = Date.now();

  const { value, background, cached } = readGlobalKnowledge();
  if (background) ctx?.waitUntil?.(background);

  const globalKnowledge = await value.catch((err) => {
    console.error('Global knowledge fallback:', err);
    return '';
  });

  const tKnowledge = Date.now();

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

  const tDifyHeaders = Date.now();

  // Tap the passthrough stream to log time-to-first-byte from Dify without
  // buffering — the first chunk flows straight to the client as before.
  let firstByteLogged = false;
  const timing = new TransformStream({
    transform(chunk, controller) {
      if (!firstByteLogged) {
        firstByteLogged = true;
        console.log(
          JSON.stringify({
            metric: 'chat_timing_ms',
            knowledge_cache: cached,
            supabase_read: tKnowledge - tStart,
            dify_response_headers: tDifyHeaders - tKnowledge,
            dify_time_to_first_byte: Date.now() - tDifyHeaders,
            total_to_first_byte: Date.now() - tStart,
          })
        );
      }
      controller.enqueue(chunk);
    },
  });

  return new Response(difyResp.body.pipeThrough(timing), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
