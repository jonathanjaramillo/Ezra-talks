# Ezra Talks

Interactive constellation map of [Ezra Talks](https://www.engineering.cornell.edu/ezra-talks) — the Systems Engineering seminar series at Cornell. Talks are embedded with a sentence transformer, clustered by topic with BERTopic, and displayed as a navigable graph where edges connect semantically similar talks.

## Structure

```
ezra_talks/
├── pipeline.py          # ML pipeline: embed → cluster → project → export
├── graph_data.json      # Pipeline output consumed by the visualization
├── embeddings.npy       # Cached sentence embeddings
├── data/
│   └── Ezra Abstracts.md
└── visualization/
    └── sigma/           # Sigma.js + Vite front-end
        ├── index.html
        └── app.js
```

## Quickstart

### 1. Run the pipeline

```bash
uv run pipeline.py \
  --input data/"Ezra Abstracts.md" \
  --output graph_data.json \
  --threshold 0.75
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--threshold` | `0.75` | Cosine similarity cutoff for edges |
| `--min-connections` | — | Guarantee at least N edges per node (adaptive) |
| `--max-connections` | — | Cap at N edges per node (adaptive) |

### 2. Start the visualization

```bash
cd visualization/sigma
npm install
npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173`).

## Visualization

The graph renders in a dark star-map aesthetic with four layout modes selectable from the toolbar:

| Mode | Description |
|---|---|
| **Anchored** | Force-directed, seeded from UMAP coordinates |
| **Pinned** | Nodes locked to raw UMAP positions |
| **Force** | Live ForceAtlas2 simulation |
| **Dynamic** | Continuous physics |

The left rail lets you filter by topic cluster or color-code by speaker / year. Click any node to open its detail panel showing the abstract and nearest neighbors by similarity.

### Build a static bundle

```bash
npm run build   # output in visualization/sigma/dist/
```

## Data format

`graph_data.json` schema:

```jsonc
{
  "nodes": [
    {
      "id": "003-some-talk-slug",
      "title": "Talk Title",
      "abstract": "...",
      "speaker": "Jane Doe",
      "date": "2024-03-15",
      "topic_id": 2,
      "topic_label": "memory, cache, prefetch, latency",
      "color": "#5ec47a",
      "x": 1.234,
      "y": -0.567
    }
  ],
  "edges": [
    { "source": "003-...", "target": "017-...", "weight": 0.823 }
  ]
}
```

## Dependencies

**Python** (managed with [uv](https://github.com/astral-sh/uv)):
- `sentence-transformers` — `all-MiniLM-L6-v2` embeddings
- `bertopic` — topic modeling
- `umap-learn` — 2-D projection
- `scikit-learn`, `numpy`

**JavaScript** (npm):
- [Sigma.js](https://www.sigmajs.org/) — WebGL graph renderer
- [Graphology](https://graphology.github.io/) — graph data structures
- [Vite](https://vitejs.dev/) — bundler / dev server
