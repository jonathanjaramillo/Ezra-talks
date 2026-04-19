import Graph from 'graphology';
import Sigma from 'sigma';
import circular from 'graphology-layout/circular';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// ─── Amber hex for sigma canvas (oklch → hex approximation) ───────────────────
const AMBER   = '#e8b659';
const DIM_BG  = '#0e1425'; // near sky-2, very dark, for dimmed nodes

// ─── Module-level state ───────────────────────────────────────────────────────
let renderer  = null;
let graph     = null;
let graphData = null;
let nodeDataMap = {};

// Anchored layout internals
let anchorHomePositions = {};
let anchorVelocities    = {};
let anchorAlpha         = 0;
let anchorFrameId       = null;
let anchorDraggedNode   = null;

const state = {
  selectedNode: null,
  neighbors:    new Set(),
  searchQuery:  '',
  hoveredNode:  null,
  activeGroup:  null,       // { mode, value } | null
  viewByMode:   'topic',
};

// ─── Group key mapping ────────────────────────────────────────────────────────
function groupKey(mode) {
  if (mode === 'speaker') return 'speaker';
  if (mode === 'year')    return 'year';
  return 'topic_label';
}

function isDimmed(nodeId) {
  const d = nodeDataMap[nodeId];
  if (!d) return false;
  const matchesSearch = !state.searchQuery || d.searchText.includes(state.searchQuery.toLowerCase());
  const inGroup = !state.activeGroup || d[groupKey(state.activeGroup.mode)] === state.activeGroup.value;
  return !matchesSearch || !inGroup;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function populateStats(data) {
  const speakers = new Set(data.nodes.map(n => n.speaker).filter(Boolean));
  document.getElementById('stat-talks').textContent    = data.nodes.length;
  document.getElementById('stat-speakers').textContent = speakers.size;
  document.getElementById('stat-links').textContent    = data.edges.length;
}

// ─── Legend (topic colors, always topic-based) ────────────────────────────────
function buildLegend(nodes) {
  const seen = new Map();
  for (const n of nodes) {
    if (n.topic_id !== -1 && !seen.has(n.topic_id)) {
      seen.set(n.topic_id, { label: n.topic_label, color: n.color });
    }
  }
  const entries = [...seen.entries()].sort((a, b) => a[0] - b[0]);
  const el = document.getElementById('legend');
  el.innerHTML = '';
  for (const [, { label, color }] of entries) {
    const key = document.createElement('div');
    key.className = 'key';
    key.innerHTML = `<span class="sw" style="background:${color}"></span>${label}`;
    el.appendChild(key);
  }
}

// ─── Chip rail ────────────────────────────────────────────────────────────────
function buildRail() {
  const mode  = state.viewByMode;
  const gk    = groupKey(mode);
  const label = { topic: 'Topics', speaker: 'Speakers', year: 'Years' }[mode] || 'Topics';
  document.getElementById('chip-label-text').textContent = label;

  const counts = {};
  for (const d of Object.values(nodeDataMap)) {
    const v = d[gk] || 'unknown';
    counts[v] = (counts[v] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  const cloud = document.getElementById('chip-cloud');
  cloud.innerHTML = '';

  for (const [value, count] of entries) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const isActive = state.activeGroup?.mode === mode && state.activeGroup?.value === value;
    if (isActive) chip.classList.add('on');
    chip.innerHTML = `${value} <span class="ct">${count}</span>`;
    chip.addEventListener('click', () => {
      if (state.activeGroup?.mode === mode && state.activeGroup?.value === value) {
        state.activeGroup = null;
      } else {
        state.activeGroup = { mode, value };
      }
      buildRail();
      if (renderer) renderer.refresh();
    });
    cloud.appendChild(chip);
  }
}

// ─── Select a node (used by renderer events and nearby-stars clicks) ──────────
function selectNode(nodeId) {
  state.selectedNode = nodeId;
  state.neighbors    = graph ? new Set(graph.neighbors(nodeId)) : new Set();
  if (renderer) renderer.refresh();
  showDetail(nodeDataMap[nodeId]);
}

// ─── UMAP coordinate rescaling ────────────────────────────────────────────────
function rescaleCoords(nodes) {
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  return nodes.map(n => ({
    ...n,
    scaledX:  (n.x - xMin) / xRange,
    scaledY:  (n.y - yMin) / yRange,
  }));
}

// ─── Anchored spring tick ─────────────────────────────────────────────────────
function tickAnchored() {
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
  const damping        = 0.85;

  graph.forEachNode(node => {
    if (node === anchorDraggedNode) return;
    const pos  = { x: graph.getNodeAttribute(node, 'x'), y: graph.getNodeAttribute(node, 'y') };
    const home = anchorHomePositions[node];
    const vel  = anchorVelocities[node];
    vel.x = (vel.x + (home.x - pos.x) * anchorStrength) * damping;
    vel.y = (vel.y + (home.y - pos.y) * anchorStrength) * damping;
    graph.setNodeAttribute(node, 'x', pos.x + vel.x);
    graph.setNodeAttribute(node, 'y', pos.y + vel.y);
  });

  anchorAlpha *= 0.95;
  if (renderer) renderer.refresh();
  anchorFrameId = requestAnimationFrame(tickAnchored);
}

// ─── Main graph initialisation ────────────────────────────────────────────────
function getLayout() {
  const pill = document.querySelector('.layout-pill.on');
  return pill?.dataset.layout || 'anchored';
}

function init() {
  const layout = getLayout();

  if (anchorFrameId) { cancelAnimationFrame(anchorFrameId); anchorFrameId = null; }
  anchorAlpha       = 0;
  anchorDraggedNode = null;

  if (renderer) { renderer.kill(); renderer = null; }

  const { nodes, edges } = graphData;
  const scaled = rescaleCoords(nodes);

  nodeDataMap = {};
  scaled.forEach(n => {
    nodeDataMap[n.id] = {
      ...n,
      year: n.date ? String(n.date).slice(0, 4) : 'unknown',
      searchText: [n.title, n.abstract, n.speaker, n.topic_label]
        .filter(Boolean).join(' ').toLowerCase(),
    };
  });

  graph = new Graph({ type: 'undirected', multi: false });

  scaled.forEach(n => {
    const attrs = { label: n.title, size: 7, color: n.color };
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
        color: 'rgba(239,230,207,0.10)',
        size:  Math.max(0.5, (e.weight - 0.75) * 5),
      });
    }
  });

  // Layout computation
  if (layout === 'force') {
    circular.assign(graph);
    if (graph.order <= 500) {
      forceAtlas2.assign(graph, {
        iterations: 150,
        settings: { ...forceAtlas2.inferSettings(graph), gravity: 1, scalingRatio: 2 },
      });
    } else {
      import('graphology-layout-forceatlas2/worker').then(({ default: FA2Layout }) => {
        const fa2 = new FA2Layout(graph, { settings: { gravity: 1, scalingRatio: 2 } });
        fa2.start();
        setTimeout(() => { fa2.stop(); if (renderer) renderer.refresh(); }, 3000);
      });
    }
  } else if (layout === 'dynamic') {
    import('graphology-layout-forceatlas2/worker').then(({ default: FA2Layout }) => {
      const fa2 = new FA2Layout(graph, {
        settings: { ...forceAtlas2.inferSettings(graph), gravity: 0.5, scalingRatio: 2 },
      });
      fa2.start();
      setTimeout(() => fa2.stop(), 1000);
    });
  } else if (layout === 'anchored') {
    anchorHomePositions = {};
    anchorVelocities    = {};
    scaled.forEach(n => {
      anchorHomePositions[n.id] = { x: n.scaledX, y: n.scaledY };
      anchorVelocities[n.id]    = { x: 0, y: 0 };
    });
  }

  const container = document.getElementById('graph-container');

  renderer = new Sigma(graph, container, {
    labelRenderedSizeThreshold: 6,
    labelFont:   'Cormorant Garamond, Times New Roman, serif',
    labelColor:  { color: '#d7cdb3' },
    labelSize:   13,
    defaultEdgeColor: 'rgba(239,230,207,0.10)',

    nodeReducer(node, attrs) {
      const res = { ...attrs };

      const isSelected = node === state.selectedNode;
      const isNeighbor = state.neighbors.has(node);
      const dimmed     = !isSelected && !isNeighbor && isDimmed(node);

      // Label: only on hover
      res.label = node === state.hoveredNode ? attrs.label : undefined;

      if (isSelected) {
        res.color       = AMBER;
        res.size        = 12;
        res.highlighted = true;
        return res;
      }

      if (isNeighbor) {
        res.highlighted = true;
        return res;
      }

      if (dimmed) {
        res.color  = DIM_BG;
        res.zIndex = -1;
      }

      return res;
    },

    edgeReducer(edge, attrs) {
      const res  = { ...attrs };
      const src  = graph.source(edge);
      const tgt  = graph.target(edge);
      const srcDimmed = isDimmed(src) && src !== state.selectedNode && !state.neighbors.has(src);
      const tgtDimmed = isDimmed(tgt) && tgt !== state.selectedNode && !state.neighbors.has(tgt);

      if (srcDimmed || tgtDimmed) {
        res.color = 'rgba(239,230,207,0.02)';
        return res;
      }

      if (state.selectedNode) {
        const connected = src === state.selectedNode || tgt === state.selectedNode;
        res.color = connected ? 'rgba(232,182,89,0.5)' : 'rgba(239,230,207,0.06)';
        if (connected) res.size = Math.max(attrs.size, 1.2);
      }

      return res;
    },
  });

  // ── Sigma events ──────────────────────────────────────────────────────────
  renderer.on('enterNode', ({ node }) => {
    state.hoveredNode = node;
    renderer.refresh();
  });
  renderer.on('leaveNode', () => {
    state.hoveredNode = null;
    renderer.refresh();
  });
  renderer.on('clickNode', ({ node }) => {
    selectNode(node);
  });
  renderer.on('clickStage', () => {
    state.selectedNode = null;
    state.neighbors    = new Set();
    renderer.refresh();
    clearPanel();
  });

  // ── Dynamic layout drag ───────────────────────────────────────────────────
  if (layout === 'dynamic') {
    let dragLayout = null;
    renderer.on('downNode', () => {
      import('graphology-layout-forceatlas2/worker').then(({ default: FA2Layout }) => {
        if (!dragLayout) dragLayout = new FA2Layout(graph, { settings: forceAtlas2.inferSettings(graph) });
        dragLayout.start();
      });
    });
    container.addEventListener('mouseup', () => {
      if (dragLayout) setTimeout(() => dragLayout.stop(), 1500);
    });
  }

  // ── Anchored drag ─────────────────────────────────────────────────────────
  if (layout === 'anchored') {
    let isDragging = false;
    let downPos    = null;
    const DRAG_THRESHOLD = 6;
    const captor = renderer.getMouseCaptor();

    renderer.on('downNode', ({ node, event }) => {
      anchorDraggedNode = node;
      isDragging = false;
      downPos    = { x: event.x, y: event.y };
    });

    captor.on('mousemovebody', (e) => {
      if (!anchorDraggedNode || !downPos) return;
      const dx = e.x - downPos.x, dy = e.y - downPos.y;
      if (!isDragging && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      isDragging = true;
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
      const pos = renderer.viewportToGraph(e);
      graph.setNodeAttribute(anchorDraggedNode, 'x', pos.x);
      graph.setNodeAttribute(anchorDraggedNode, 'y', pos.y);
      if (!anchorFrameId) {
        anchorAlpha    = 1.0;
        anchorFrameId  = requestAnimationFrame(tickAnchored);
      }
    });

    captor.on('mouseup', () => {
      const wasDragging = isDragging;
      anchorDraggedNode = null;
      isDragging        = false;
      downPos           = null;
      if (wasDragging) {
        anchorAlpha = 1.0;
        if (!anchorFrameId) anchorFrameId = requestAnimationFrame(tickAnchored);
      }
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────
  const searchEl = document.getElementById('search');
  searchEl.oninput = (e) => {
    state.searchQuery = e.target.value;
    if (renderer) renderer.refresh();
  };
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function getNearby(nodeId, limit = 5) {
  if (!graphData) return [];
  const linked = graphData.edges
    .filter(e => e.source === nodeId || e.target === nodeId)
    .map(e => {
      const otherId = e.source === nodeId ? e.target : e.source;
      return { node: nodeDataMap[otherId], weight: e.weight };
    })
    .filter(x => x.node)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  return linked;
}

function showDetail(node) {
  if (!node) return;
  document.getElementById('placeholder-msg').style.display  = 'none';
  document.getElementById('detail-content').style.display   = 'block';

  // Index
  const idx = graphData.nodes.findIndex(n => n.id === node.id);
  document.getElementById('d-idx').textContent       = idx >= 0 ? String(idx + 1).padStart(3, '0') : '—';
  document.getElementById('d-head-date').textContent = node.date || '';

  // Topic badge
  const topicsEl = document.getElementById('d-topics');
  topicsEl.innerHTML = '';
  if (node.topic_label) {
    const badge = document.createElement('span');
    badge.className = 'd-topic primary';
    badge.textContent = node.topic_label;
    topicsEl.appendChild(badge);
  }

  // Title, speaker, date
  document.getElementById('d-title').textContent   = node.title || '';
  document.getElementById('d-speaker').textContent = node.speaker || '';
  document.getElementById('d-date').textContent    = node.date || '';

  // Video link
  const videoEl = document.getElementById('d-video');
  if (node.video_url) {
    videoEl.href         = node.video_url;
    videoEl.style.display = 'flex';
  } else {
    videoEl.style.display = 'none';
  }

  // Abstract with drop cap
  const abstract = node.abstract || '';
  const abstractEl = document.getElementById('d-abstract');
  if (abstract) {
    const first = abstract.charAt(0);
    const rest  = abstract.slice(1);
    abstractEl.innerHTML = `<p><span class="drop">${first}</span>${rest}</p>`;
  } else {
    abstractEl.innerHTML = '';
  }

  // Nearby stars
  const nearby    = getNearby(node.id);
  const nearbyEl  = document.getElementById('d-nearby');
  nearbyEl.innerHTML = '';
  if (nearby.length === 0) {
    nearbyEl.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--cream-4)">no linked talks</div>';
  } else {
    for (const { node: other, weight } of nearby) {
      const item = document.createElement('div');
      item.className = 'nearby-item';
      item.innerHTML = `
        <span class="w">${weight.toFixed(2)}</span>
        <div>
          <div class="ttl">${other.title || ''}</div>
          <div class="sp">${other.speaker || ''}</div>
        </div>`;
      item.addEventListener('click', () => selectNode(other.id));
      nearbyEl.appendChild(item);
    }
  }
}

function clearPanel() {
  document.getElementById('placeholder-msg').style.display = 'block';
  document.getElementById('detail-content').style.display  = 'none';
}

// ─── Layout pills ─────────────────────────────────────────────────────────────
function setupLayoutPills() {
  const pills = document.querySelectorAll('.layout-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('on'));
      pill.classList.add('on');
      state.selectedNode = null;
      state.neighbors    = new Set();
      clearPanel();
      init();
    });
  });
}

