// Vercel Serverless Function: /api/player
// Proxies OpenDota player data with server-side caching

const playerCache = new Map();
const CACHE_TTL = 300000; // 5 min cache for player data

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

    const { id, type } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing player id' });

    const cacheKey = `${id}_${type || 'profile'}`;
    const cached = playerCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp < CACHE_TTL)) {
        return res.status(200).json(cached.data);
    }

    let url;
    switch (type) {
        case 'heroes':
            url = `https://api.opendota.com/api/players/${id}/heroes?limit=30&date=180`;
            break;
        case 'recent':
            url = `https://api.opendota.com/api/players/${id}/recentMatches?limit=10`;
            break;
        default:
            url = `https://api.opendota.com/api/players/${id}`;
    }

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        playerCache.set(cacheKey, { data, timestamp: now });

        // Cleanup old cache entries (keep < 200)
        if (playerCache.size > 200) {
            const oldest = [...playerCache.entries()]
                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                .slice(0, 50);
            oldest.forEach(([key]) => playerCache.delete(key));
        }

        return res.status(200).json(data);
    } catch (e) {
        if (cached) return res.status(200).json(cached.data);
        return res.status(503).json({ error: 'Player data unavailable' });
    }
}
