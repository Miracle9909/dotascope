/* ============================================ */
/* DotaScope v2.0 — Enhanced Live Analytics     */
/* Tower display + Player stats + Win prediction */
/* ============================================ */

const API = 'https://api.opendota.com/api';
const LIQUIPEDIA = 'https://liquipedia.net/dota2/';
const REFRESH_MS = 8000;
let currentView = 'live';
let liveMatches = [];
let playerCache = {};   // Cache player hero stats

// Draft analyzer state
const draft = { radiant: [], dire: [], activeTeam: 'radiant' };

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

// ============================================
// PLAYER STATS FETCHER (OpenDota API)
// ============================================
async function fetchPlayerHeroes(accountId) {
    if (playerCache[accountId]) return playerCache[accountId];
    try {
        const res = await fetch(`${API}/players/${accountId}/heroes?limit=30&date=180`);
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
        const res = await fetch(`${API}/players/${accountId}`);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchPlayerRecent(accountId) {
    try {
        const res = await fetch(`${API}/players/${accountId}/recentMatches?limit=10`);
        if (!res.ok) return [];
        return await res.json();
    } catch { return []; }
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupDraftAnalyzer();
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
// LIVE MATCHES
// ============================================
async function fetchLiveMatches() {
    try {
        updateStatus('fetching');
        const res = await fetch(`${API}/live`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        liveMatches = data
            .filter(m => m.team_name_radiant || m.team_name_dire || m.league_id)
            .sort((a, b) => (b.spectators || 0) - (a.spectators || 0));

        renderLiveMatches();
        updateStatus('online');
    } catch (err) {
        console.error('Live fetch error:', err);
        updateStatus('error');
        document.getElementById('matchesGrid').innerHTML = `<div class="no-matches"><div class="no-matches-icon">📡</div><h3>Connection issue — retrying...</h3></div>`;
    }
}

function renderLiveMatches() {
    const grid = document.getElementById('matchesGrid');
    const count = document.getElementById('matchCount');

    if (liveMatches.length === 0) {
        grid.innerHTML = `<div class="no-matches"><div class="no-matches-icon">🎮</div><h3>No live pro matches right now</h3><p>Check back soon or view recent results</p></div>`;
        count.textContent = '0 Live';
        return;
    }
    count.textContent = `${liveMatches.length} Live`;

    grid.innerHTML = liveMatches.map((m, idx) => {
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
        const towerDiff = towers.dire.destroyed - towers.radiant.destroyed;
        const predWinner = prediction.radiant > prediction.dire ? radName : direName;
        const conf = Math.max(prediction.radiant, prediction.dire);
        const confLabel = conf >= 70 ? '🔥 Strong' : conf >= 60 ? '📈 Likely' : '⚖️ Close';

        return `
        <div class="match-card" onclick="showMatch(${idx})">
            <div class="match-league">
                <span>${esc(league)}</span>
                <div class="live-badge"><span class="pulse-sm"></span> LIVE ${spec}</div>
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
            <div style="text-align:center;margin:4px 0;font-size:12px">
                <span style="color:${goldColor};font-weight:700">💰 ${goldIcon} ${goldLead > 0 ? '+' : ''}${fmtGold(goldLead)}</span>
                <span style="margin-left:12px;color:var(--text-muted)">🏛 ${towers.radiant.alive} vs ${towers.dire.alive}</span>
            </div>
            ${renderDraftRow(radPicks, direPicks)}
            <div class="match-prediction">
                <span class="prediction-label r">${prediction.radiant}%</span>
                <div class="prediction-bar"><div class="prediction-fill" style="width:${prediction.radiant}%"></div></div>
                <span class="prediction-label d">${prediction.dire}%</span>
            </div>
            <div style="text-align:center;margin-top:4px;font-size:11px;color:var(--text-muted)">${confLabel} — ${esc(predWinner)}</div>
        </div>`;
    }).join('');
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
            <div style="text-align:center;padding:12px;background:var(--bg-card);border-radius:8px;border:1px solid var(--border)">
                <div style="font-size:13px;color:var(--text-muted)">${goldLead >= 0 ? '☀️' : '🌙'} ${esc(goldTeam)} leads</div>
                <div style="font-family:var(--font-display);font-size:32px;font-weight:900;color:${goldColor}">
                    ${goldLead > 0 ? '+' : ''}${fmtGold(goldLead)}
                </div>
            </div>
        </div>

        <div class="detail-section">
            <h3>🏛 Tower Status</h3>
            ${renderTowerStatus(m.building_state)}
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
                <div class="stat-card"><div class="stat-label">🏛 Towers (R/D)</div><div class="stat-value">${decodeTowers(m.building_state).radiant.alive} / ${decodeTowers(m.building_state).dire.alive}</div></div>
                <div class="stat-card"><div class="stat-label">⚔️ Total Kills</div><div class="stat-value">${radScore + direScore}</div></div>
                <div class="stat-card"><div class="stat-label">🎯 Kill Diff</div><div class="stat-value" style="color:${radScore >= direScore ? 'var(--radiant)' : 'var(--dire)'}">${radScore >= direScore ? '+' : ''}${radScore - direScore}</div></div>
                <div class="stat-card"><div class="stat-label">👁 Spectators</div><div class="stat-value" style="color:var(--cyan)">${fmtNum(m.spectators || 0)}</div></div>
                <div class="stat-card"><div class="stat-label">🏆 MMR</div><div class="stat-value" style="color:var(--purple)">${m.average_mmr || 'N/A'}</div></div>
            </div>
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
        const res = await fetch(`${API}/proMatches?limit=20`);
        if (!res.ok) throw new Error();
        const matches = await res.json();
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
function setupDraftAnalyzer() {
    renderDraftSlots(); renderHeroGrid();
    document.getElementById('resetDraft').addEventListener('click', resetDraft);
    document.getElementById('heroSearch').addEventListener('input', filterHeroes);
    document.querySelectorAll('#heroFilters .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#heroFilters .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active'); filterHeroes();
        });
    });
}

function renderDraftSlots() {
    ['radiant', 'dire'].forEach(team => {
        const el = document.getElementById(`${team}Slots`);
        el.innerHTML = '';
        for (let i = 0; i < 5; i++) {
            const hero = draft[team][i];
            const slot = document.createElement('div');
            slot.className = `draft-slot ${team}-slot ${hero ? 'filled' : ''}`;
            slot.onclick = () => { if (!hero) draft.activeTeam = team; };
            if (hero) {
                slot.innerHTML = `<img src="${getHeroImg(hero)}" alt="${hero.l}" title="${hero.l}">
                    <button class="remove-hero" onclick="event.stopPropagation();removeHero('${team}',${i})">✕</button>`;
            } else slot.textContent = '+';
            el.appendChild(slot);
        }
    });
}

function renderHeroGrid() {
    const grid = document.getElementById('heroGrid');
    const search = (document.getElementById('heroSearch')?.value || '').toLowerCase();
    const attr = document.querySelector('#heroFilters .filter-btn.active')?.dataset.attr || 'all';
    const picked = new Set([...draft.radiant.map(h => h.id), ...draft.dire.map(h => h.id)]);
    const filtered = HEROES.filter(h => {
        if (search && !h.l.toLowerCase().includes(search) && !h.n.includes(search)) return false;
        if (attr !== 'all' && h.a !== attr) return false;
        return true;
    });
    grid.innerHTML = filtered.map(h => {
        const wrColor = h.w >= 52 ? 'var(--radiant)' : h.w <= 48 ? 'var(--dire)' : 'var(--text-secondary)';
        return `<button class="hero-pick-btn ${picked.has(h.id) ? 'picked' : ''}" onclick="pickHero(${h.id})" title="${h.l} (${h.w}% WR)">
            <img src="${getHeroImg(h)}" alt="${h.l}" loading="lazy">
            <span class="hero-wr" style="color:${wrColor}">${h.w}%</span>
        </button>`;
    }).join('');
}

function pickHero(heroId) {
    const hero = HERO_BY_ID[heroId];
    if (!hero) return;
    let team = draft.activeTeam;
    if (draft[team].length >= 5) { team = team === 'radiant' ? 'dire' : 'radiant'; draft.activeTeam = team; }
    if (draft[team].length >= 5) return;
    draft[team].push(hero);
    if (draft[team].length >= 5) draft.activeTeam = team === 'radiant' ? 'dire' : 'radiant';
    updateDraftUI();
}

function removeHero(team, i) { draft[team].splice(i, 1); updateDraftUI(); }
function resetDraft() { draft.radiant = []; draft.dire = []; draft.activeTeam = 'radiant'; updateDraftUI(); }
function updateDraftUI() { renderDraftSlots(); renderHeroGrid(); updateWinPred(); }
function filterHeroes() { renderHeroGrid(); }

function updateWinPred() {
    const pred = calcDraftWR(draft.radiant, draft.dire);
    document.getElementById('radiantWinPct').textContent = `${pred.radiant}%`;
    document.getElementById('direWinPct').textContent = `${pred.dire}%`;
    document.getElementById('radiantWinBar').style.width = `${pred.radiant}%`;
    document.getElementById('direWinBar').style.width = `${pred.dire}%`;
}

function calcDraftWR(rad, dire) {
    if (!rad.length && !dire.length) return { radiant: 50, dire: 50 };
    const rAvg = rad.length ? rad.reduce((s, h) => s + h.w, 0) / rad.length : 50;
    const dAvg = dire.length ? dire.reduce((s, h) => s + h.w, 0) / dire.length : 50;
    let rPct = Math.round(rAvg / (rAvg + dAvg) * 100);
    if (rad.length === 5 && dire.length < 5) rPct = Math.min(rPct + 2, 85);
    if (dire.length === 5 && rad.length < 5) rPct = Math.max(rPct - 2, 15);
    const rAttrs = new Set(rad.map(h => h.a));
    const dAttrs = new Set(dire.map(h => h.a));
    if (rAttrs.size >= 3) rPct = Math.min(rPct + 1, 80);
    if (dAttrs.size >= 3) rPct = Math.max(rPct - 1, 20);
    return { radiant: rPct, dire: 100 - rPct };
}

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
    let t = REFRESH_MS / 1000;
    const el = document.getElementById('refreshTimer');
    setInterval(() => {
        t--;
        if (el) el.textContent = `${t}s`;
        if (t <= 0) { t = REFRESH_MS / 1000; if (currentView === 'live') fetchLiveMatches(); }
    }, 1000);
}

function updateStatus(s) {
    const dot = document.querySelector('#connectionStatus .status-dot');
    if (!dot) return;
    dot.style.background = s === 'online' ? 'var(--radiant)' : s === 'fetching' ? 'var(--gold)' : 'var(--dire)';
    dot.style.boxShadow = `0 0 8px ${s === 'online' ? 'var(--radiant-glow)' : s === 'fetching' ? 'var(--gold-bg)' : 'var(--dire-glow)'}`;
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
