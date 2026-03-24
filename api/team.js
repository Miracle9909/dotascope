// Vercel Serverless Function: /api/team
// Proxies OpenDota team match history with server-side caching

const teamCache = new Map();
const CACHE_TTL = 300000; // 5 min cache per team

async function fetchWithTimeout(url, ms = 8000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'DotaPlay/3.5' }
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

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing team id' });

    const cached = teamCache.get(id);
    const now = Date.now();

    if (cached && (now - cached.timestamp < CACHE_TTL)) {
        return res.status(200).json({ source: 'cached', matches: cached.data });
    }

    try {
        const response = await fetchWithTimeout(`https://api.opendota.com/api/teams/${id}/matches?limit=10`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        teamCache.set(id, { data, timestamp: now });

        // Cleanup old cache entries
        if (teamCache.size > 100) {
            const oldest = [...teamCache.entries()]
                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                .slice(0, 30);
            oldest.forEach(([key]) => teamCache.delete(key));
        }

        return res.status(200).json({ source: 'OpenDota', matches: data });
    } catch (e) {
        if (cached) return res.status(200).json({ source: 'stale', matches: cached.data });
        return res.status(503).json({ error: 'Team data unavailable', matches: [] });
    }
}
