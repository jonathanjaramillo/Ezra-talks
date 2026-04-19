# Ezra Talks — vis-network

Interactive graph visualization of Ezra talks using [vis-network](https://visjs.github.io/vis-network/), loaded via CDN. No build step required.

## Running

Open `index.html` directly in a browser, or serve the directory:

```bash
npx serve .
```

Then open `http://localhost:3000` (or whatever port `serve` reports).

## Layout Modes

Append a query parameter to switch between layouts:

| URL | Mode |
|-----|------|
| `index.html` or `index.html?layout=umap` | UMAP-pinned positions (default) |
| `index.html?layout=force` | Force-directed (forceAtlas2Based) |

The **Switch to Force / Switch to UMAP** button in the panel toggles between modes without reloading the page.

## Data File

`graph_data.json` must be located at the project root — two directories above this folder:

```
ezra_talks/
├── graph_data.json          ← required here
└── visualization/
    └── vis-network/
        └── index.html       ← you are here
```
