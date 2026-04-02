// Vercel Serverless Function: /api/lol-live
// Fetches live LoL esports matches + real-time stats from Lolesports API

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 8000; // 8s cache (LoL updates slower than Dota)
const LOL_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LOL_HEADERS = { 'x-api-key': LOL_API_KEY, 'Accept': 'application/json' };

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { signal: controller.signal, ...opts });
        clearTimeout(timeout);
        return res;
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

async function fetchLiveStats(gameId) {
    try {
        const res = await fetchWithTimeout(
            `https://feed.lolesports.com/livestats/v1/window/${gameId}`,
            { headers: LOL_HEADERS },
            5000
        );
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=8, stale-while-revalidate=10');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const now = Date.now();
    if (cache.data && (now - cache.timestamp < CACHE_TTL)) {
        return res.status(200).json({
            source: 'Lolesports (cached)',
            cached: true,
            age: Math.round((now - cache.timestamp) / 1000),
            matches: cache.data
        });
    }

    try {
        // Step 1: Get live events
        const liveRes = await fetchWithTimeout(
            'https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US',
            { headers: LOL_HEADERS }
        );
        if (!liveRes.ok) throw new Error(`Lolesports API: HTTP ${liveRes.status}`);
        const liveData = await liveRes.json();

        const events = liveData?.data?.schedule?.events || [];
        const liveEvents = events.filter(e => e.state === 'inProgress');

        // Step 2: Enrich each live event with real-time stats
        const enriched = await Promise.all(liveEvents.map(async (event) => {
            const match = event.match;
            if (!match?.games) return null;

            const currentGame = match.games.find(g => g.state === 'inProgress');
            let stats = null;
            if (currentGame) {
                stats = await fetchLiveStats(currentGame.id);
            }

            // Extract latest frame
            const frame = stats?.frames?.[stats.frames.length - 1] || null;
            const meta = stats?.gameMetadata || null;

            return {
                event_id: event.id,
                start_time: event.startTime,
                block_name: event.blockName,
                league: {
                    name: event.league?.name || 'Unknown',
                    slug: event.league?.slug || '',
                    image: event.league?.image || ''
                },
                stream: event.streams?.[0] || null,
                match: {
                    id: match.id,
                    teams: (match.teams || []).map(t => ({
                        name: t.name,
                        code: t.code,
                        image: t.image,
                        wins: t.result?.gameWins || 0
                    })),
                    strategy: match.strategy,
                    games: (match.games || []).map(g => ({
                        id: g.id,
                        number: g.number,
                        state: g.state
                    }))
                },
                current_game: currentGame ? {
                    id: currentGame.id,
                    number: currentGame.number,
                    state: currentGame.state
                } : null,
                live: frame ? {
                    blue: {
                        totalGold: frame.blueTeam?.totalGold || 0,
                        totalKills: frame.blueTeam?.totalKills || 0,
                        towers: frame.blueTeam?.towers || 0,
                        inhibitors: frame.blueTeam?.inhibitors || 0,
                        barons: frame.blueTeam?.barons || 0,
                        dragons: frame.blueTeam?.dragons || [],
                        players: (frame.blueTeam?.participants || []).map((p, i) => ({
                            participantId: p.participantId,
                            champion: meta?.blueTeamMetadata?.participantMetadata?.[i]?.championId || '',
                            summonerName: meta?.blueTeamMetadata?.participantMetadata?.[i]?.summonerName || '',
                            role: meta?.blueTeamMetadata?.participantMetadata?.[i]?.role || '',
                            kills: p.kills || 0,
                            deaths: p.deaths || 0,
                            assists: p.assists || 0,
                            creepScore: p.creepScore || 0,
                            totalGold: p.totalGold || 0,
                            level: p.level || 1,
                            currentHealth: p.currentHealth || 0,
                            maxHealth: p.maxHealth || 1
                        }))
                    },
                    red: {
                        totalGold: frame.redTeam?.totalGold || 0,
                        totalKills: frame.redTeam?.totalKills || 0,
                        towers: frame.redTeam?.towers || 0,
                        inhibitors: frame.redTeam?.inhibitors || 0,
                        barons: frame.redTeam?.barons || 0,
                        dragons: frame.redTeam?.dragons || [],
                        players: (frame.redTeam?.participants || []).map((p, i) => ({
                            participantId: p.participantId,
                            champion: meta?.redTeamMetadata?.participantMetadata?.[i]?.championId || '',
                            summonerName: meta?.redTeamMetadata?.participantMetadata?.[i]?.summonerName || '',
                            role: meta?.redTeamMetadata?.participantMetadata?.[i]?.role || '',
                            kills: p.kills || 0,
                            deaths: p.deaths || 0,
                            assists: p.assists || 0,
                            creepScore: p.creepScore || 0,
                            totalGold: p.totalGold || 0,
                            level: p.level || 1,
                            currentHealth: p.currentHealth || 0,
                            maxHealth: p.maxHealth || 1
                        }))
                    },
                    goldDiff: (frame.blueTeam?.totalGold || 0) - (frame.redTeam?.totalGold || 0)
                } : null,
                patch: meta?.patchVersion || null
            };
        }));

        const result = enriched.filter(Boolean);
        cache = { data: result, timestamp: Date.now() };

        return res.status(200).json({
            source: 'Lolesports',
            cached: false,
            count: result.length,
            matches: result
        });
    } catch (err) {
        console.error('LoL live error:', err.message);
        if (cache.data) {
            return res.status(200).json({
                source: 'stale-cache',
                cached: true,
                matches: cache.data
            });
        }
        return res.status(503).json({ error: err.message, matches: [] });
    }
}
