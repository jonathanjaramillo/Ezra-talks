let graphData = null;
let network = null;
let nodesDataset = null;
let edgesDataset = null;
let nodeDataMap = {};
let selectedNode = null;
let neighbors = new Set();
let searchQuery = '';

let homePositions = {};
let anchorVelocities = {};
let anchorAlpha = 0;
let anchorFrameId = null;
let anchoredDraggedNode = null;

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

function tickAnchored() {
  if (anchorAlpha <= 0.001) {
    Object.keys(homePositions).forEach(id => {
      if (String(id) !== String(anchoredDraggedNode)) {
        network.moveNode(id, homePositions[id].x, homePositions[id].y);
        anchorVelocities[id] = { x: 0, y: 0 };
      }
    });
    anchorFrameId = null;
    return;
  }

  const allPos = network.getPositions();
  const anchorStrength = 0.08;
  const damping = 0.85;

  Object.keys(homePositions).forEach(id => {
    if (String(id) === String(anchoredDraggedNode)) return;
    const pos = allPos[id];
    if (!pos) return;
    const home = homePositions[id];
    const vel = anchorVelocities[id];
    vel.x = (vel.x + (home.x - pos.x) * anchorStrength) * damping;
    vel.y = (vel.y + (home.y - pos.y) * anchorStrength) * damping;
    network.moveNode(id, pos.x + vel.x, pos.y + vel.y);
  });

  anchorAlpha *= 0.95;
  anchorFrameId = requestAnimationFrame(tickAnchored);
}

async function loadData() {
  const res = await fetch('../../graph_data.json');
  graphData = await res.json();
  buildLegend(graphData.nodes);
  setupToggle();
  setupSearch();
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
    selectedNode = null;
    neighbors = new Set();
    searchQuery = '';
    document.getElementById('search').value = '';
    clearPanel();
    init();
  });
}

function setupSearch() {
  document.getElementById('search').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    updateAppearances();
  });
}