// ─── Zoom buttons ─────────────────────────────────────────────────────────────
function setupZoom() {
  document.getElementById('zoom-in').addEventListener('click', () => {
    renderer?.getCamera().animatedZoom({ duration: 200 });
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    renderer?.getCamera().animatedUnzoom({ duration: 200 });
  });
  document.getElementById('zoom-fit').addEventListener('click', () => {
    renderer?.getCamera().animatedReset({ duration: 300 });
  });
}

// ─── View-by mode ─────────────────────────────────────────────────────────────
function setupViewBy() {
  document.querySelectorAll('.view-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      state.viewByMode  = opt.dataset.mode;
      state.activeGroup = null;
      document.querySelectorAll('.view-opt').forEach(o => o.classList.remove('on'));
      opt.classList.add('on');
      buildRail();
      if (renderer) renderer.refresh();
    });
  });

  document.getElementById('chip-clear').addEventListener('click', () => {
    state.activeGroup = null;
    buildRail();
    if (renderer) renderer.refresh();
  });
}

// ─── "Cast your eye" shortcuts ────────────────────────────────────────────────
function setupCast() {
  document.getElementById('cast-random').addEventListener('click', () => {
    const ids = Object.keys(nodeDataMap);
    if (!ids.length) return;
    selectNode(ids[Math.floor(Math.random() * ids.length)]);
    renderer?.getCamera().animatedReset({ duration: 300 });
  });

  document.getElementById('cast-connected').addEventListener('click', () => {
    if (!graph) return;
    let best = null, bestDeg = -1;
    graph.forEachNode(node => {
      const deg = graph.degree(node);
      if (deg > bestDeg) { best = node; bestDeg = deg; }
    });
    if (best) selectNode(best);
  });

  document.getElementById('cast-orphan').addEventListener('click', () => {
    if (!graph) return;
    let best = null, bestDeg = Infinity;
    graph.forEachNode(node => {
      const deg = graph.degree(node);
      if (deg < bestDeg) { best = node; bestDeg = deg; }
    });
    if (best) selectNode(best);
  });
}

// ─── Keyboard shortcut (⌘K / Ctrl+K → focus search) ─────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function loadData() {
  const res = await fetch(import.meta.env.BASE_URL + 'graph_data.json');
  graphData = await res.json();

  // Build nodeDataMap early so buildRail() has data before init() runs
  graphData.nodes.forEach(n => {
    nodeDataMap[n.id] = {
      ...n,
      year: n.date ? String(n.date).slice(0, 4) : 'unknown',
      searchText: [n.title, n.abstract, n.speaker, n.topic_label]
        .filter(Boolean).join(' ').toLowerCase(),
    };
  });

  populateStats(graphData);
  buildLegend(graphData.nodes);
  setupLayoutPills();
  setupZoom();
  setupViewBy();
  setupCast();
  setupKeyboard();
  buildRail();
  init(); // rebuilds nodeDataMap with scaled coords
}

loadData().catch(err => console.error('Failed to load graph data:', err));
