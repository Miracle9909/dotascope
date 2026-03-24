/* ============================================ */
/* DotaPlay v4.0 — Live Analytics + Pin + Series */
/* Multi-source API + Tower + Minimap + History  */
/* Build: 2026-03-24T22:15                       */
/* ============================================ */
console.log('🎮 DotaPlay v4.0 loaded | Proxy:', '/api', '| Host:', location.hostname);

// Multi-source API endpoints (race for fastest)
const SOURCES = [
    { name: 'OpenDota', live: 'https://api.opendota.com/api/live', api: 'https://api.opendota.com/api', priority: 1 },
    { name: 'STRATZ', live: 'https://api.stratz.com/graphql', api: 'https://api.stratz.com/graphql', priority: 2, type: 'graphql' },
];
const API = 'https://api.opendota.com/api';
const LIQUIPEDIA = 'https://liquipedia.net/dota2/';
const REFRESH_MS = 5000;
const MIN_REFRESH_MS = 3000;
const MAX_REFRESH_MS = 30000;

// Auto-detect proxy: always try /api first, falls back to direct if 404
const PROXY_API = '/api';

let currentRefresh = REFRESH_MS;
let consecutiveErrors = 0;
let lastFetchSource = '';
let currentView = 'live';
let liveMatches = [];
let playerCache = {};
let matchCache = null;
let matchCacheTime = 0;
let isFetching = false;

// Pin system (LocalStorage)
let pinnedMatchIds = new Set(JSON.parse(localStorage.getItem('dotaplay_pins') || '[]'));
function savePins() { localStorage.setItem('dotaplay_pins', JSON.stringify([...pinnedMatchIds])); }
function togglePin(matchId) {
    matchId = String(matchId);
    if (pinnedMatchIds.has(matchId)) pinnedMatchIds.delete(matchId);
    else pinnedMatchIds.add(matchId);
    savePins();
    renderLiveMatches();
}

// Finished match detection — use deactivate_time from API (reliable signal)
// building_state bitmask offsets vary between sources and are unreliable
function isMatchFinished(m) {
    // deactivate_time > 0 means the match server has been deactivated (game ended)
    if (m.deactivate_time && m.deactivate_time > 0) return true;
    return false;
}

// Bo-series grouping
function getSeriesKey(m) {
    const teams = [m.team_name_radiant || '', m.team_name_dire || ''].sort().join('|');
    return `${m.league_id || 0}_${teams}`;
}

let finishedMatchTimers = {}; // matchId -> timestamp when detected as finished

// ============================================
// TOWER BITMASK DECODER
// ============================================
// Dota 2 building_state bitmask:
// Bits 0-10:  Radiant buildings (towers + barracks + ancient)
// Bits 11-21: Dire buildings
// Each side has 11 buildings:
//   T1 top, T1 mid, T1 bot,  T2 top, T2 mid, T2 bot,
//   T3 top, T3 mid, T3 bot,  T4 top, T4 bot (ancient towers)
const TOWER_NAMES = ['T1⬆', 'T1⬛', 'T1⬇', 'T2⬆', 'T2⬛', 'T2⬇', 'T3⬆', 'T3⬛', 'T3⬇', 'T4⬆', 'T4⬇'];

function decodeTowers(buildingState) {
    if (buildingState === undefined || buildingState === null) {
        return { radiant: { alive: 11, destroyed: 0, towers: [] }, dire: { alive: 11, destroyed: 0, towers: [] } };
    }
    const radBits = buildingState & 0x7FF;           // bits 0-10
    const direBits = (buildingState >> 11) & 0x7FF;  // bits 11-21

    const parse = (bits) => {
        const towers = [];
        let alive = 0;
        for (let i = 0; i < 11; i++) {
            const isAlive = (bits >> i) & 1;
            towers.push({ name: TOWER_NAMES[i], alive: !!isAlive });
            if (isAlive) alive++;
        }
        return { alive, destroyed: 11 - alive, towers };
    };

    return { radiant: parse(radBits), dire: parse(direBits) };
}

function renderTowerStatus(buildingState) {
    const t = decodeTowers(buildingState);
    const renderSide = (side, color) => side.towers.map(tw =>
        `<span class="tower-icon ${tw.alive ? 'alive' : 'dead'}" title="${tw.name} ${tw.alive ? '✓' : '✕'}" style="color:${tw.alive ? color : 'var(--text-muted)'}">🏛</span>`
    ).join('');

    return `
    <div class="tower-row">
        <div class="tower-side">
            <span class="tower-label" style="color:var(--radiant)">☀️ ${t.radiant.alive}/11</span>
            <div class="tower-icons">${renderSide(t.radiant, 'var(--radiant)')}</div>
        </div>
        <div class="tower-diff">
            <span class="tower-diff-value" style="color:${t.radiant.destroyed < t.dire.destroyed ? 'var(--radiant)' : t.radiant.destroyed > t.dire.destroyed ? 'var(--dire)' : 'var(--text-muted)'}">
                🏛 ${Math.abs(t.radiant.destroyed - t.dire.destroyed)} diff
            </span>
        </div>
        <div class="tower-side">
            <span class="tower-label" style="color:var(--dire)">🌙 ${t.dire.alive}/11</span>
            <div class="tower-icons">${renderSide(t.dire, 'var(--dire)')}</div>
        </div>
    </div>`;
}

