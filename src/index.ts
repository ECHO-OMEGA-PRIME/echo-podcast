/**
 * Echo Podcast v1.0.0 — Podcast Hosting Platform
 * RSS feed, episode management, download tracking, embeddable player,
 * subscriber management, AI show notes & transcription.
 */

interface Env {
  DB: D1Database;
  PC_CACHE: KVNamespace;
  AUDIO: R2Bucket;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  ECHO_API_KEY: string;
}

interface RLState { c: number; t: number }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
}

function sanitize(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function authOk(req: Request, env: Env): boolean {
  const k = req.headers.get('X-Echo-API-Key') || req.headers.get('Authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('key');
  return k === env.ECHO_API_KEY;
}

async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec: number): Promise<boolean> {
  const raw = await kv.get<RLState>(`rl:${key}`, 'json');
  const now = Date.now();
  if (!raw || (now - raw.t) > windowSec * 1000) {
    await kv.put(`rl:${key}`, JSON.stringify({ c: 1, t: now }), { expirationTtl: windowSec * 2 });
    return false;
  }
  const elapsed = (now - raw.t) / 1000;
  const decay = Math.max(0, raw.c - (elapsed / windowSec) * limit);
  if (decay + 1 > limit) return true;
  await kv.put(`rl:${key}`, JSON.stringify({ c: decay + 1, t: now }), { expirationTtl: windowSec * 2 });
  return false;
}

function slugify(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function detectApp(ua: string): string {
  if (!ua) return 'Unknown';
  const lower = ua.toLowerCase();
  if (lower.includes('spotify')) return 'Spotify';
  if (lower.includes('apple')) return 'Apple Podcasts';
  if (lower.includes('overcast')) return 'Overcast';
  if (lower.includes('pocket casts') || lower.includes('pocketcasts')) return 'Pocket Casts';
  if (lower.includes('castro')) return 'Castro';
  if (lower.includes('google')) return 'Google Podcasts';
  if (lower.includes('stitcher')) return 'Stitcher';
  if (lower.includes('castbox')) return 'Castbox';
  if (lower.includes('podbean')) return 'Podbean';
  if (lower.includes('chrome') || lower.includes('firefox') || lower.includes('safari')) return 'Web Browser';
  return 'Other';
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });

    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    try {
      if (p === '/health' || p === '/') return json({ status: 'ok', service: 'echo-podcast', version: '1.0.0', timestamp: new Date().toISOString() });

      /* ══════════════════ PUBLIC ══════════════════ */

      /* ── RSS Feed ── */
      if (m === 'GET' && p.match(/^\/feed\/[a-z0-9-]+$/)) {
        const slug = p.split('/')[2];
        const cached = await env.PC_CACHE.get(`feed:${slug}`);
        if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });

        const show = await env.DB.prepare('SELECT * FROM shows WHERE slug = ? AND status = ?').bind(slug, 'active').first();
        if (!show) return new Response('Show not found', { status: 404 });

        const episodes = await env.DB.prepare("SELECT * FROM episodes WHERE show_id = ? AND status = 'published' AND published_at <= datetime('now') ORDER BY published_at DESC LIMIT 500").bind(show.id).all();

        let rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>${escXml(show.title as string)}</title>
  <link>${escXml(show.website as string || `https://echo-podcast.bmcii1976.workers.dev/show/${show.slug}`)}</link>
  <description>${escXml(show.description as string || '')}</description>
  <language>${show.language || 'en'}</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <itunes:author>${escXml(show.author as string || '')}</itunes:author>
  <itunes:owner><itunes:name>${escXml(show.owner_name as string || '')}</itunes:name><itunes:email>${escXml(show.owner_email as string || '')}</itunes:email></itunes:owner>
  <itunes:explicit>${show.explicit ? 'true' : 'false'}</itunes:explicit>
  ${show.image_url ? `<itunes:image href="${escXml(show.image_url as string)}"/>` : ''}
  ${show.category ? `<itunes:category text="${escXml(show.category as string)}">${show.subcategory ? `<itunes:category text="${escXml(show.subcategory as string)}"/>` : ''}</itunes:category>` : ''}
  <generator>Echo Podcast v1.0.0</generator>`;

        for (const ep of episodes.results) {
          const pubDate = new Date(ep.published_at as string).toUTCString();
          const guid = `echo-podcast-${show.slug}-${ep.slug}`;
          rss += `
  <item>
    <title>${escXml(ep.title as string)}</title>
    <description><![CDATA[${ep.description || ''}]]></description>
    ${ep.content ? `<content:encoded><![CDATA[${ep.content}]]></content:encoded>` : ''}
    <enclosure url="${escXml(ep.audio_url as string || '')}" length="${ep.file_size || 0}" type="audio/mpeg"/>
    <guid isPermaLink="false">${guid}</guid>
    <pubDate>${pubDate}</pubDate>
    <itunes:duration>${formatDuration(ep.duration_sec as number || 0)}</itunes:duration>
    <itunes:explicit>${ep.explicit ? 'true' : 'false'}</itunes:explicit>
    <itunes:episodeType>${ep.episode_type || 'full'}</itunes:episodeType>
    ${ep.season ? `<itunes:season>${ep.season}</itunes:season>` : ''}
    ${ep.episode_number ? `<itunes:episode>${ep.episode_number}</itunes:episode>` : ''}
    ${ep.image_url ? `<itunes:image href="${escXml(ep.image_url as string)}"/>` : ''}
    ${ep.transcript ? `<podcast:transcript url="${escXml(ep.transcript as string)}" type="text/plain"/>` : ''}
  </item>`;
        }

        rss += '\n</channel>\n</rss>';
        await env.PC_CACHE.put(`feed:${slug}`, rss, { expirationTtl: 300 });
        return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
      }

      /* ── Public show page (JSON) ── */
      if (m === 'GET' && p.match(/^\/show\/[a-z0-9-]+$/)) {
        const slug = p.split('/')[2];
        const show = await env.DB.prepare('SELECT * FROM shows WHERE slug = ? AND status = ?').bind(slug, 'active').first();
        if (!show) return json({ error: 'Not found' }, 404);
        const episodes = await env.DB.prepare("SELECT id, title, slug, description, audio_url, duration_sec, season, episode_number, episode_type, image_url, published_at, total_downloads FROM episodes WHERE show_id = ? AND status = 'published' AND published_at <= datetime('now') ORDER BY published_at DESC LIMIT 50").bind(show.id).all();
        return json({ success: true, data: { show, episodes: episodes.results, feed_url: `https://echo-podcast.bmcii1976.workers.dev/feed/${slug}` } });
      }

      /* ── Public episode page (JSON) ── */
      if (m === 'GET' && p.match(/^\/show\/[a-z0-9-]+\/[a-z0-9-]+$/)) {
        const parts = p.split('/');
        const showSlug = parts[2];
        const epSlug = parts[3];
        const show = await env.DB.prepare('SELECT * FROM shows WHERE slug = ?').bind(showSlug).first();
        if (!show) return json({ error: 'Show not found' }, 404);
        const episode = await env.DB.prepare("SELECT * FROM episodes WHERE show_id = ? AND slug = ? AND status = 'published'").bind(show.id, epSlug).first();
        if (!episode) return json({ error: 'Episode not found' }, 404);
        return json({ success: true, data: { show, episode } });
      }

      /* ── Download/stream audio (with tracking) ── */
      if (m === 'GET' && p.startsWith('/audio/')) {
        const epId = parseInt(p.split('/')[2]);
        if (!epId) return json({ error: 'Invalid episode' }, 400);
        if (await rateLimit(env.PC_CACHE, `dl:${req.headers.get('CF-Connecting-IP') || 'u'}`, 30, 60)) return json({ error: 'Rate limited' }, 429);

        const episode = await env.DB.prepare('SELECT * FROM episodes WHERE id = ?').bind(epId).first();
        if (!episode) return json({ error: 'Not found' }, 404);

        // Record download async
        const ua = req.headers.get('User-Agent') || '';
        (async () => {
          await env.DB.prepare('INSERT INTO downloads (episode_id, show_id, ip_hash, user_agent, country, city, device, app) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(epId, episode.show_id, (req.headers.get('CF-Connecting-IP') || '').slice(0, 8), sanitize(ua, 200), req.headers.get('CF-IPCountry') || '', req.headers.get('CF-IPCity') || '', /mobile/i.test(ua) ? 'mobile' : 'desktop', detectApp(ua)).run();
          await env.DB.prepare('UPDATE episodes SET total_downloads = total_downloads + 1 WHERE id = ?').bind(epId).run();
          await env.DB.prepare('UPDATE shows SET total_downloads = total_downloads + 1 WHERE id = ?').bind(episode.show_id).run();
        })();

        // If audio_key exists, serve from R2
        if (episode.audio_key) {
          const obj = await env.AUDIO.get(episode.audio_key as string);
          if (obj) {
            return new Response(obj.body, {
              headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': String(obj.size),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=86400',
              }
            });
          }
        }

        // Redirect to external audio URL
        if (episode.audio_url) {
          return Response.redirect(episode.audio_url as string, 302);
        }

        return json({ error: 'Audio not available' }, 404);
      }

      /* ── Subscribe (public) ── */
      if (m === 'POST' && p === '/subscribe') {
        if (await rateLimit(env.PC_CACHE, `sub:${req.headers.get('CF-Connecting-IP') || 'u'}`, 5, 60)) return json({ error: 'Rate limited' }, 429);
        const b = await req.json() as Record<string, unknown>;
        const showId = b.show_id as number;
        const email = sanitize(b.email as string, 200);
        if (!showId || !email) return json({ error: 'show_id and email required' }, 400);
        try {
          await env.DB.prepare('INSERT INTO subscribers (show_id, email, name, source) VALUES (?, ?, ?, ?)').bind(showId, email, sanitize(b.name as string, 100), sanitize(b.source as string, 30) || 'website').run();
          await env.DB.prepare('UPDATE shows SET total_subscribers = total_subscribers + 1 WHERE id = ?').bind(showId).run();
        } catch { /* duplicate */ }
        return json({ success: true }, 201);
      }

      /* ── Embeddable player ── */
      if (m === 'GET' && p.startsWith('/player/')) {
        const code = p.split('/')[2];
        const player = await env.DB.prepare('SELECT * FROM embed_players WHERE short_code = ?').bind(code).first();
        if (!player) return new Response('Player not found', { status: 404 });
        const style = JSON.parse(player.style as string || '{}');
        const color = style.color || '#0d7377';
        const bg = style.bg || '#ffffff';

        let episode: Record<string, unknown> | null = null;
        let show: Record<string, unknown> | null = null;
        if (player.episode_id) {
          episode = await env.DB.prepare('SELECT * FROM episodes WHERE id = ?').bind(player.episode_id).first();
          if (episode) show = await env.DB.prepare('SELECT title, image_url FROM shows WHERE id = ?').bind(episode.show_id).first();
        }

        // Track play
        await env.DB.prepare('UPDATE embed_players SET total_plays = total_plays + 1 WHERE id = ?').bind(player.id).run();

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:${bg}}
.player{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:${bg};border:1px solid #e2e8f0}
.art{width:60px;height:60px;border-radius:8px;object-fit:cover;flex-shrink:0}
.info{flex:1;min-width:0}.title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.show{font-size:12px;color:#64748b}.controls{display:flex;align-items:center;gap:8px}
audio{width:100%;height:32px;margin-top:4px}
.play-btn{width:36px;height:36px;border-radius:50%;background:${color};border:none;cursor:pointer;display:flex;align-items:center;justify-content:center}
.play-btn svg{fill:#fff;width:16px;height:16px}
</style></head><body>
<div class="player">
${episode?.image_url || show?.image_url ? `<img class="art" src="${episode?.image_url || show?.image_url}" alt="">` : ''}
<div class="info"><div class="title">${episode?.title || 'Episode'}</div><div class="show">${show?.title || ''} ${episode?.duration_sec ? '· ' + formatDuration(episode.duration_sec as number) : ''}</div>
<audio controls preload="none" src="https://echo-podcast.bmcii1976.workers.dev/audio/${episode?.id}"></audio>
</div></div></body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      /* ══════════════════ AUTH REQUIRED ══════════════════ */
      if (!authOk(req, env)) return json({ error: 'Unauthorized' }, 401);

      /* ── Shows CRUD ── */
      if (m === 'GET' && p === '/shows') {
        const rows = await env.DB.prepare('SELECT * FROM shows ORDER BY created_at DESC').all();
        return json({ success: true, data: rows.results });
      }

      if (m === 'POST' && p === '/shows') {
        const b = await req.json() as Record<string, unknown>;
        const title = sanitize(b.title as string, 200);
        if (!title) return json({ error: 'title required' }, 400);
        const s = slugify(title);
        const r = await env.DB.prepare('INSERT INTO shows (tenant_id, title, slug, description, author, owner_name, owner_email, language, category, subcategory, explicit, website, image_url, cover_url, brand_color, social, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(b.tenant_id || 'default', title, s, sanitize(b.description as string, 2000), sanitize(b.author as string, 100), sanitize(b.owner_name as string, 100), sanitize(b.owner_email as string, 200), sanitize(b.language as string, 5) || 'en', sanitize(b.category as string, 50), sanitize(b.subcategory as string, 50), b.explicit ? 1 : 0, sanitize(b.website as string, 500), sanitize(b.image_url as string, 500), sanitize(b.cover_url as string, 500), sanitize(b.brand_color as string, 10) || '#0d7377', JSON.stringify(b.social || {}), JSON.stringify(b.tags || [])).run();
        return json({ success: true, id: r.meta.last_row_id, slug: s, feed_url: `https://echo-podcast.bmcii1976.workers.dev/feed/${s}` }, 201);
      }

      if (m === 'PATCH' && p.match(/^\/shows\/\d+$/)) {
        const id = parseInt(p.split('/')[2]);
        const b = await req.json() as Record<string, unknown>;
        const sets: string[] = []; const vals: unknown[] = [];
        const fields = ['title', 'description', 'author', 'owner_name', 'owner_email', 'language', 'category', 'subcategory', 'website', 'image_url', 'cover_url', 'brand_color', 'itunes_id', 'spotify_url', 'google_url', 'status'];
        fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(sanitize(b[f] as string, f === 'description' ? 2000 : 500)); } });
        if (b.explicit !== undefined) { sets.push('explicit = ?'); vals.push(b.explicit ? 1 : 0); }
        if (b.social !== undefined) { sets.push('social = ?'); vals.push(JSON.stringify(b.social)); }
        if (b.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(b.tags)); }
        if (sets.length === 0) return json({ error: 'Nothing to update' }, 400);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        await env.DB.prepare(`UPDATE shows SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        await env.PC_CACHE.delete(`feed:${id}`); // Invalidate feed cache
        return json({ success: true });
      }

      /* ── Episodes CRUD ── */
      if (m === 'GET' && p.match(/^\/shows\/\d+\/episodes$/)) {
        const showId = parseInt(p.split('/')[2]);
        const status = url.searchParams.get('status');
        let q = 'SELECT * FROM episodes WHERE show_id = ?';
        const binds: unknown[] = [showId];
        if (status) { q += ' AND status = ?'; binds.push(status); }
        q += ' ORDER BY COALESCE(published_at, created_at) DESC';
        const rows = await env.DB.prepare(q).bind(...binds).all();
        return json({ success: true, data: rows.results });
      }

      if (m === 'POST' && p.match(/^\/shows\/\d+\/episodes$/)) {
        const showId = parseInt(p.split('/')[2]);
        const b = await req.json() as Record<string, unknown>;
        const title = sanitize(b.title as string, 200);
        if (!title) return json({ error: 'title required' }, 400);
        const s = slugify(title);
        const r = await env.DB.prepare('INSERT INTO episodes (show_id, title, slug, description, content, audio_url, audio_key, duration_sec, file_size, season, episode_number, episode_type, explicit, image_url, transcript, show_notes, chapters, tags, guests, links, status, published_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(showId, title, s, sanitize(b.description as string, 2000), sanitize(b.content as string, 10000), sanitize(b.audio_url as string, 500), sanitize(b.audio_key as string, 200), b.duration_sec || 0, b.file_size || 0, b.season || null, b.episode_number || null, sanitize(b.episode_type as string, 20) || 'full', b.explicit ? 1 : 0, sanitize(b.image_url as string, 500), sanitize(b.transcript as string, 500), sanitize(b.show_notes as string, 10000), JSON.stringify(b.chapters || []), JSON.stringify(b.tags || []), JSON.stringify(b.guests || []), JSON.stringify(b.links || []), sanitize(b.status as string, 20) || 'draft', b.published_at || null, b.scheduled_at || null).run();
        if (b.status === 'published') {
          await env.DB.prepare('UPDATE shows SET total_episodes = total_episodes + 1, updated_at = datetime(\'now\') WHERE id = ?').bind(showId).run();
          // Invalidate feed cache
          const show = await env.DB.prepare('SELECT slug FROM shows WHERE id = ?').bind(showId).first();
          if (show) await env.PC_CACHE.delete(`feed:${show.slug}`);
        }
        return json({ success: true, id: r.meta.last_row_id, slug: s }, 201);
      }

      if (m === 'PATCH' && p.match(/^\/episodes\/\d+$/)) {
        const id = parseInt(p.split('/')[2]);
        const b = await req.json() as Record<string, unknown>;
        const sets: string[] = []; const vals: unknown[] = [];
        const fields = ['title', 'description', 'content', 'audio_url', 'audio_key', 'image_url', 'transcript', 'show_notes', 'episode_type', 'status'];
        fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(sanitize(b[f] as string, f === 'content' || f === 'show_notes' ? 10000 : f === 'description' ? 2000 : 500)); } });
        const nums = ['duration_sec', 'file_size', 'season', 'episode_number', 'explicit'];
        nums.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); } });
        if (b.published_at !== undefined) { sets.push('published_at = ?'); vals.push(b.published_at); }
        if (b.scheduled_at !== undefined) { sets.push('scheduled_at = ?'); vals.push(b.scheduled_at); }
        if (b.chapters !== undefined) { sets.push('chapters = ?'); vals.push(JSON.stringify(b.chapters)); }
        if (b.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(b.tags)); }
        if (b.guests !== undefined) { sets.push('guests = ?'); vals.push(JSON.stringify(b.guests)); }
        if (b.links !== undefined) { sets.push('links = ?'); vals.push(JSON.stringify(b.links)); }
        if (sets.length === 0) return json({ error: 'Nothing to update' }, 400);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        // Check if publishing
        const ep = await env.DB.prepare('SELECT show_id, status FROM episodes WHERE id = ?').bind(id).first();
        await env.DB.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        if (ep && b.status === 'published' && ep.status !== 'published') {
          await env.DB.prepare('UPDATE shows SET total_episodes = total_episodes + 1, updated_at = datetime(\'now\') WHERE id = ?').bind(ep.show_id).run();
        }
        // Invalidate feed
        if (ep) {
          const show = await env.DB.prepare('SELECT slug FROM shows WHERE id = ?').bind(ep.show_id).first();
          if (show) await env.PC_CACHE.delete(`feed:${show.slug}`);
        }
        return json({ success: true });
      }

      if (m === 'DELETE' && p.match(/^\/episodes\/\d+$/)) {
        const id = parseInt(p.split('/')[2]);
        const ep = await env.DB.prepare('SELECT show_id, status, audio_key FROM episodes WHERE id = ?').bind(id).first();
        if (ep) {
          await env.DB.prepare('DELETE FROM episodes WHERE id = ?').bind(id).run();
          if (ep.status === 'published') {
            await env.DB.prepare('UPDATE shows SET total_episodes = MAX(0, total_episodes - 1) WHERE id = ?').bind(ep.show_id).run();
          }
          if (ep.audio_key) {
            await env.AUDIO.delete(ep.audio_key as string);
          }
        }
        return json({ success: true });
      }

      /* ── Audio upload ── */
      if (m === 'POST' && p.match(/^\/episodes\/\d+\/upload$/)) {
        const epId = parseInt(p.split('/')[2]);
        const episode = await env.DB.prepare('SELECT show_id FROM episodes WHERE id = ?').bind(epId).first();
        if (!episode) return json({ error: 'Episode not found' }, 404);
        const body = await req.arrayBuffer();
        if (body.byteLength > 200 * 1024 * 1024) return json({ error: 'Max 200MB' }, 413);
        const key = `podcast/${episode.show_id}/${epId}-${Date.now()}.mp3`;
        await env.AUDIO.put(key, body, { httpMetadata: { contentType: 'audio/mpeg' } });
        await env.DB.prepare("UPDATE episodes SET audio_key = ?, file_size = ?, updated_at = datetime('now') WHERE id = ?").bind(key, body.byteLength, epId).run();
        return json({ success: true, audio_key: key, audio_url: `https://echo-podcast.bmcii1976.workers.dev/audio/${epId}`, file_size: body.byteLength });
      }

      /* ── Subscribers ── */
      if (m === 'GET' && p.match(/^\/shows\/\d+\/subscribers$/)) {
        const showId = parseInt(p.split('/')[2]);
        const rows = await env.DB.prepare('SELECT * FROM subscribers WHERE show_id = ? ORDER BY created_at DESC').bind(showId).all();
        return json({ success: true, data: rows.results });
      }

      /* ── Playlists ── */
      if (m === 'GET' && p.match(/^\/shows\/\d+\/playlists$/)) {
        const showId = parseInt(p.split('/')[2]);
        const rows = await env.DB.prepare('SELECT * FROM playlists WHERE show_id = ? ORDER BY created_at DESC').bind(showId).all();
        return json({ success: true, data: rows.results });
      }

      if (m === 'POST' && p.match(/^\/shows\/\d+\/playlists$/)) {
        const showId = parseInt(p.split('/')[2]);
        const b = await req.json() as Record<string, unknown>;
        const name = sanitize(b.name as string, 100);
        if (!name) return json({ error: 'name required' }, 400);
        const r = await env.DB.prepare('INSERT INTO playlists (show_id, name, slug, description, episode_ids) VALUES (?, ?, ?, ?, ?)').bind(showId, name, slugify(name), sanitize(b.description as string, 500), JSON.stringify(b.episode_ids || [])).run();
        return json({ success: true, id: r.meta.last_row_id }, 201);
      }

      /* ── Embed players ── */
      if (m === 'POST' && p === '/embed') {
        const b = await req.json() as Record<string, unknown>;
        const showId = b.show_id as number;
        if (!showId) return json({ error: 'show_id required' }, 400);
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        const r = await env.DB.prepare('INSERT INTO embed_players (show_id, episode_id, type, style, short_code) VALUES (?, ?, ?, ?, ?)').bind(showId, b.episode_id || null, sanitize(b.type as string, 20) || 'single', JSON.stringify(b.style || {}), code).run();
        return json({ success: true, id: r.meta.last_row_id, short_code: code, embed_url: `https://echo-podcast.bmcii1976.workers.dev/player/${code}`, embed_code: `<iframe src="https://echo-podcast.bmcii1976.workers.dev/player/${code}" width="100%" height="80" frameborder="0"></iframe>` }, 201);
      }

      /* ── Analytics ── */
      if (m === 'GET' && p.match(/^\/shows\/\d+\/analytics$/)) {
        const showId = parseInt(p.split('/')[2]);
        const cached = await env.PC_CACHE.get(`analytics:${showId}`, 'json');
        if (cached) return json({ success: true, data: cached, cached: true });
        const show = await env.DB.prepare('SELECT total_episodes, total_downloads, total_subscribers FROM shows WHERE id = ?').bind(showId).first();
        const dlToday = await env.DB.prepare('SELECT COUNT(*) as c FROM downloads WHERE show_id = ? AND DATE(created_at) = DATE(\'now\')').bind(showId).first();
        const topEps = await env.DB.prepare('SELECT title, total_downloads FROM episodes WHERE show_id = ? ORDER BY total_downloads DESC LIMIT 10').bind(showId).all();
        const byApp = await env.DB.prepare('SELECT app, COUNT(*) as c FROM downloads WHERE show_id = ? GROUP BY app ORDER BY c DESC LIMIT 10').bind(showId).all();
        const byCountry = await env.DB.prepare("SELECT country, COUNT(*) as c FROM downloads WHERE show_id = ? AND country != '' GROUP BY country ORDER BY c DESC LIMIT 10").bind(showId).all();
        const data = {
          total_episodes: show?.total_episodes || 0,
          total_downloads: show?.total_downloads || 0,
          total_subscribers: show?.total_subscribers || 0,
          downloads_today: dlToday?.c || 0,
          top_episodes: topEps.results,
          by_app: byApp.results,
          by_country: byCountry.results,
        };
        await env.PC_CACHE.put(`analytics:${showId}`, JSON.stringify(data), { expirationTtl: 300 });
        return json({ success: true, data });
      }

      if (m === 'GET' && p.match(/^\/shows\/\d+\/analytics\/trends$/)) {
        const showId = parseInt(p.split('/')[2]);
        const days = Math.min(parseInt(url.searchParams.get('days') || '30'), 90);
        const rows = await env.DB.prepare('SELECT * FROM analytics_daily WHERE show_id = ? ORDER BY date DESC LIMIT ?').bind(showId, days).all();
        return json({ success: true, data: rows.results });
      }

      /* ── AI endpoints ── */
      if (m === 'POST' && p === '/ai/show-notes') {
        const b = await req.json() as Record<string, unknown>;
        const title = sanitize(b.title as string, 200);
        const description = sanitize(b.description as string, 2000);
        const prompt = `Generate professional podcast show notes for an episode titled "${title}". Description: ${description}. Include: summary (2-3 sentences), key topics discussed (bullet points), timestamps/chapters, key takeaways, and links/resources mentioned. Format in Markdown.`;
        try {
          const aiRes = await env.ENGINE_RUNTIME.fetch(new Request('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 800 }) }));
          const aiData = await aiRes.json() as Record<string, unknown>;
          return json({ success: true, show_notes: aiData });
        } catch { return json({ success: true, show_notes: { error: 'Engine unavailable' } }); }
      }

      if (m === 'POST' && p === '/ai/episode-ideas') {
        const b = await req.json() as Record<string, unknown>;
        const showTitle = sanitize(b.show_title as string, 200);
        const category = sanitize(b.category as string, 50);
        const prompt = `Generate 10 podcast episode ideas for a show called "${showTitle}" in the ${category || 'general'} category. For each idea include: title, 1-sentence description, potential guest type, and estimated length (short/medium/long). Format as numbered list.`;
        try {
          const aiRes = await env.ENGINE_RUNTIME.fetch(new Request('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 600 }) }));
          const aiData = await aiRes.json() as Record<string, unknown>;
          return json({ success: true, ideas: aiData });
        } catch { return json({ success: true, ideas: { error: 'Engine unavailable' } }); }
      }

      /* ── Export ── */
      if (m === 'GET' && p.match(/^\/shows\/\d+\/export$/)) {
        const showId = parseInt(p.split('/')[2]);
        const episodes = await env.DB.prepare('SELECT * FROM episodes WHERE show_id = ? ORDER BY COALESCE(published_at, created_at) DESC').bind(showId).all();
        return json({ success: true, data: episodes.results, total: episodes.results.length });
      }

      /* ── Activity log ── */
      if (m === 'GET' && p === '/activity') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        const rows = await env.DB.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').bind(limit).all();
        return json({ success: true, data: rows.results });
      }

      return json({ error: 'Not found', path: p, endpoints: ['/health', '/feed/:slug', '/show/:slug', '/audio/:id', '/shows', '/episodes', '/embed', '/analytics', '/ai'] }, 404);

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Internal error';
      if (msg.includes('JSON')) {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      console.error(`[echo-podcast] Unhandled error: ${msg}`);
      return json({ error: 'Internal server error' }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    // Publish scheduled episodes
    await env.DB.prepare("UPDATE episodes SET status = 'published' WHERE status = 'scheduled' AND scheduled_at <= datetime('now')").run();

    // Daily analytics
    const shows = await env.DB.prepare('SELECT id, slug FROM shows WHERE status = ?').bind('active').all();
    for (const show of shows.results) {
      const sid = show.id as number;
      const dls = await env.DB.prepare('SELECT COUNT(*) as c, COUNT(DISTINCT ip_hash) as u FROM downloads WHERE show_id = ? AND DATE(created_at) = ?').bind(sid, today).first();
      const newSubs = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE show_id = ? AND DATE(created_at) = ?').bind(sid, today).first();
      const topEp = await env.DB.prepare('SELECT id FROM episodes WHERE show_id = ? ORDER BY total_downloads DESC LIMIT 1').bind(sid).first();
      const topCountry = await env.DB.prepare("SELECT country, COUNT(*) as c FROM downloads WHERE show_id = ? AND DATE(created_at) = ? AND country != '' GROUP BY country ORDER BY c DESC LIMIT 1").bind(sid, today).first();
      const topApp = await env.DB.prepare("SELECT app, COUNT(*) as c FROM downloads WHERE show_id = ? AND DATE(created_at) = ? GROUP BY app ORDER BY c DESC LIMIT 1").bind(sid, today).first();

      await env.DB.prepare(`INSERT INTO analytics_daily (show_id, date, downloads, unique_listeners, new_subscribers, top_episode_id, top_country, top_app) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(show_id, date) DO UPDATE SET downloads=excluded.downloads, unique_listeners=excluded.unique_listeners, new_subscribers=excluded.new_subscribers, top_episode_id=excluded.top_episode_id, top_country=excluded.top_country, top_app=excluded.top_app`).bind(sid, today, dls?.c || 0, dls?.u || 0, newSubs?.c || 0, topEp?.id || null, topCountry?.country || null, topApp?.app || null).run();

      // Invalidate feed cache
      await env.PC_CACHE.delete(`feed:${show.slug}`);
    }
  }
};