function rescaleCoords(nodes) {
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xMid = (xMin + xMax) / 2, xSpan = xMax - xMin;
  const yMid = (yMin + yMax) / 2, ySpan = yMax - yMin;
  return nodes.map(n => ({
    ...n,
    scaledX: (n.x - xMid) / xSpan * 800,
    scaledY: -((n.y - yMid) / ySpan * 800), // negate y: vis-network y grows downward
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
  anchoredDraggedNode = null;

  if (network) {
    network.destroy();
    network = null;
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

  const visNodes = scaled.map(n => {
    const item = {
      id: n.id,
      label: '',
      title: `<strong>${n.title}</strong><br><em>${n.speaker || ''}</em>`,
      color: {
        background: n.color,
        border: '#666',
        highlight: { background: n.color, border: '#222' },
        hover: { background: n.color, border: '#444' },
      },
      borderWidth: 1,
      borderWidthSelected: 3,
      font: { size: 10, color: '#222' },
      shape: 'dot',
      size: 10,
    };
    if (layout === 'umap' || layout === 'dynamic' || layout === 'anchored') {
      item.x = n.scaledX;
      item.y = n.scaledY;
    }
    if (layout === 'umap') {
      item.physics = false;
    }
    return item;
  });

  const visEdges = edges.map(e => ({
    id: e.source + '__' + e.target,
    from: e.source,
    to: e.target,
    width: Math.max(0.5, e.weight * 3),
    color: { color: '#cccccc', opacity: 0.5 },
    smooth: { enabled: true, type: 'continuous' },
  }));

  nodesDataset = new vis.DataSet(visNodes);
  edgesDataset = new vis.DataSet(visEdges);

  if (layout === 'anchored') {
    homePositions = {};
    anchorVelocities = {};
    scaled.forEach(n => {
      homePositions[n.id] = { x: n.scaledX, y: n.scaledY };
      anchorVelocities[n.id] = { x: 0, y: 0 };
    });
  }

  let options;
  if (layout === 'force') {
    options = {
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 100,
          springConstant: 0.08,
          damping: 0.4,
        },
        stabilization: { iterations: 200 },
      },
    };
  } else if (layout === 'dynamic') {
    options = {
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.005,
          springLength: 100,
          springConstant: 0.05,
          damping: 0.4,
        },
        stabilization: { iterations: 50, updateInterval: 10 },
      },
    };
  } else {
    options = { physics: { enabled: false } };
  }

  options.interaction = { hover: true, tooltipDelay: 200, hideEdgesOnDrag: true };
  options.nodes = { shape: 'dot', size: 10 };
  options.edges = { smooth: { enabled: true, type: 'continuous' } };

  const container = document.getElementById('graph');
  network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, options);

  if (layout === 'force' || layout === 'dynamic') {
    document.getElementById('overlay').classList.add('active');
    network.once('stabilizationIterationsDone', () => {
      document.getElementById('overlay').classList.remove('active');
      network.setOptions({ physics: { enabled: false } });
    });

    network.on('dragStart', () => {
      network.setOptions({ physics: { enabled: true } });
    });
    network.on('dragEnd', () => {
      setTimeout(() => network.setOptions({ physics: { enabled: false } }), 1500);
    });
  }

  if (layout === 'anchored') {
    network.on('dragStart', (params) => {
      if (params.nodes.length > 0) {
        anchoredDraggedNode = params.nodes[0];
      }
      anchorAlpha = 1.0;
      if (anchorFrameId) cancelAnimationFrame(anchorFrameId);
      anchorFrameId = requestAnimationFrame(tickAnchored);
    });

    network.on('dragEnd', () => {
      anchoredDraggedNode = null;
      anchorAlpha = 1.0;
      if (!anchorFrameId) {
        anchorFrameId = requestAnimationFrame(tickAnchored);
      }
    });
  }

  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      selectedNode = nodeId;
      neighbors = new Set(network.getConnectedNodes(nodeId));
      updateAppearances();
      showDetail(nodeDataMap[nodeId]);
    } else if (params.edges.length === 0) {
      selectedNode = null;
      neighbors = new Set();
      updateAppearances();
      clearPanel();
    }
  });
}

function updateAppearances() {
  const query = searchQuery.toLowerCase();

  const nodeUpdates = Object.keys(nodeDataMap).map(id => {
    const data = nodeDataMap[id];
    const matchesSearch = !query || data.searchText.includes(query);
    const isHighlighted = !selectedNode || id === selectedNode || neighbors.has(id);

    const dimmed = !matchesSearch || !isHighlighted;

    return {
      id,
      opacity: !matchesSearch ? 0.08 : !isHighlighted ? 0.55 : 1.0,
      color: dimmed ? {
        background: '#b8b8b8',
        border: '#999999',
        highlight: { background: '#b8b8b8', border: '#999999' },
        hover: { background: '#b8b8b8', border: '#999999' },
      } : {
        background: data.color,
        border: '#666',
        highlight: { background: data.color, border: '#222' },
        hover: { background: data.color, border: '#444' },
      },
    };
  });

  const edgeUpdates = edgesDataset.map(edge => {
    const srcOk = !query || (nodeDataMap[edge.from] && nodeDataMap[edge.from].searchText.includes(query));
    const tgtOk = !query || (nodeDataMap[edge.to] && nodeDataMap[edge.to].searchText.includes(query));
    const srcHl = !selectedNode || edge.from === selectedNode || neighbors.has(edge.from);
    const tgtHl = !selectedNode || edge.to === selectedNode || neighbors.has(edge.to);
    const visible = srcOk && tgtOk && srcHl && tgtHl;
    return { id: edge.id, color: { color: '#cccccc', opacity: visible ? 0.5 : 0.3 } };
  });

  nodesDataset.update(nodeUpdates);
  edgesDataset.update(edgeUpdates);
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
