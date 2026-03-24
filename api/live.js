// Vercel Serverless Function: /api/live
// Multi-source racing: OpenDota + STRATZ (fastest wins)
// Reduced cache for real-time performance

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 3000; // 3s cache (was 12s)

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            ...opts,
            headers: { 'Accept': 'application/json', 'User-Agent': 'DotaPlay/3.5', ...(opts.headers || {}) }
        });
        clearTimeout(timeout);
        return res;
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

// OpenDota source
async function fetchOpenDota() {
    const res = await fetchWithTimeout('https://api.opendota.com/api/live');
    if (!res.ok) throw new Error(`OpenDota: HTTP ${res.status}`);
    const data = await res.json();
    const filtered = data
        .filter(m => m.team_name_radiant || m.team_name_dire || m.league_id)
        .sort((a, b) => (b.spectators || 0) - (a.spectators || 0));
    return { source: 'OpenDota', matches: filtered };
}

// STRATZ GraphQL source
async function fetchStratz() {
    const query = `{
        live {
            matches {
                matchId
                gameTime
                radiantScore
                direScore
                radiantTeam { teamId teamName }
                direTeam { teamId teamName }
                spectators
                averageRank
                leagueId
                league { displayName }
                radiantLead
                buildingState
                players {
                    heroId
                    isRadiant
                    numKills
                    numDeaths
                    numAssists
                    networth
                    goldPerMinute
                    experiencePerMinute
                    imp
                    steamAccount { name proSteamAccount { name } }
                }
            }
        }
    }`;

    const res = await fetchWithTimeout('https://api.stratz.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });

    if (!res.ok) throw new Error(`STRATZ: HTTP ${res.status}`);
    const json = await res.json();
    if (!json.data?.live?.matches) throw new Error('STRATZ: No live data');

    // Normalize STRATZ format to match OpenDota format
    const matches = json.data.live.matches
        .filter(m => m.radiantTeam || m.direTeam || m.leagueId)
        .map(m => ({
            match_id: m.matchId,
            game_time: m.gameTime,
            radiant_score: m.radiantScore,
            dire_score: m.direScore,
            team_name_radiant: m.radiantTeam?.teamName || '',
            team_name_dire: m.direTeam?.teamName || '',
            team_id_radiant: m.radiantTeam?.teamId,
            team_id_dire: m.direTeam?.teamId,
            spectators: m.spectators,
            average_mmr: m.averageRank,
            league_id: m.leagueId,
            league: m.league ? { name: m.league.displayName } : undefined,
            radiant_lead: m.radiantLead,
            building_state: m.buildingState,
            players: (m.players || []).map(p => ({
                hero_id: p.heroId,
                team: p.isRadiant ? 0 : 1,
                kills: p.numKills,
                deaths: p.numDeaths,
                assists: p.numAssists,
                net_worth: p.networth,
                gold_per_min: p.goldPerMinute,
                xp_per_min: p.experiencePerMinute,
                imp: p.imp,
                name: p.steamAccount?.proSteamAccount?.name || p.steamAccount?.name || ''
            })),
            // STRATZ-specific enriched data
            _stratz: true
        }))
        .sort((a, b) => (b.spectators || 0) - (a.spectators || 0));

    return { source: 'STRATZ', matches };
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=3, stale-while-revalidate=5');

    if (req.method === 'OPTIONS') return res.status(200).end();

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

    // Race both sources — fastest wins
    try {
        const result = await Promise.any([
            fetchOpenDota(),
            fetchStratz()
        ]);

        // Update cache
        cache = { data: result.matches, timestamp: Date.now(), source: result.source };

        return res.status(200).json({
            source: result.source,
            cached: false,
            count: result.matches.length,
            matches: result.matches
        });
    } catch (e) {
        console.error('All sources failed:', e.message);

        // Return stale cache if available
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
}