// Hero Minimap — positions hero portraits on stylized Dota 2 map
function renderMinimap(buildingState, players) {
    const t = decodeTowers(buildingState);
    const radPlayers = (players || []).filter(p => p.team === 0);
    const direPlayers = (players || []).filter(p => p.team === 1);

    // Position heroes on map by role (pos 1-5 convention in Dota 2)
    // Pos 1 (carry) → safe lane, Pos 2 (mid), Pos 3 (offlane), Pos 4 (roam), Pos 5 (support)
    // Radiant: safe=bot, off=top | Dire: safe=top, off=bot
    const radPositions = [
        { top: '75%', left: '70%' },  // pos1 carry (safe bot)
        { top: '48%', left: '48%' },  // pos2 mid
        { top: '25%', left: '22%' },  // pos3 offlane (top)
        { top: '60%', left: '35%' },  // pos4 roam
        { top: '82%', left: '55%' },  // pos5 support (safe bot)
    ];
    const direPositions = [
        { top: '20%', left: '30%' },  // pos1 carry (safe top)
        { top: '45%', left: '55%' },  // pos2 mid
        { top: '72%', left: '78%' },  // pos3 offlane (bot)
        { top: '35%', left: '65%' },  // pos4 roam
        { top: '15%', left: '45%' },  // pos5 support (safe top)
    ];

    const heroIcon = (p, pos, side) => {
        const hero = HERO_BY_ID[p.hero_id];
        if (!hero) return '';
        const img = getHeroImg(hero);
        const border = side === 'r' ? '#22c55e' : '#ef4444';
        const dead = (p.life_state === 1);
        return `<div class="mm-hero" style="top:${pos.top};left:${pos.left}" title="${hero.l} (${p.name || 'Player'})">
            <img src="${img}" style="border-color:${border};${dead ? 'opacity:0.3;filter:grayscale(1)' : ''}" alt="${hero.l}">
        </div>`;
    };

    const radHeroes = radPlayers.slice(0, 5).map((p, i) => heroIcon(p, radPositions[i], 'r')).join('');
    const direHeroes = direPlayers.slice(0, 5).map((p, i) => heroIcon(p, direPositions[i], 'd')).join('');

    // Tower dots (smaller, background layer)
    const dot = (tw, side) => {
        const color = tw.alive ? (side === 'r' ? '#22c55e80' : '#ef444480') : '#33333360';
        return `<div class="mm-tower-dot" style="background:${color}" title="${side === 'r' ? 'Rad' : 'Dire'} ${tw.name}"></div>`;
    };
    const radT = t.radiant.towers;
    const direT = t.dire.towers;

    return `
    <div class="minimap">
        <div class="mm-bg">
            <!-- Tower overlay (subtle) -->
            <div class="mm-tower-row mm-tower-top">${dot(radT[0], 'r')}${dot(radT[3], 'r')}${dot(direT[6], 'd')}${dot(direT[3], 'd')}${dot(direT[0], 'd')}</div>
            <div class="mm-tower-row mm-tower-mid">${dot(radT[1], 'r')}${dot(radT[4], 'r')}${dot(direT[4], 'd')}${dot(direT[1], 'd')}</div>
            <div class="mm-tower-row mm-tower-bot">${dot(radT[2], 'r')}${dot(radT[5], 'r')}${dot(direT[8], 'd')}${dot(direT[5], 'd')}${dot(direT[2], 'd')}</div>
            <!-- Bases -->
            <div class="mm-base-icon mm-rad-base-icon">☀️</div>
            <div class="mm-base-icon mm-dire-base-icon">🌙</div>
            <!-- River -->
            <div class="mm-river-line"></div>
            <!-- Hero portraits -->
            ${radHeroes}
            ${direHeroes}
        </div>
        <div class="mm-legend">
            <span><span class="mm-dot-sm" style="background:#22c55e"></span> Radiant ${t.radiant.alive}/11 towers</span>
            <span><span class="mm-dot-sm" style="background:#ef4444"></span> Dire ${t.dire.alive}/11 towers</span>
            <span style="font-size:10px;color:var(--text-muted)">⚠️ Hero positions are lane estimates</span>
        </div>
    </div>`;
}

// Styled gold advantage bar
function renderGoldBar(goldLead, radName, direName) {
    const abs = Math.abs(goldLead);
    const pct = Math.min(95, Math.max(5, 50 + (goldLead / 500)));
    const leadTeam = goldLead >= 0 ? radName : direName;
    const leadColor = goldLead > 0 ? 'var(--radiant)' : goldLead < 0 ? 'var(--dire)' : 'var(--text-muted)';
    const icon = goldLead > 0 ? '☀️' : goldLead < 0 ? '🌙' : '⚖️';
    return `
    <div class="gold-bar-container">
        <div class="gold-bar-header">
            <span style="color:var(--radiant);font-size:12px;font-weight:600">${esc(radName)}</span>
            <span style="color:${leadColor};font-weight:800;font-size:14px">${icon} ${goldLead > 0 ? '+' : ''}${fmtGold(goldLead)} gold</span>
            <span style="color:var(--dire);font-size:12px;font-weight:600">${esc(direName)}</span>
        </div>
        <div class="gold-bar">
            <div class="gold-fill-rad" style="width:${pct}%"></div>
        </div>
    </div>`;
}

// Team match history fetch
async function fetchTeamHistory(teamId) {
    if (!teamId) return [];
    try {
        const url = PROXY_API ? `${PROXY_API}/team?id=${teamId}` : `${API}/teams/${teamId}/matches?limit=10`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const json = await res.json();
        return Array.isArray(json) ? json : (json.matches || []);
    } catch { return []; }
}

function renderTeamHistory(matches, teamName, teamId) {
    if (!matches.length) return '<div style="color:var(--text-muted);font-size:12px;padding:8px">No recent matches found</div>';
    return matches.slice(0, 10).map(m => {
        const isRad = m.radiant;
        const won = isRad ? m.radiant_win : !m.radiant_win;
        const opponent = isRad ? (m.opposing_team_name || 'Unknown') : (m.opposing_team_name || 'Unknown');
        const dur = fmtTime(m.duration || 0);
        return `<div class="team-match-row">
            <span class="tmr-result ${won ? 'win' : 'loss'}">${won ? 'W' : 'L'}</span>
            <span class="tmr-vs">vs ${esc(opponent)}</span>
            <span class="tmr-dur">${dur}</span>
            <span class="tmr-side">${isRad ? '☀️' : '🌙'}</span>
        </div>`;
    }).join('');
}

