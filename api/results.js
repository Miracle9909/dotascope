// Vercel Serverless Function: /api/results
// Proxies OpenDota pro match results with server-side caching

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60000; // 60s cache for results (less time-sensitive)

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
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    const now = Date.now();
    if (cache.data && (now - cache.timestamp < CACHE_TTL)) {
        return res.status(200).json({
            source: 'cached',
            matches: cache.data
        });
    }

    try {
        const response = await fetchWithTimeout('https://api.opendota.com/api/proMatches?limit=20');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        cache = { data, timestamp: now };

        return res.status(200).json({
            source: 'OpenDota',
            matches: data
        });
    } catch (e) {
        if (cache.data) {
            return res.status(200).json({
                source: 'stale-cache',
                matches: cache.data
            });
        }
        return res.status(503).json({ error: 'Data unavailable', matches: [] });
    }
}
