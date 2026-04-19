import Graph from 'graphology';
import Sigma from 'sigma';
import circular from 'graphology-layout/circular';
import forceAtlas2 from 'graphology-layout-forceatlas2';

let renderer = null;
let graphData = null;
let nodeDataMap = {};

let anchorHomePositions = {};
let anchorVelocities = {};
let anchorAlpha = 0;
let anchorFrameId = null;
let anchorDraggedNode = null;

const state = {
  selectedNode: null,
  neighbors: new Set(),
  searchQuery: '',
  hoveredNode: null,
};

function buildLegend(nodes) {
  const seen = new Map();
  for (const n of nodes) {
    if (!seen.has(n.topic_id)) {
      seen.set(n.topic_id, { label: n.topic_label, color: n.color });
    }
  }
  const entries = [...seen.entries()]
    .sort((a, b) => a[0] === -1 ? 1 : b[0] === -1 ? -1 : a[0] - b[0]);

  const legend = document.getElementById('legend');
  for (const [, { label, color }] of entries) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span><span>${label}</span>`;
    legend.appendChild(item);
  }
  legend.style.display = 'block';
}

function tickAnchored(graph) {
  if (anchorAlpha <= 0.001) {
    graph.forEachNode(node => {
      if (node === anchorDraggedNode) return;
      graph.setNodeAttribute(node, 'x', anchorHomePositions[node].x);
      graph.setNodeAttribute(node, 'y', anchorHomePositions[node].y);
      anchorVelocities[node] = { x: 0, y: 0 };
    });
    if (renderer) renderer.refresh();
    anchorFrameId = null;
    return;
  }

  const anchorStrength = 0.08;
  const damping = 0.85;

  graph.forEachNode(node => {
    if (node === anchorDraggedNode) return;
    const pos = { x: graph.getNodeAttribute(node, 'x'), y: graph.getNodeAttribute(node, 'y') };
    const home = anchorHomePositions[node];
    const vel = anchorVelocities[node];

    // Pure anchor spring — no repulsion so UMAP positions are true equilibrium
    vel.x = (vel.x + (home.x - pos.x) * anchorStrength) * damping;
    vel.y = (vel.y + (home.y - pos.y) * anchorStrength) * damping;
    graph.setNodeAttribute(node, 'x', pos.x + vel.x);
    graph.setNodeAttribute(node, 'y', pos.y + vel.y);
  });

  anchorAlpha *= 0.95;
  if (renderer) renderer.refresh();
  anchorFrameId = requestAnimationFrame(() => tickAnchored(graph));
}

async function loadData() {
  const res = await fetch('../../graph_data.json');
  graphData = await res.json();
  buildLegend(graphData.nodes);
  setupToggle();
  init();
}

function getLayout() {
  return new URLSearchParams(window.location.search).get('layout') || 'anchored';
}

function setupToggle() {
  document.getElementById('layout-toggle').addEventListener('click', () => {
    const cycle = { umap: 'force', force: 'dynamic', dynamic: 'anchored', anchored: 'umap' };
    const next = cycle[getLayout()] || 'dynamic';
    history.pushState({}, '', '?layout=' + next);
    state.selectedNode = null;
    state.neighbors = new Set();
    state.searchQuery = '';
    document.getElementById('search').value = '';
    clearPanel();
    init();
  });
}

function rescaleCoords(nodes) {
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  return nodes.map(n => ({
    ...n,
    scaledX: (n.x - xMin) / xRange,
    scaledY: (n.y - yMin) / yRange,
  }));
}

function init() {
  const layout = getLayout();

  const labels = { umap: '📌 Pinned', force: '🌀 Force', dynamic: '✨ Dynamic', anchored: '🧲 Anchored' };
  document.getElementById('layout-toggle').textContent = labels[layout] || '🧲 Anchored';

  if (anchorFrameId) {
    cancelAnimationFrame(anchorFrameId);
    anchorFrameId = null;
  }
  anchorAlpha = 0;
  anchorDraggedNode = null;

  if (renderer) {
    renderer.kill();
    renderer = null;
  }

  const { nodes, edges } = graphData;
  const scaled = rescaleCoords(nodes);

  nodeDataMap = {};
  scaled.forEach(n => {
    nodeDataMap[n.id] = {
      ...n,
      searchText: [n.title, n.abstract, n.speaker, n.topic_label]
        .filter(Boolean).join(' ').toLowerCase(),
    };
  });

  const graph = new Graph({ type: 'undirected', multi: false });

  scaled.forEach(n => {
    const attrs = {
      label: n.title,
      size: 8,
      color: n.color,
    };
    if (layout === 'umap' || layout === 'dynamic' || layout === 'anchored') {
      attrs.x = n.scaledX;
      attrs.y = n.scaledY;
    }
    graph.addNode(n.id, attrs);
  });

  edges.forEach(e => {
    if (
      graph.hasNode(e.source) &&
      graph.hasNode(e.target) &&
      e.source !== e.target &&
      !graph.hasEdge(e.source, e.target)
    ) {
      graph.addEdge(e.source, e.target, {
        color: '#dddddd',
        size: Math.max(0.5, (e.weight - 0.75) * 6),
      });
    }
  });

  if (layout === 'force') {
    circular.assign(graph);
    if (graph.order <= 500) {
      forceAtlas2.assign(graph, {
        iterations: 150,
        settings: {
          ...forceAtlas2.inferSettings(graph),
          gravity: 1,
          scalingRatio: 2,
        },
      });
    } else {
      import('graphology-layout-forceatlas2/worker').then(({ default: FA2Layout }) => {
        const fa2 = new FA2Layout(graph, { settings: { gravity: 1, scalingRatio: 2 } });
        fa2.start();
        setTimeout(() => {
          fa2.stop();
          if (renderer) renderer.refresh();
        }, 3000);
      });
    }
  } else if (layout === 'dynamic') {
    import('graphology-layout-forceatlas2/worker').then(({ default: FA2Layout }) => {
      const fa2 = new FA2Layout(graph, {
        settings: {
          ...forceAtlas2.inferSettings(graph),
          gravity: 0.5,
          scalingRatio: 2,
        },
      });
      fa2.start();
      setTimeout(() => fa2.stop(), 1000);
    });
  } else if (layout === 'anchored') {
    anchorHomePositions = {};
    anchorVelocities = {};
    scaled.forEach(n => {
      anchorHomePositions[n.id] = { x: n.scaledX, y: n.scaledY };
      anchorVelocities[n.id] = { x: 0, y: 0 };
    });
  }

  const container = document.getElementById('graph-container');

  renderer = new Sigma(graph, container, {
    labelRenderedSizeThreshold: 8,
    nodeReducer(node, attrs) {
      const res = { ...attrs };
      const query = state.searchQuery.toLowerCase();

      if (query) {
        const matches = nodeDataMap[node]?.searchText.includes(query);
        if (!matches) {
          res.color = '#d8d8d8';
          res.zIndex = -1;
        }
      }

      if (state.selectedNode) {
        const relevant = node === state.selectedNode || state.neighbors.has(node);
        if (!relevant) {
          res.color = '#d8d8d8';
        } else {
          res.highlighted = true;
        }
      }

      // Only show label on hover
      res.label = node === state.hoveredNode ? attrs.label : undefined;

      return res;
    },
    edgeReducer(edge, attrs) {
      const res = { ...attrs };
      if (state.selectedNode) {
        const src = graph.source(edge);
        const tgt = graph.target(edge);
        if (src === state.selectedNode || tgt === state.selectedNode) {
          res.color = '#555555';
        } else {
          res.color = '#e8e8e8';
        }
      }
      return res;
    },
  });

  renderer.on('enterNode', ({ node }) => {
    state.hoveredNode = node;
    renderer.refresh();
  });

  renderer.on('leaveNode', () => {
    state.hoveredNode = null;
    renderer.refresh();
  });

  renderer.on('clickNode', ({ node }) => {
    state.selectedNode = node;
    state.neighbors = new Set(graph.neighbors(node));
    renderer.refresh();
    showDetail(nodeDataMap[node]);
  });

  renderer.on('clickStage', () => {
    state.selectedNode = null;
    state.neighbors = new Set();
    renderer.refresh();
    clearPanel();
  });

  if (layout === 'dynamic') {
    let dragLayout = null;

    renderer.on('downNode', () => {
      import('graphology-layout-forceatlas2/worker').then(({ default: FA2Layout }) => {
        if (!dragLayout) {
          dragLayout = new FA2Layout(graph, { settings: forceAtlas2.inferSettings(graph) });
        }
        dragLayout.start();
      });
    });

    container.addEventListener('mouseup', () => {
      if (dragLayout) {
        setTimeout(() => dragLayout.stop(), 1500);
      }
    });
  }

  if (layout === 'anchored') {
    let isDragging = false;
    let downPos = null;
    const DRAG_THRESHOLD = 6; // px — ignore tiny jitter during a click
    const captor = renderer.getMouseCaptor();

    renderer.on('downNode', ({ node, event }) => {
      anchorDraggedNode = node;
      isDragging = false;
      downPos = { x: event.x, y: event.y };
    });

    captor.on('mousemovebody', (e) => {
      if (!anchorDraggedNode || !downPos) return;
      const dx = e.x - downPos.x;
      const dy = e.y - downPos.y;
      if (!isDragging && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;

      isDragging = true;
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
      const pos = renderer.viewportToGraph(e);
      graph.setNodeAttribute(anchorDraggedNode, 'x', pos.x);
      graph.setNodeAttribute(anchorDraggedNode, 'y', pos.y);
      if (!anchorFrameId) {
        anchorAlpha = 1.0;
        anchorFrameId = requestAnimationFrame(() => tickAnchored(graph));
      }
    });

    captor.on('mouseup', () => {
      const wasDragging = isDragging;
      anchorDraggedNode = null;
      isDragging = false;
      downPos = null;
      if (wasDragging) {
        anchorAlpha = 1.0;
        if (!anchorFrameId) {
          anchorFrameId = requestAnimationFrame(() => tickAnchored(graph));
        }
      }
    });
  }

  // Replace search handler each init to avoid stale renderer closures
  const searchEl = document.getElementById('search');
  searchEl.oninput = (e) => {
    state.searchQuery = e.target.value;
    if (renderer) renderer.refresh();
  };
}

function showDetail(node) {
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('detail').style.display = 'block';
  document.getElementById('d-title').textContent = node.title;
  document.getElementById('d-speaker').textContent = node.speaker || '';
  document.getElementById('d-date').textContent = node.date || '';
  document.getElementById('d-topic').textContent = node.topic_label || '\u2014';
  document.getElementById('d-abstract').textContent = node.abstract || '';
  const videoEl = document.getElementById('d-video');
  if (node.video_url) {
    videoEl.href = node.video_url;
    videoEl.style.display = 'inline-block';
  } else {
    videoEl.style.display = 'none';
  }
}

function clearPanel() {
  document.getElementById('placeholder').style.display = 'block';
  document.getElementById('detail').style.display = 'none';
}

loadData().catch(err => console.error('Failed to load graph data:', err));