function updateSourceBadge(src, interval) {
    const el = document.getElementById('sourceBadge');
    if (el) el.innerHTML = `<span style="font-size:10px;color:var(--accent)">⚡${src} · ${interval}s</span>`;
}

// ============================================
// PLAYER STATS FETCHER (OpenDota API)
// ============================================
async function fetchPlayerHeroes(accountId) {
    if (playerCache[accountId]) return playerCache[accountId];
    try {
        const url = PROXY_API
            ? `${PROXY_API}/player?id=${accountId}&type=heroes`
            : `${API}/players/${accountId}/heroes?limit=30&date=180`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const heroes = await res.json();
        const result = {};
        heroes.forEach(h => {
            if (h.games > 0) {
                result[h.hero_id] = { games: h.games, wins: h.win, wr: Math.round(h.win / h.games * 100) };
            }
        });
        playerCache[accountId] = result;
        return result;
    } catch { return null; }
}

async function fetchPlayerProfile(accountId) {
    try {
        const url = PROXY_API
            ? `${PROXY_API}/player?id=${accountId}&type=profile`
            : `${API}/players/${accountId}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchPlayerRecent(accountId) {
    try {
        const url = PROXY_API
            ? `${PROXY_API}/player?id=${accountId}&type=recent`
            : `${API}/players/${accountId}/recentMatches?limit=10`;
        const res = await fetch(url);
        if (!res.ok) return [];
        return await res.json();
    } catch { return []; }
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    fetchLiveMatches();
    startAutoRefresh();
});

// ============================================
// NAVIGATION
// ============================================
function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn =>
        btn.addEventListener('click', () => switchView(btn.dataset.view)));

    document.getElementById('matchModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal('matchModal');
    });
    document.getElementById('playerModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal('playerModal');
    });
}

function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-view="${view}"]`).classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`${view}View`).classList.add('active');
    if (view === 'results') fetchRecentResults();
}

