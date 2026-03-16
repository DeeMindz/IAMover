# IAM Platform — AI Chatbot Platform

A clean, dark-themed, production-grade chatbot platform dashboard.
Built with pure HTML, CSS, and JavaScript — no build tools required.

## 📁 Project Structure

```
chatbot-platform/
├── index.html              ← Main app (open this in browser)
├── css/
│   └── styles.css          ← Full design system + all component styles
├── js/
│   ├── app.js              ← App state, navigation, page renderers, all logic
│   └── charts.js           ← SVG chart helpers (area, bar, donut, sparkline)
└── README.md               ← This file
```

## 🚀 Getting Started

1. Open the folder in VS Code (or any editor)
2. Open `index.html` directly in your browser — no server needed
3. Or use VS Code Live Server extension for hot-reload

## ✅ Features Implemented

| Feature | Status |
|---|---|
| Dashboard with bot cards | ✅ |
| Create new bot (modal) | ✅ |
| LLM model selection | ✅ |
| Analytics dashboard with charts | ✅ |
| Conversations / HITL (human intercept) | ✅ |
| Knowledge base management | ✅ |
| File upload zone | ✅ |
| Rich text content input | ✅ |
| Sitemap crawler input | ✅ |
| System prompt / AI training | ✅ |
| Anti-hallucination toggle + settings | ✅ |
| Lead capture variables | ✅ |
| Leads table with export to CSV | ✅ |
| Bot appearance customization | ✅ |
| Widget embed snippet generator | ✅ |
| Inline div embed snippet generator | ✅ |
| Integrations page | ✅ |
| Settings (workspace, API keys, team) | ✅ |
| Toast notifications | ✅ |
| Modals + side panels | ✅ |

## 🎨 Design System

All CSS variables are in `css/styles.css` under `:root { }`.
Key tokens:
- `--accent`: #6c63ff (purple)
- `--accent-2`: #00e5a0 (green)
- `--bg-base / surface / elevated`: dark background layers
- `--font-display`: Syne (headings)
- `--font-body`: DM Sans (body)

## 🔧 Extending

### Add a new page:
1. Add a `.nav-item` in sidebar with `data-page="your-page"`
2. Add `<div class="page-content hidden" id="page-your-page">` in main
3. Add a `case 'your-page': renderYourPage(); break;` in `renderPage()` in `app.js`

### Add a new bot field:
1. Add the field to the bot object in `AppState.bots`
2. Add a form input in `config-overview` section of bot config page
3. Read + save it in `fillBotForm()` and `saveBotConfig()` in `app.js`

### Connect to a real backend:
- Replace `AppState` with API calls
- The JS is structured as simple functions — easy to swap state for fetch calls
