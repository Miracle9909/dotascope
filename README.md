# ⚔️ DotaScope — Live Dota 2 Analytics

Real-time Dota 2 match tracking with AI-powered win prediction.

## 🔴 [Live Demo](https://your-username.github.io/DotaScope/)

## Features

| Feature | Description |
|---------|-------------|
| 🔴 **Live Matches** | Real-time pro match scores, updated every 8 seconds |
| 💰 **Gold Lead** | Net worth difference between teams |
| 🏛 **Tower Status** | Building state decoded from bitmask — alive/destroyed per side |
| 📊 **Win Prediction** | 5-factor engine: kills + gold + draft WR + towers + late-game scaling |
| 🎯 **Player Hero Pool** | Each player's hero-specific win rate from OpenDota |
| 🔗 **Liquipedia Links** | Direct links to team and player pages |
| 🧠 **Draft Analyzer** | Pick heroes and predict win probability |
| 📋 **Recent Results** | Last 20 pro match results |

## Data Sources

- **[OpenDota API](https://www.opendota.com/)** — Live matches, player stats, hero data
- **[Liquipedia](https://liquipedia.net/dota2/)** — Team and player profiles
- **[Steam CDN](https://cdn.dota2.com/)** — Hero images

## Tech Stack

- **HTML/CSS/JS** — No framework, pure vanilla
- **OpenDota API** — Free, no auth required
- **GitHub Pages** — Static hosting

## Deploy

```bash
git clone https://github.com/your-username/DotaScope.git
# Open index.html in browser, or:
npx serve .
```

## Win Prediction Algorithm

```
① Kill Difference  → tanh(killDiff/12) × 15%    (max ±15%)
② Gold Advantage   → tanh(goldLead/8000) × 20%   (max ±20%)
③ Draft Win Rates  → tanh(draftDiff/8) × 8%      (max ±8%)
④ Late Game Scale  → Extra gold weight after 30min
⑤ Tower State      → towerDiff × 1.2%             (max ±10%)
```

## License

MIT