function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ============================================
// MULTI-SOURCE LIVE MATCHES (Race + Fallback)
// ============================================
async function fetchWithTimeout(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return res;
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

async function fetchFromSource(source) {
    const res = await fetchWithTimeout(source.live);
    if (res.status === 429) throw new Error('RATE_LIMITED');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { data, source: source.name };
}

async function fetchLiveMatches() {
    if (isFetching) return;
    isFetching = true;
    try {
        updateStatus('fetching');
        let result = null;

        // Strategy 1: Use Vercel server-side proxy (no rate limits)
        if (PROXY_API) {
            try {
                const res = await fetchWithTimeout(`${PROXY_API}/live`);
                if (res.ok) {
                    const json = await res.json();
                    result = { data: json.matches || json, source: json.source || 'Proxy' };
                }
            } catch (e) {
                console.warn('Proxy failed, falling back to direct API:', e.message);
            }
        }

        // Strategy 2: Direct API calls (for localhost or proxy failure)
        if (!result) {
            for (const source of SOURCES) {
                try {
                    const r = await fetchFromSource(source);
                    result = r;
                    break;
                } catch (e) {
                    if (e.message === 'RATE_LIMITED') {
                        consecutiveErrors++;
                        currentRefresh = Math.min(MAX_REFRESH_MS, MIN_REFRESH_MS * Math.pow(1.5, consecutiveErrors));
                    }
                    continue;
                }
            }
        }

        // Strategy 3: Use cached data
        if (!result && matchCache && (Date.now() - matchCacheTime < 120000)) {
            liveMatches = matchCache;
            renderLiveMatches();
            updateStatus('cached');
            updateSourceBadge('Cached', Math.round(currentRefresh / 1000));
            return;
        }

        if (!result) throw new Error('All sources failed');

        // Success
        consecutiveErrors = 0;
        currentRefresh = REFRESH_MS;
        lastFetchSource = result.source;

        liveMatches = Array.isArray(result.data) ? result.data
            .filter(m => m.team_name_radiant || m.team_name_dire || m.league_id)
            .sort((a, b) => (b.spectators || 0) - (a.spectators || 0)) : [];

        // Cache successful result
        matchCache = liveMatches;
        matchCacheTime = Date.now();

        renderLiveMatches();
        updateStatus('online');
        updateSourceBadge(result.source, Math.round(currentRefresh / 1000));
    } catch (err) {
        console.error('Live fetch error:', err);
        updateStatus('error');
        const retryIn = Math.round(currentRefresh / 1000);
        document.getElementById('matchesGrid').innerHTML = `<div class="no-matches"><div class="no-matches-icon">📡</div><h3>Connection issue — retrying in ${retryIn}s...</h3><p style="font-size:12px;color:var(--text-muted)">API may be rate-limited. Auto-retry with backoff.</p></div>`;
    } finally {
        isFetching = false;
    }
}

function updateSourceBadge(source, nextRefresh) {
    const badge = document.getElementById('sourceBadge');
    if (badge) badge.innerHTML = `<span style="font-size:10px;color:var(--text-muted)">⚡${source} · ${nextRefresh}s</span>`;
}

function renderLiveMatches() {
    const grid = document.getElementById('matchesGrid');
    const count = document.getElementById('matchCount');

    // Remove loading spinner on first successful render
    const spinner = grid.querySelector('.loading-state');
    if (spinner) spinner.remove();

    // Filter: remove finished matches immediately from Live
    const now = Date.now();
    const activeMatches = liveMatches.filter(m => {
        return !isMatchFinished(m);
    });

    if (activeMatches.length === 0) {
        grid.innerHTML = `<div class="no-matches"><div class="no-matches-icon">🎮</div><h3>No live pro matches right now</h3><p>Check back soon or view recent results</p></div>`;
        count.textContent = '0 Live';
        return;
    }

    // Sort: pinned first, then by spectators
    activeMatches.sort((a, b) => {
        const aId = String(a.match_id || a.server_steam_id || '');
        const bId = String(b.match_id || b.server_steam_id || '');
        const aPinned = pinnedMatchIds.has(aId) ? 1 : 0;
        const bPinned = pinnedMatchIds.has(bId) ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        return (b.spectators || 0) - (a.spectators || 0);
    });

    // Bo-series grouping
    const seriesMap = {};
    activeMatches.forEach(m => {
        const key = getSeriesKey(m);
        if (!seriesMap[key]) seriesMap[key] = [];
        seriesMap[key].push(m);
    });

    const liveCount = activeMatches.filter(m => !isMatchFinished(m)).length;
    const finishedCount = activeMatches.length - liveCount;
    count.textContent = `${liveCount} Live${finishedCount ? ` · ${finishedCount} Finished` : ''}`;

    // Clear no-matches placeholder if present
    const placeholder = grid.querySelector('.no-matches');
    if (placeholder) placeholder.remove();

    // DOM Diffing
    const existingCards = grid.querySelectorAll('.match-card[data-match-id]');
    const existingMap = {};
    existingCards.forEach(c => { existingMap[c.dataset.matchId] = c; });
    const newIds = new Set(activeMatches.map(m => String(m.match_id || m.server_steam_id || '')));
    // Full DOM rebuild for guaranteed sort order (pinned first)
    grid.innerHTML = '';

    // Track series already rendered
    const renderedSeries = new Set();

    activeMatches.forEach((m, idx) => {
        const matchId = String(m.match_id || m.server_steam_id || idx);
        const radName = m.team_name_radiant || 'Radiant';
        const direName = m.team_name_dire || 'Dire';
        const radScore = m.radiant_score || 0;
        const direScore = m.dire_score || 0;
        const duration = fmtTime(m.game_time || 0);
        const league = m.league_name || 'Pro Match';
        const spec = m.spectators ? `👁 ${fmtNum(m.spectators)}` : '';
        const { radPicks, direPicks } = extractDraft(m.players || []);
        const goldLead = m.radiant_lead || 0;
        const goldColor = goldLead > 0 ? 'var(--radiant)' : goldLead < 0 ? 'var(--dire)' : 'var(--text-muted)';
        const goldIcon = goldLead > 0 ? '☀️' : goldLead < 0 ? '🌙' : '⚖️';
        const prediction = predictLive(m);
        const towers = decodeTowers(m.building_state);
        const predWinner = prediction.radiant > prediction.dire ? radName : direName;
        const conf = Math.max(prediction.radiant, prediction.dire);
        const confLabel = conf >= 70 ? '🔥 Strong' : conf >= 60 ? '📈 Likely' : '⚖️ Close';
        const isPinned = pinnedMatchIds.has(matchId);
        const finished = isMatchFinished(m);

        // Series info
        const seriesKey = getSeriesKey(m);
        const seriesMatches = seriesMap[seriesKey] || [m];
        const isSeriesMatch = seriesMatches.length > 1;
        let seriesHeader = '';
        if (isSeriesMatch && !renderedSeries.has(seriesKey)) {
            renderedSeries.add(seriesKey);
            const boType = seriesMatches.length >= 3 ? 'Bo5' : seriesMatches.length >= 2 ? 'Bo3' : 'Bo1';
            seriesHeader = `<div class="series-header">🏆 ${boType} — ${esc(radName)} vs ${esc(direName)} · Game ${seriesMatches.indexOf(m) + 1}</div>`;
        } else if (isSeriesMatch) {
            seriesHeader = `<div class="series-header" style="font-size:11px">Game ${seriesMatches.indexOf(m) + 1} of series</div>`;
        }

        // Status badge
        const statusBadge = finished
            ? `<div class="finished-badge">✅ FINISHED</div>`
            : `<div class="live-badge"><span class="pulse-sm"></span> LIVE ${spec}</div>`;

        const existingCard = existingMap[matchId];
        if (existingCard) {
            // In-place update
            const scoreEl = existingCard.querySelector('.score-radiant');
            if (scoreEl) scoreEl.textContent = radScore;
            const scoreDire = existingCard.querySelector('.score-dire');
            if (scoreDire) scoreDire.textContent = direScore;
            const timerEl = existingCard.querySelector('.match-timer');
            if (timerEl) timerEl.textContent = `⏱ ${duration}`;
            const goldEl = existingCard.querySelector('.card-gold-text');
            if (goldEl) goldEl.innerHTML = `${goldIcon} ${goldLead > 0 ? '+' : ''}${fmtGold(goldLead)}`;
            goldEl && (goldEl.style.color = goldColor);
            const towerEl = existingCard.querySelector('.card-tower-text');
            if (towerEl) towerEl.textContent = `⛫ ${towers.radiant.alive} vs ${towers.dire.alive}`;
            const predFill = existingCard.querySelector('.prediction-fill');
            if (predFill) predFill.style.width = `${prediction.radiant}%`;
            const predR = existingCard.querySelector('.prediction-label.r');
            if (predR) predR.textContent = `${prediction.radiant}%`;
            const predD = existingCard.querySelector('.prediction-label.d');
            if (predD) predD.textContent = `${prediction.dire}%`;
            const confEl = existingCard.querySelector('.card-conf');
            if (confEl) confEl.textContent = `${confLabel} — ${esc(predWinner)}`;
            // Update pin state
            existingCard.classList.toggle('pinned', isPinned);
            const pinBtn = existingCard.querySelector('.pin-btn');
            if (pinBtn) pinBtn.textContent = isPinned ? '📌' : '📍';
            // Update finished state
            const badgeEl = existingCard.querySelector('.live-badge, .finished-badge');
            if (badgeEl && finished) {
                badgeEl.className = 'finished-badge';
                badgeEl.innerHTML = '✅ FINISHED';
            }
            existingCard.onclick = () => showMatch(activeMatches.indexOf(m));
            return;
        }

        // New card
        const cardHtml = `
        <div class="match-card ${isPinned ? 'pinned' : ''} ${finished ? 'finished' : ''}" data-match-id="${matchId}">
            ${seriesHeader}
            <div class="match-league">
                <span>${esc(league)}</span>
                <div style="display:flex;align-items:center;gap:6px">
                    <button class="pin-btn" onclick="event.stopPropagation();togglePin('${matchId}')" title="${isPinned ? 'Unpin' : 'Pin to top'}">${isPinned ? '📌' : '📍'}</button>
                    ${statusBadge}
                </div>
            </div>
            <div class="match-timer">⏱ ${duration}</div>
            <div class="match-teams">
                <div class="match-team"><div class="match-team-name" style="color:var(--radiant)">${esc(radName)}</div></div>
                <div class="match-score">
                    <span class="score-radiant">${radScore}</span>
                    <span class="score-separator">—</span>
                    <span class="score-dire">${direScore}</span>
                </div>
                <div class="match-team"><div class="match-team-name" style="color:var(--dire)">${esc(direName)}</div></div>
            </div>
            <div class="card-stats-row">
                <span class="card-gold-text" style="color:${goldColor}">💰 ${goldIcon} ${goldLead > 0 ? '+' : ''}${fmtGold(goldLead)}</span>
                <span class="card-tower-text">⛫ ${towers.radiant.alive} vs ${towers.dire.alive}</span>
            </div>
            ${renderDraftRow(radPicks, direPicks)}
            <div class="match-prediction">
                <span class="prediction-label r">${prediction.radiant}%</span>
                <div class="prediction-bar"><div class="prediction-fill" style="width:${prediction.radiant}%"></div></div>
                <span class="prediction-label d">${prediction.dire}%</span>
            </div>
            <div class="card-conf">${confLabel} — ${esc(predWinner)}</div>
        </div>`;

        const temp = document.createElement('div');
        temp.innerHTML = cardHtml.trim();
        const newCard = temp.firstChild;
        newCard.style.animation = 'fadeIn 0.3s ease';
        newCard.onclick = () => showMatch(activeMatches.indexOf(m));
        grid.appendChild(newCard);
    });
}

// ============================================
// MATCH DETAIL MODAL (ENHANCED)
// ============================================
async function showMatch(idx) {
    const m = liveMatches[idx];
    if (!m) return;
    const modal = document.getElementById('matchModal');
    const detail = document.getElementById('matchDetail');

    const radName = m.team_name_radiant || 'Radiant';
    const direName = m.team_name_dire || 'Dire';
    const radScore = m.radiant_score || 0;
    const direScore = m.dire_score || 0;
    const duration = fmtTime(m.game_time || 0);
    const league = m.league_name || 'Match';
    const prediction = predictLive(m);
    const players = m.players || [];
    const radPlayers = players.filter(p => p.team === 0);
    const direPlayers = players.filter(p => p.team === 1);
    const goldLead = m.radiant_lead || 0;
    const goldColor = goldLead > 0 ? 'var(--radiant)' : goldLead < 0 ? 'var(--dire)' : 'var(--text-muted)';
    const goldTeam = goldLead >= 0 ? radName : direName;
    const predWinner = prediction.radiant > prediction.dire ? radName : direName;
    const conf = Math.max(prediction.radiant, prediction.dire);
    const confEmoji = conf >= 70 ? '🔥' : conf >= 60 ? '📈' : '⚖️';
    const liquiRad = `${LIQUIPEDIA}${encodeURIComponent(radName.replace(/ /g, '_'))}`;
    const liquiDire = `${LIQUIPEDIA}${encodeURIComponent(direName.replace(/ /g, '_'))}`;

    detail.innerHTML = `
        <button class="modal-close" onclick="closeModal('matchModal')">✕</button>
        <div class="detail-header">
            <div class="detail-league">${esc(league)}</div>
            <div class="detail-teams">
                <a href="${liquiRad}" target="_blank" class="detail-team-name" style="color:var(--radiant)" title="View on Liquipedia">${esc(radName)} ↗</a>
                <div class="detail-score-box">
                    <span style="color:var(--radiant)">${radScore}</span>
                    <span style="color:var(--text-muted)"> — </span>
                    <span style="color:var(--dire)">${direScore}</span>
                </div>
                <a href="${liquiDire}" target="_blank" class="detail-team-name" style="color:var(--dire)" title="View on Liquipedia">${esc(direName)} ↗</a>
            </div>
            <div class="match-timer" style="font-size:18px">⏱ ${duration}</div>
        </div>

        <div class="detail-section">
            <h3>${confEmoji} Win Prediction — ${esc(predWinner)} (${conf}%)</h3>
            <div class="match-prediction" style="margin:0">
                <span class="prediction-label r" style="font-size:16px;font-weight:800">${prediction.radiant}%</span>
                <div class="prediction-bar" style="height:12px"><div class="prediction-fill" style="width:${prediction.radiant}%"></div></div>
                <span class="prediction-label d" style="font-size:16px;font-weight:800">${prediction.dire}%</span>
            </div>
            <div style="text-align:center;margin-top:6px;font-size:11px;color:var(--text-muted)">Kills + Gold + Draft WR + Towers + Player Hero Pool</div>
        </div>

        <div class="detail-section">
            <h3>💰 Gold Advantage</h3>
            ${renderGoldBar(goldLead, radName, direName)}
        </div>

        <div class="detail-section">
            <h3>🗺️ Hero Minimap — Live Positions</h3>
            ${renderMinimap(m.building_state, players)}
        </div>

        <div class="detail-section">
            <h3>⚔️ Draft — Live Picks</h3>
            <div class="detail-draft-row">
                <div class="detail-draft-side">${renderDetailHeroes(radPlayers, 'radiant')}</div>
                <span class="draft-vs-label" style="font-size:14px">VS</span>
                <div class="detail-draft-side">${renderDetailHeroes(direPlayers, 'dire')}</div>
            </div>
        </div>

        <div class="detail-section">
            <h3>👥 Players <span style="font-size:11px;color:var(--text-muted)">(click for hero pool)</span></h3>
            <div style="overflow-x:auto">${renderPlayerTable(radPlayers, direPlayers)}</div>
        </div>

        <div class="detail-section">
            <h3>📈 Stats</h3>
            <div class="detail-stats">
                <div class="stat-card"><div class="stat-label">💰 Gold Lead</div><div class="stat-value" style="color:${goldColor}">${goldLead > 0 ? '+' : ''}${fmtGold(goldLead)}</div></div>
                <div class="stat-card"><div class="stat-label">⛫ Towers (R/D)</div><div class="stat-value">${decodeTowers(m.building_state).radiant.alive} / ${decodeTowers(m.building_state).dire.alive}</div></div>
                <div class="stat-card"><div class="stat-label">⚔️ Total Kills</div><div class="stat-value">${radScore + direScore}</div></div>
                <div class="stat-card"><div class="stat-label">🎯 Kill Diff</div><div class="stat-value" style="color:${radScore >= direScore ? 'var(--radiant)' : 'var(--dire)'}">${radScore >= direScore ? '+' : ''}${radScore - direScore}</div></div>
                <div class="stat-card"><div class="stat-label">👁 Spectators</div><div class="stat-value" style="color:var(--cyan)">${fmtNum(m.spectators || 0)}</div></div>
                <div class="stat-card"><div class="stat-label">🏆 MMR</div><div class="stat-value" style="color:var(--purple)">${m.average_mmr || 'N/A'}</div></div>
            </div>
        </div>

        <div class="detail-section">
            <h3>📋 Team Match History</h3>
            <div class="team-history-tabs">
                <button class="th-tab active" onclick="loadTeamHistory(${m.team_id_radiant || 0},'radHistoryGrid','${esc(radName)}',this)" style="color:var(--radiant)">☀️ ${esc(radName)}</button>
                <button class="th-tab" onclick="loadTeamHistory(${m.team_id_dire || 0},'direHistoryGrid','${esc(direName)}',this)" style="color:var(--dire)">🌙 ${esc(direName)}</button>
            </div>
            <div id="radHistoryGrid" class="team-history-content"><div style="color:var(--text-muted);font-size:12px;padding:12px">Click a team tab to load history</div></div>
            <div id="direHistoryGrid" class="team-history-content" style="display:none"></div>
        </div>
    `;
    modal.classList.add('active');

    // Async: fetch player hero stats and enhance prediction
    enhanceWithPlayerStats(m, radPlayers, direPlayers);
}

// Fetch player hero stats asynchronously and update the prediction
async function enhanceWithPlayerStats(match, radPlayers, direPlayers) {
    const allPlayers = [...radPlayers, ...direPlayers];
    const promises = allPlayers
        .filter(p => p.account_id)
        .map(p => fetchPlayerHeroes(p.account_id).then(heroes => ({ accountId: p.account_id, heroId: p.hero_id, heroes })));

    const results = await Promise.allSettled(promises);
    const playerHeroData = {};

    results.forEach(r => {
        if (r.status === 'fulfilled' && r.value.heroes) {
            const { accountId, heroId, heroes } = r.value;
            const heroStat = heroes[heroId];
            playerHeroData[accountId] = { heroId, stat: heroStat || null, pool: heroes };
        }
    });

    // Update player rows with hero-specific WR
    allPlayers.forEach(p => {
        if (!p.account_id || !playerHeroData[p.account_id]) return;
        const data = playerHeroData[p.account_id];
        const el = document.querySelector(`[data-player-id="${p.account_id}"] .player-hero-wr`);
        if (el && data.stat) {
            el.innerHTML = `<span title="${data.stat.games} games on this hero">${data.stat.wr}% (${data.stat.games}g)</span>`;
            el.style.color = data.stat.wr >= 55 ? 'var(--radiant)' : data.stat.wr <= 45 ? 'var(--dire)' : 'var(--gold)';
        }
    });
}

// ============================================
// PLAYER DETAIL MODAL
// ============================================
async function showPlayer(accountId) {
    if (!accountId) return;
    const modal = document.getElementById('playerModal');
    const detail = document.getElementById('playerDetail');

    detail.innerHTML = `<button class="modal-close" onclick="closeModal('playerModal')">✕</button>
        <div class="loading-state" style="padding:30px"><div class="loader"></div><p>Loading player profile...</p></div>`;
    modal.classList.add('active');

    const [profile, heroes, recent] = await Promise.all([
        fetchPlayerProfile(accountId),
        fetchPlayerHeroes(accountId),
        fetchPlayerRecent(accountId)
    ]);

    if (!profile) {
        detail.innerHTML = `<button class="modal-close" onclick="closeModal('playerModal')">✕</button>
            <div class="no-matches"><div class="no-matches-icon">⚠️</div><h3>Player not found</h3></div>`;
        return;
    }

    const name = profile.profile?.personaname || 'Unknown';
    const avatar = profile.profile?.avatarfull || '';
    const country = profile.profile?.loccountrycode || '';
    const mmr = profile.mmr_estimate?.estimate || 'N/A';
    const liquiUrl = `${LIQUIPEDIA}${encodeURIComponent(name.replace(/ /g, '_'))}`;

    // Top 10 heroes by games
    const topHeroes = heroes ? Object.entries(heroes)
        .map(([id, s]) => ({ ...s, hero: HERO_BY_ID[id] }))
        .filter(h => h.hero && h.games >= 3)
        .sort((a, b) => b.games - a.games)
        .slice(0, 10) : [];

    // Recent matches
    const recentHtml = recent.slice(0, 8).map(rm => {
        const hero = HERO_BY_ID[rm.hero_id];
        const won = (rm.player_slot < 128) === rm.radiant_win;
        const kda = `${rm.kills}/${rm.deaths}/${rm.assists}`;
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">
            ${hero ? `<img src="${getHeroImg(hero)}" style="width:24px;height:24px;border-radius:3px" title="${hero.l}">` : ''}
            <span style="color:${won ? 'var(--radiant)' : 'var(--dire)'}; font-weight:700">${won ? 'W' : 'L'}</span>
            <span>${kda}</span>
            <span style="color:var(--gold)">${fmtNum(rm.gold_per_min || 0)} GPM</span>
            <span style="color:var(--text-muted)">${fmtTime(rm.duration || 0)}</span>
        </div>`;
    }).join('');

    detail.innerHTML = `
        <button class="modal-close" onclick="closeModal('playerModal')">✕</button>
        <div style="text-align:center;margin-bottom:16px">
            ${avatar ? `<img src="${avatar}" style="width:64px;height:64px;border-radius:50%;border:2px solid var(--accent);margin-bottom:8px">` : ''}
            <h2 style="font-size:20px">${esc(name)} ${country ? `<span style="font-size:14px">🌍 ${country.toUpperCase()}</span>` : ''}</h2>
            <div style="font-size:13px;color:var(--text-muted)">MMR: <span style="color:var(--purple);font-weight:700">${mmr}</span></div>
            <a href="${liquiUrl}" target="_blank" style="font-size:11px;color:var(--accent)">View on Liquipedia ↗</a>
        </div>

        <div class="detail-section">
            <h3>🎯 Hero Pool (Top 10, last 6 months)</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px">
                ${topHeroes.map(h => `
                    <div style="text-align:center;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:6px;font-size:10px">
                        <img src="${getHeroImg(h.hero)}" style="width:36px;height:36px;border-radius:4px;margin-bottom:2px" title="${h.hero.l}">
                        <div style="font-weight:700;color:${h.wr >= 55 ? 'var(--radiant)' : h.wr <= 45 ? 'var(--dire)' : 'var(--gold)'}">${h.wr}%</div>
                        <div style="color:var(--text-muted)">${h.games}g ${h.wins}w</div>
                    </div>`).join('')}
            </div>
        </div>

        <div class="detail-section">
            <h3>📋 Recent Matches</h3>
            ${recentHtml || '<div style="color:var(--text-muted)">No recent matches</div>'}
        </div>
    `;
}

// ============================================
// DRAFT & RENDERING HELPERS
// ============================================
function extractDraft(players) {
    return {
        radPicks: players.filter(p => p.team === 0).map(p => p.hero_id),
        direPicks: players.filter(p => p.team === 1).map(p => p.hero_id)
    };
}

function renderDraftRow(radPicks, direPicks) {
    if (!radPicks.length && !direPicks.length) return '';
    const renderPicks = picks => picks.map(id => {
        const hero = HERO_BY_ID[id];
        if (!hero) return `<div class="draft-hero-icon">?</div>`;
        return `<div class="draft-hero-icon" title="${hero.l} (${hero.w}% WR)" style="position:relative">
            <img src="${getHeroImg(hero)}" alt="${hero.l}" loading="lazy">
            <span style="position:absolute;bottom:-1px;left:0;right:0;font-size:8px;background:rgba(0,0,0,0.8);color:${hero.w >= 52 ? 'var(--radiant)' : hero.w <= 48 ? 'var(--dire)' : 'var(--text-secondary)'};text-align:center">${hero.w}%</span>
        </div>`;
    }).join('');
    return `<div class="match-draft"><div class="draft-side">${renderPicks(radPicks)}</div><span class="draft-vs-label">VS</span><div class="draft-side">${renderPicks(direPicks)}</div></div>`;
}

function renderDetailHeroes(players, side) {
    return players.map(p => {
        const hero = HERO_BY_ID[p.hero_id];
        if (!hero) return '<div class="detail-hero"><div class="detail-hero-icon">?</div></div>';
        return `<div class="detail-hero">
            <div class="detail-hero-icon ${side}-border"><img src="${getHeroImg(hero)}" alt="${hero.l}" loading="lazy"></div>
            <div class="detail-hero-name">${hero.l}</div>
        </div>`;
    }).join('');
}

function renderPlayerTable(radPlayers, direPlayers) {
    const row = (p, side) => {
        const hero = HERO_BY_ID[p.hero_id];
        const hImg = hero ? `<img src="${getHeroImg(hero)}" style="width:22px;height:22px;border-radius:3px;vertical-align:middle" loading="lazy">` : '';
        const name = p.name || p.personaname || 'Player';
        const sideColor = side === 'radiant' ? 'var(--radiant)' : 'var(--dire)';
        const clickable = p.account_id ? `onclick="showPlayer(${p.account_id})" style="cursor:pointer"` : '';
        return `<tr data-player-id="${p.account_id || ''}" ${clickable} title="Click for player profile">
            <td style="padding:6px 8px;white-space:nowrap">${hImg} <span style="color:${sideColor};font-weight:600">${esc(name)}</span></td>
            <td class="player-hero-wr" style="padding:6px 8px;text-align:center;font-size:11px;color:var(--text-muted)">Loading...</td>
            <td style="padding:6px 8px;text-align:center">
                ${p.account_id ? `<a href="${LIQUIPEDIA}${encodeURIComponent(name.replace(/ /g, '_'))}" target="_blank" style="color:var(--accent);font-size:11px">Liqui ↗</a>` : '-'}
            </td>
        </tr>`;
    };
    return `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:var(--text-muted);font-size:11px;text-transform:uppercase">
            <th style="padding:6px 8px;text-align:left">Player / Hero</th>
            <th style="padding:6px 8px">Hero WR (Player)</th>
            <th style="padding:6px 8px">Liquipedia</th>
        </tr></thead>
        <tbody>
            ${radPlayers.map(p => row(p, 'radiant')).join('')}
            <tr><td colspan="3" style="padding:4px;background:var(--border)"></td></tr>
            ${direPlayers.map(p => row(p, 'dire')).join('')}
        </tbody>
    </table>`;
}

// ============================================
// RECENT RESULTS
// ============================================
async function fetchRecentResults() {
    const grid = document.getElementById('resultsGrid');
    grid.innerHTML = '<div class="loading-state"><div class="loader"></div><p>Loading pro matches...</p></div>';
    try {
        const url = PROXY_API ? `${PROXY_API}/results` : `${API}/proMatches?limit=20`;
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const json = await res.json();
        const matches = Array.isArray(json) ? json : (json.matches || []);
        grid.innerHTML = matches.map(m => {
            const dur = fmtTime(m.duration || 0);
            return `<div class="match-card" style="cursor:default">
                <div class="match-league"><span>${esc(m.league_name || 'Pro')}</span><span style="color:var(--text-muted)">${timeAgo(m.start_time)}</span></div>
                <div class="match-timer">⏱ ${dur}</div>
                <div class="match-teams">
                    <div class="match-team"><div class="match-team-name" style="color:${m.radiant_win ? 'var(--radiant)' : 'var(--text-secondary)'}">${esc(m.radiant_name || 'Radiant')}</div>
                        ${m.radiant_win ? '<div class="match-team-tag" style="color:var(--radiant)">🏆</div>' : ''}</div>
                    <div class="match-score"><span class="score-radiant">${m.radiant_score || '?'}</span><span class="score-separator">—</span><span class="score-dire">${m.dire_score || '?'}</span></div>
                    <div class="match-team"><div class="match-team-name" style="color:${!m.radiant_win ? 'var(--dire)' : 'var(--text-secondary)'}">${esc(m.dire_name || 'Dire')}</div>
                        ${!m.radiant_win ? '<div class="match-team-tag" style="color:var(--dire)">🏆</div>' : ''}</div>
                </div>
            </div>`;
        }).join('');
    } catch {
        grid.innerHTML = '<div class="no-matches"><div class="no-matches-icon">⚠️</div><h3>Could not load results</h3></div>';
    }
}

// ============================================
// DRAFT ANALYZER
// ============================================
// Draft analyzer removed — win prediction integrated into live match cards via predictLive()

// ============================================
// WIN PREDICTION ENGINE (ENHANCED)
// ============================================
function predictLive(match) {
    const rScore = match.radiant_score || 0;
    const dScore = match.dire_score || 0;
    const gold = match.radiant_lead || 0;
    const time = match.game_time || 0;

    let r = 50;

    // 1. Kill advantage (max ±15%)
    r += Math.tanh((rScore - dScore) / 12) * 15;

    // 2. Gold advantage (max ±20%)
    if (gold !== 0) r += Math.tanh(gold / 8000) * 20;

    // 3. Draft hero WR (max ±8%)
    const players = match.players || [];
    const rP = players.filter(p => p.team === 0);
    const dP = players.filter(p => p.team === 1);
    let rDraft = 0, dDraft = 0;
    rP.forEach(p => { const h = HERO_BY_ID[p.hero_id]; if (h) rDraft += (h.w - 50); });
    dP.forEach(p => { const h = HERO_BY_ID[p.hero_id]; if (h) dDraft += (h.w - 50); });
    r += Math.tanh((rDraft - dDraft) / 8) * 8;

    // 4. Late game gold scaling (after 30min)
    if (time > 1800 && gold !== 0) r += Math.tanh(gold / 6000) * 5;

    // 5. Tower advantage (max ±10%)
    if (match.building_state !== undefined) {
        const t = decodeTowers(match.building_state);
        const tDiff = t.radiant.alive - t.dire.alive;
        r += tDiff * 1.2;
    }

    return { radiant: Math.max(8, Math.min(92, Math.round(r))), dire: 100 - Math.max(8, Math.min(92, Math.round(r))) };
}

function countBits(n) { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; }

// ============================================
// AUTO REFRESH & UTILITIES
// ============================================
function startAutoRefresh() {
    let remaining = Math.round(currentRefresh / 1000);
    const el = document.getElementById('refreshTimer');
    function tick() {
        remaining--;
        if (el) el.textContent = `${remaining}s`;
        if (remaining <= 0) {
            remaining = Math.round(currentRefresh / 1000);
            if (currentView === 'live') fetchLiveMatches();
        }
        setTimeout(tick, 1000);
    }
    setTimeout(tick, 1000);
}

function updateStatus(s) {
    const dot = document.querySelector('#connectionStatus .status-dot');
    if (!dot) return;
    const colors = { online: 'var(--radiant)', fetching: 'var(--gold)', cached: 'var(--cyan)', error: 'var(--dire)' };
    const glows = { online: 'var(--radiant-glow)', fetching: 'var(--gold-bg)', cached: '0,180,220', error: 'var(--dire-glow)' };
    dot.style.background = colors[s] || colors.error;
    dot.style.boxShadow = `0 0 8px ${glows[s] || glows.error}`;
}

function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function fmtNum(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function fmtGold(n) { const a = Math.abs(n); return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${a}`; }
function timeAgo(ts) { const d = Date.now() / 1000 - ts; return d < 3600 ? `${Math.floor(d / 60)}m ago` : d < 86400 ? `${Math.floor(d / 3600)}h ago` : `${Math.floor(d / 86400)}d ago`; }
function esc(s) { return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }

// Globals
window.showMatch = showMatch;
window.showPlayer = showPlayer;
window.pickHero = pickHero;
window.removeHero = removeHero;
window.closeModal = closeModal;

// Team history loader (called from match detail modal)
async function loadTeamHistory(teamId, gridId, teamName, btn) {
    if (!teamId) return;
    // Toggle tab active state
    document.querySelectorAll('.th-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    // Show/hide grids
    document.querySelectorAll('.team-history-content').forEach(g => g.style.display = 'none');
    const grid = document.getElementById(gridId);
    grid.style.display = 'block';
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px">Loading...</div>';
    const matches = await fetchTeamHistory(teamId);
    grid.innerHTML = renderTeamHistory(matches, teamName, teamId);
}
window.loadTeamHistory = loadTeamHistory;
