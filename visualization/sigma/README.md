# Ezra Talks — Sigma.js

Interactive graph visualization of Ezra talks using [Sigma.js](https://www.sigmajs.org/) and [Graphology](https://graphology.github.io/), bundled with [Vite](https://vitejs.dev/).

## Running

```bash
npm install
npm run dev
```

Then open the URL printed by Vite (typically `http://localhost:5173`).

To build a static bundle:

```bash
npm run build
```

## Layout Modes

Append a query parameter to switch between layouts:

| URL | Mode |
|-----|------|
| `/` or `/?layout=umap` | UMAP-pinned positions (default) |
| `/?layout=force` | Force-directed (ForceAtlas2) |

The **Switch to Force / Switch to UMAP** button in the toolbar toggles between modes without reloading the page.

## Data File

`graph_data.json` must be located at the project root — two directories above this folder:

```
ezra_talks/
├── graph_data.json          ← required here
└── visualization/
    └── sigma/
        └── index.html       ← you are here
```
