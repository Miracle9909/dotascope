// Vercel Serverless Function: /api/live
// Proxies OpenDota live matches with server-side caching
// Eliminates client-side CORS and rate-limit issues

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 12000; // 12s cache (refresh every 12s max)

const SOURCES = [
    { name: 'OpenDota', url: 'https://api.opendota.com/api/live' },
    { name: 'OpenDota-Alt', url: 'https://api.opendota.com/api/live' },
];

async function fetchWithTimeout(url, ms = 8000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'DotaPlay/3.0' }
        });
        clearTimeout(timeout);
        return res;
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

    // Return cached data if fresh
    const now = Date.now();
    if (cache.data && (now - cache.timestamp < CACHE_TTL)) {
        return res.status(200).json({
            source: cache.source + ' (cached)',
            cached: true,
            age: Math.round((now - cache.timestamp) / 1000),
            ttl: Math.round((CACHE_TTL - (now - cache.timestamp)) / 1000),
            matches: cache.data
        });
    }

    // Try each source sequentially
    for (const source of SOURCES) {
        try {
            const response = await fetchWithTimeout(source.url);

            if (response.status === 429) {
                console.warn(`${source.name}: Rate limited (429), trying next...`);
                continue;
            }

            if (!response.ok) {
                console.warn(`${source.name}: HTTP ${response.status}, trying next...`);
                continue;
            }

            const data = await response.json();

            // Filter to pro/league matches only
            const filtered = data
                .filter(m => m.team_name_radiant || m.team_name_dire || m.league_id)
                .sort((a, b) => (b.spectators || 0) - (a.spectators || 0));

            // Update cache
            cache = { data: filtered, timestamp: now, source: source.name };

            return res.status(200).json({
                source: source.name,
                cached: false,
                count: filtered.length,
                matches: filtered
            });
        } catch (e) {
            console.error(`${source.name}: ${e.message}`);
            continue;
        }
    }

    // All sources failed — return stale cache if available
    if (cache.data) {
        return res.status(200).json({
            source: 'stale-cache',
            cached: true,
            age: Math.round((now - cache.timestamp) / 1000),
            matches: cache.data
        });
    }

    return res.status(503).json({ error: 'All data sources unavailable', matches: [] });
}
