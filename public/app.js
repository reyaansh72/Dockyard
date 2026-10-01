const state = {
  overview: null,
  containers: [],
  images: [],
  networks: [],
  volumes: [],
  catalog: [],
  catalogCategory: 'All',
  pullController: null,
  selectedContainers: new Set(),
  logRefreshInterval: null,
  refreshIntervalTimer: null,
  session: null,
  authConfigured: false,
  activity: [],
  about: null,
  monitor: [],
  events: [],
  monitorTimer: null,
  monitorSort: 'cpu',
  shellSocket: null,
  shellHistory: [],
  shellHistoryIndex: 0,
  paletteIndex: 0,
  currentPage: 'overview',
  sort: { key: 'created', descending: true },
  refreshing: false,
};

const themes = {
  fern: { label: 'Fern', accent: '#267860', strong: '#175d48', soft: '#e5f2ec', ink: '#164a3a' },
  ocean: { label: 'Ocean', accent: '#39749d', strong: '#285d82', soft: '#e8f1f7', ink: '#254e69' },
  coral: { label: 'Coral', accent: '#bd6251', strong: '#994b3d', soft: '#f8ece7', ink: '#7e4036' },
  marigold: { label: 'Marigold', accent: '#9a7528', strong: '#795b1d', soft: '#f6f0df', ink: '#604817' },
  plum: { label: 'Berry', accent: '#9d5876', strong: '#7c405b', soft: '#f6ebf0', ink: '#633449' },
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Cannot reach Dockyard. Check that the server is running, then reload the page.');
  }
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch { result = text; }
  if (!response.ok) throw new Error(result?.message || result || `Request failed (${response.status})`);
  if (method !== 'GET' && !['/api/login', '/api/logout'].includes(path)) recordActivity(`${method} ${path.split('?')[0]}`);
  return result;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function downloadFile(filename, content, contentType = 'text/plain') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: contentType }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(timestamp || 0)));
  if (!timestamp) return '—';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(Number(timestamp) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortId(id = '') { return String(id).replace(/^sha256:/, '').slice(0, 12); }
function resourceName(container) { return (container.Names?.[0] || container.Name || container.Id || '').replace(/^\//, ''); }
function statusKey(container) { return String(container.State || '').toLowerCase(); }
function statusMarkup(value) {
  const stateName = String(value || 'unknown').toLowerCase();
  const className = stateName === 'running' ? 'running' : stateName === 'paused' ? 'paused' : stateName === 'dead' ? 'dead' : 'exited';
  return `<span class="status-badge ${className}">${escapeHtml(stateName)}</span>`;
}
function portList(ports = []) {
  return ports.filter((port) => port.PublicPort).slice(0, 3).map((port) => `${port.PublicPort}→${port.PrivatePort}`).join(', ') || (ports.length ? `${ports.length} exposed` : '—');
}
function containerImage(container) { return container.Image || container.Config?.Image || '—'; }
function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${kind === 'error' ? 'error' : ''}`;
  element.innerHTML = `<span class="toast-mark">${kind === 'error' ? '!' : '✓'}</span><span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(element);
  window.setTimeout(() => element.remove(), 3900);
}

function setConnection(online, message = '') {
  const pill = $('#connection-pill');
  pill.classList.toggle('online', online);
  pill.classList.toggle('offline', !online);
  pill.querySelector('span:last-child').textContent = online ? 'Engine connected' : 'Engine offline';
  $('#engine-state').textContent = online ? 'Engine connected' : 'Engine offline';
  $$('.engine-led').forEach((led) => {
    led.classList.toggle('online', online);
    led.classList.toggle('offline', !online);
  });
  $('#connection-alert').classList.toggle('hidden', online);
  if (message) $('#connection-message').textContent = message;
  $('#footer-engine').textContent = online ? `Docker Engine · ${state.overview?.version?.Version || 'connected'}` : 'Docker Engine · Offline';
}

function showTableError(target, colspan, message) {
  $(target).innerHTML = `<tr><td colspan="${colspan}" class="table-placeholder error-placeholder">${escapeHtml(message)}</td></tr>`;
}

async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#last-updated').textContent = 'Refreshing…';
  try {
    const [overview, networks, volumes] = await Promise.all([
      api('/api/overview'), api('/api/networks'), api('/api/volumes'),
    ]);
    state.overview = overview;
    state.containers = overview.containers || [];
    state.images = overview.images || [];
    state.networks = networks || [];
    state.volumes = volumes?.Volumes || [];
    setConnection(true);
    renderOverview();
    renderContainers();
    renderImages();
    renderNetworks();
    renderVolumes();
    $('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    $('#engine-version').textContent = `Docker Engine ${overview.version?.Version || ''}`.trim();
    $('#connection-message').textContent = '';
  } catch (error) {
    setConnection(false, error.message.includes('EACCES') || error.message.includes('permission')
      ? 'Docker socket permission denied. Grant this user access to the Docker socket, then retry.'
      : error.message.includes('ENOENT') || error.message.includes('connect')
        ? 'Docker socket was not found. Start Docker Engine or set DOCKER_SOCKET to its socket path.'
        : error.message || 'Check that Docker is running and this user can access the Docker socket.');
    $('#last-updated').textContent = 'Unable to reach engine';
    $('#engine-version').textContent = 'Connection unavailable';
    ['#recent-containers', '#containers-table'].forEach((target) => showTableError(target, target === '#recent-containers' ? 5 : 6, 'Docker Engine is offline. Check the connection and retry.'));
    ['#images-table', '#networks-table', '#volumes-table'].forEach((target) => showTableError(target, target === '#volumes-table' ? 5 : 6, 'Docker Engine is offline. Check the connection and retry.'));
    ['#stat-containers', '#stat-images', '#stat-networks', '#stat-volumes'].forEach((selector) => { $(selector).textContent = '—'; });
  } finally {
    state.refreshing = false;
  }
}

function renderOverview() {
  const info = state.overview.info || {};
  const running = state.containers.filter((container) => statusKey(container) === 'running').length;
  const paused = state.containers.filter((container) => statusKey(container) === 'paused').length;
  const stopped = state.containers.length - running - paused;
  $('#stat-containers').textContent = state.containers.length;
  $('#stat-running').textContent = `${running} running`;
  $('#stat-stopped').textContent = `${stopped + paused} stopped`;
  $('#stat-images').textContent = state.images.length;
  $('#stat-networks').textContent = state.networks.length;
  $('#stat-volumes').textContent = state.volumes.length;
  $('#image-storage').textContent = state.overview.diskUsage?.LayersSize ? `${formatBytes(state.overview.diskUsage.LayersSize)} stored locally` : 'Local image library';
  $('#network-subtitle').textContent = `${state.networks.filter((network) => !['bridge', 'host', 'none'].includes(network.Name)).length} custom networks`;
  $('#volume-subtitle').textContent = `${state.volumes.length} persistent data ${state.volumes.length === 1 ? 'store' : 'stores'}`;
  $('#host-name').textContent = info.Name || '—';
  $('#host-docker-version').textContent = state.overview.version?.Version || '—';
  $('#host-os').textContent = `${info.OperatingSystem || info.OSType || '—'}${info.Architecture ? ` · ${info.Architecture}` : ''}`;
  $('#host-architecture').textContent = info.Architecture || '—';
  $('#host-cpus').textContent = info.NCPU ?? '—';
  $('#host-memory').textContent = info.MemTotal ? formatBytes(info.MemTotal) : '—';
  $('#nav-containers').textContent = state.containers.length;
  $('#nav-images').textContent = state.images.length;
  renderRecent();
  renderChart(running, stopped + paused);
}

function renderRecent() {
  const recent = [...state.containers].sort((a, b) => b.Created - a.Created).slice(0, 5);
  if (!recent.length) {
    $('#recent-containers').innerHTML = '<tr><td colspan="5" class="table-placeholder">No containers yet. Create one or pull an image to get started.</td></tr>';
    return;
  }
  $('#recent-containers').innerHTML = recent.map((container) => `<tr>
    <td><div class="container-name-cell"><span class="resource-glyph">▣</span><span class="resource-name">${escapeHtml(resourceName(container))}</span></div></td>
    <td>${escapeHtml(containerImage(container))}</td><td>${statusMarkup(container.State)}</td><td>${escapeHtml(timeAgo(container.Created))}</td>
    <td><div class="row-actions"><button class="row-action" data-resource-action="logs" data-id="${escapeHtml(container.Id)}" title="View logs" aria-label="View logs">≋</button><button class="row-action" data-resource-action="inspect" data-id="${escapeHtml(container.Id)}" title="Inspect container" aria-label="Inspect container">⌕</button></div></td></tr>`).join('');
}

function renderChart(running, stopped) {
  const chart = $('#chart-bars');
  if (!state.containers.length) {
    chart.innerHTML = '<span class="chart-empty">No container activity yet</span>';
    return;
  }
  chart.innerHTML = Array.from({ length: 12 }, (_, index) => {
    const variation = Math.max(1, (running * 19 + stopped * 5 + index * 7) % 37);
    const runningHeight = running ? Math.min(90, Math.max(9, Math.round((running / Math.max(1, running + stopped)) * (62 + variation)))) : 0;
    const stoppedHeight = stopped ? Math.min(75, Math.max(6, Math.round((stopped / Math.max(1, running + stopped)) * (35 + variation)))) : 0;
    return `<div class="chart-bar-group"><i class="chart-bar running" style="height:${runningHeight}%"></i><i class="chart-bar stopped" style="height:${stoppedHeight}%"></i></div>`;
  }).join('');
}

function containerActions(container) {
  const id = escapeHtml(container.Id);
  const running = statusKey(container) === 'running';
  const paused = statusKey(container) === 'paused';
  const primary = paused
    ? `<button class="row-action" data-resource-action="unpause" data-id="${id}" title="Resume" aria-label="Resume">▶</button>`
    : running
      ? `<button class="row-action" data-resource-action="stop" data-id="${id}" title="Stop" aria-label="Stop">■</button>`
      : `<button class="row-action" data-resource-action="start" data-id="${id}" title="Start" aria-label="Start">▶</button>`;
  return `<div class="row-actions">${primary}${running && !paused ? `<button class="row-action" data-resource-action="pause" data-id="${id}" title="Pause" aria-label="Pause">Ⅱ</button>` : ''}${running ? `<button class="row-action" data-resource-action="shell" data-id="${id}" title="Open shell" aria-label="Open shell">›_</button>` : ''}<button class="row-action" data-resource-action="restart" data-id="${id}" title="Restart" aria-label="Restart">↻</button><details class="row-menu"><summary class="row-action" title="More actions" aria-label="More actions">•••</summary><div class="row-menu-items"><button data-resource-action="shell" data-id="${id}" ${running ? '' : 'disabled'}>Open terminal</button><button data-resource-action="logs" data-id="${id}">View logs</button><button data-resource-action="stats" data-id="${id}">Resource stats</button><button data-resource-action="limits" data-id="${id}">Update limits</button><button data-resource-action="inspect" data-id="${id}">Inspect</button><button data-resource-action="copy-config" data-id="${id}">Download config</button><button data-resource-action="copy-id" data-id="${id}">Copy container ID</button><button data-resource-action="duplicate" data-id="${id}">Duplicate</button><button data-resource-action="kill" data-id="${id}" ${running ? '' : 'disabled'}>Kill</button><button data-resource-action="rename" data-id="${id}">Rename</button><button class="danger" data-resource-action="remove" data-id="${id}">Remove</button></div></details></div>`;
}

function renderContainers() {
  const header = $('#containers-table').closest('table').querySelector('thead tr');
  if (!$('#select-all-containers')) {
    header.insertAdjacentHTML('afterbegin', '<th class="select-column"><input id="select-all-containers" type="checkbox" aria-label="Select all visible containers"></th>');
    $('#select-all-containers').addEventListener('change', (event) => {
      const visibleIds = [...$$('#containers-table [data-container-select]')].map((checkbox) => checkbox.dataset.containerSelect);
      visibleIds.forEach((id) => event.target.checked ? state.selectedContainers.add(id) : state.selectedContainers.delete(id));
      renderContainers();
    });
  }
  const search = ($('#container-search')?.value || '').trim().toLowerCase();
  const filter = $('#container-filter')?.value || 'all';
  const containers = state.containers.filter((container) => {
    const name = resourceName(container).toLowerCase();
    const image = containerImage(container).toLowerCase();
    const stateName = statusKey(container);
    const matchesFilter = filter === 'all' || (filter === 'running' ? stateName === 'running' : stateName !== 'running');
    return matchesFilter && (!search || name.includes(search) || image.includes(search) || container.Id.toLowerCase().includes(search));
  }).sort((a, b) => {
    const left = state.sort.key === 'name' ? resourceName(a).toLowerCase() : a.Created;
    const right = state.sort.key === 'name' ? resourceName(b).toLowerCase() : b.Created;
    return (left > right ? 1 : left < right ? -1 : 0) * (state.sort.descending ? -1 : 1);
  });
  $('#container-count').textContent = `${containers.length} ${containers.length === 1 ? 'container' : 'containers'}`;
  if (!containers.length) {
    $('#containers-table').innerHTML = `<tr><td colspan="7" class="table-placeholder">${state.containers.length ? 'No containers match these filters.' : 'No containers found. Create a container to get started.'}</td></tr>`;
    return;
  }
  $('#containers-table').innerHTML = containers.map((container) => `<tr>
    <td class="select-column"><input type="checkbox" data-container-select="${escapeHtml(container.Id)}" aria-label="Select ${escapeHtml(resourceName(container))}" ${state.selectedContainers.has(container.Id) ? 'checked' : ''}></td>
    <td><div class="container-name-cell"><span class="resource-glyph">▣</span><span><span class="resource-name">${escapeHtml(resourceName(container))}</span><span class="secondary-text">${escapeHtml(shortId(container.Id))}</span></span></div></td>
    <td>${escapeHtml(containerImage(container))}</td><td>${statusMarkup(container.State)}</td><td>${escapeHtml(portList(container.Ports))}</td><td>${escapeHtml(timeAgo(container.Created))}</td><td>${containerActions(container)}</td></tr>`).join('');
  const selectAll = $('#select-all-containers');
  selectAll.checked = containers.length > 0 && containers.every((container) => state.selectedContainers.has(container.Id));
  selectAll.indeterminate = containers.some((container) => state.selectedContainers.has(container.Id)) && !selectAll.checked;
  updateBulkToolbar();
}

function ensureBulkToolbar() {
  if ($('#bulk-toolbar')) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'bulk-toolbar hidden';
  toolbar.id = 'bulk-toolbar';
  toolbar.innerHTML = '<span class="bulk-count" id="bulk-count">0 selected</span><button class="button button-outline" data-bulk-action="start">▶ Start</button><button class="button button-outline" data-bulk-action="stop">■ Stop</button><button class="button button-outline" data-bulk-action="export">↓ Export CSV</button><button class="button button-outline bulk-danger" data-bulk-action="remove">× Remove</button><button class="text-button" data-bulk-action="clear">Clear selection</button>';
  $('#view-containers .toolbar').after(toolbar);
}

function updateBulkToolbar() {
  const bar = $('#bulk-toolbar');
  if (!bar) return;
  const count = state.selectedContainers.size;
  bar.classList.toggle('hidden', !count);
  $('#bulk-count').textContent = `${count} selected`;
}

async function runBulkAction(action) {
  const ids = [...state.selectedContainers];
  if (!ids.length) return;
  if (action === 'clear') {
    state.selectedContainers.clear();
    renderContainers();
    return;
  }
  if (action === 'export') {
    const rows = [['name', 'id', 'image', 'state', 'status', 'ports', 'created']];
    for (const id of ids) {
      const container = state.containers.find((item) => item.Id === id);
      if (container) rows.push([resourceName(container), container.Id, containerImage(container), container.State, container.Status, portList(container.Ports), new Date(container.Created * 1000).toISOString()]);
    }
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `dockyard-containers-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast(`Exported ${rows.length - 1} containers`);
    return;
  }
  if (action === 'remove') {
    openModal({
      title: `Remove ${ids.length} containers?`, eyebrow: 'BULK PERMANENT ACTION', submit: `Remove ${ids.length}`,
      content: '<p class="modal-description">Selected containers are permanently removed. Running containers may fail unless Docker accepts their removal.</p>',
      onSubmit: async () => {
        const results = await Promise.allSettled(ids.map((id) => api(`/api/containers/${encodeURIComponent(id)}/remove?force=1`, { method: 'POST' })));
        const failed = results.filter((result) => result.status === 'rejected').length;
        state.selectedContainers.clear();
        closeModal();
        toast(`${ids.length - failed} removed${failed ? ` · ${failed} failed` : ''}`, failed ? 'error' : 'success');
        await refreshAll();
      },
    });
    return;
  }
  const eligible = ids.filter((id) => {
    const container = state.containers.find((item) => item.Id === id);
    return action === 'start' ? statusKey(container) !== 'running' : statusKey(container) === 'running';
  });
  const results = await Promise.allSettled(eligible.map((id) => api(`/api/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST' })));
  const failed = results.filter((result) => result.status === 'rejected').length;
  toast(`${eligible.length - failed} container actions completed${failed ? ` · ${failed} failed` : ''}`, failed ? 'error' : 'success');
  await refreshAll();
}

function imageRows() {
  const query = ($('#image-search')?.value || '').toLowerCase().trim();
  const images = state.images.filter((image) => `${(image.RepoTags || []).join(' ')} ${image.Id}`.toLowerCase().includes(query));
  $('#image-count').textContent = `${images.length} ${images.length === 1 ? 'image' : 'images'}`;
  if (!images.length) {
    $('#images-table').innerHTML = `<tr><td colspan="6" class="table-placeholder">${state.images.length ? 'No images match your search.' : 'No images found. Pull an image from a registry to get started.'}</td></tr>`;
    return;
  }
  $('#images-table').innerHTML = images.map((image) => {
    const tags = image.RepoTags?.length ? image.RepoTags : ['<none>:<none>'];
    const [repo, tag] = String(tags[0]).split(/:(?=[^/:]+$)/);
    return `<tr><td><div class="container-name-cell"><span class="resource-glyph image-glyph">▤</span><span class="resource-name">${escapeHtml(repo || '<none>')}</span></div></td><td>${escapeHtml(tag || '<none>')}</td><td><code>${escapeHtml(shortId(image.Id))}</code></td><td>${escapeHtml(formatBytes(image.Size))}</td><td>${escapeHtml(timeAgo(image.Created))}</td><td><div class="row-actions"><button class="row-action" data-image-action="run" data-id="${escapeHtml(image.Id)}" title="Create container" aria-label="Create container">▶</button><button class="row-action" data-image-action="inspect" data-id="${escapeHtml(image.Id)}" title="Inspect image" aria-label="Inspect image">⌕</button><button class="row-action" data-image-action="history" data-id="${escapeHtml(image.Id)}" title="Image history" aria-label="Image history">◷</button><button class="row-action" data-image-action="tag" data-id="${escapeHtml(image.Id)}" title="Tag image" aria-label="Tag image">⌑</button><button class="row-action danger" data-image-action="remove" data-id="${escapeHtml(image.Id)}" title="Remove image" aria-label="Remove image">×</button></div></td></tr>`;
  }).join('');
}

function renderImages() { imageRows(); }

function renderNetworks() {
  const search = ($('#network-search')?.value || '').toLowerCase().trim();
  const networks = state.networks.filter((network) => `${network.Name} ${network.Driver} ${network.Id}`.toLowerCase().includes(search));
  $('#network-count').textContent = `${networks.length} ${networks.length === 1 ? 'network' : 'networks'}`;
  if (!networks.length) {
    $('#networks-table').innerHTML = `<tr><td colspan="6" class="table-placeholder">${state.networks.length ? 'No networks match your search.' : 'No networks found.'}</td></tr>`;
    return;
  }
  $('#networks-table').innerHTML = networks.map((network) => {
    const containers = Object.keys(network.Containers || {}).length;
    const subnet = network.IPAM?.Config?.map((config) => config.Subnet).filter(Boolean).join(', ') || '—';
    const protectedNetwork = ['bridge', 'host', 'none'].includes(network.Name);
    return `<tr><td><div class="container-name-cell"><span class="resource-glyph network-glyph">⌘</span><span><span class="resource-name">${escapeHtml(network.Name)}</span><span class="secondary-text">${escapeHtml(shortId(network.Id))}</span></span></div></td><td>${escapeHtml(network.Driver || '—')}</td><td>${escapeHtml(network.Scope || '—')}</td><td>${escapeHtml(subnet)}</td><td>${containers}</td><td><div class="row-actions"><button class="row-action" data-network-action="inspect" data-id="${escapeHtml(network.Id)}" title="Inspect network" aria-label="Inspect network">⌕</button><button class="row-action" data-network-action="connect" data-id="${escapeHtml(network.Id)}" data-name="${escapeHtml(network.Name)}" title="Connect a container" aria-label="Connect a container">↔</button><button class="row-action" data-network-action="disconnect" data-id="${escapeHtml(network.Id)}" data-name="${escapeHtml(network.Name)}" title="Disconnect a container" aria-label="Disconnect a container">⇥</button><button class="row-action danger" data-network-action="remove" data-id="${escapeHtml(network.Id)}" data-name="${escapeHtml(network.Name)}" title="${protectedNetwork ? 'Built-in network' : 'Remove network'}" aria-label="Remove network" ${protectedNetwork ? 'disabled' : ''}>×</button></div></td></tr>`;
  }).join('');
}

function renderVolumes() {
  const search = ($('#volume-search')?.value || '').toLowerCase().trim();
  const volumes = state.volumes.filter((volume) => `${volume.Name} ${volume.Driver} ${volume.Mountpoint}`.toLowerCase().includes(search));
  $('#volume-count').textContent = `${volumes.length} ${volumes.length === 1 ? 'volume' : 'volumes'}`;
  if (!volumes.length) {
    $('#volumes-table').innerHTML = `<tr><td colspan="5" class="table-placeholder">${state.volumes.length ? 'No volumes match your search.' : 'No volumes found. Create a volume to persist container data.'}</td></tr>`;
    return;
  }
  $('#volumes-table').innerHTML = volumes.map((volume) => `<tr><td><div class="container-name-cell"><span class="resource-glyph volume-glyph">◈</span><button class="resource-name link-button" data-volume-action="inspect" data-id="${escapeHtml(volume.Name)}">${escapeHtml(volume.Name)}</button></div></td><td>${escapeHtml(volume.Driver || '—')}</td><td title="${escapeHtml(volume.Mountpoint || '')}"><span class="resource-name">${escapeHtml(volume.Mountpoint || '—')}</span></td><td>${escapeHtml(volume.CreatedAt ? new Date(volume.CreatedAt).toLocaleDateString() : '—')}</td><td><div class="row-actions"><button class="row-action" data-volume-action="inspect" data-id="${escapeHtml(volume.Name)}" title="Inspect volume" aria-label="Inspect volume">⌕</button><button class="row-action danger" data-volume-action="remove" data-id="${escapeHtml(volume.Name)}" title="Remove volume" aria-label="Remove volume">×</button></div></td></tr>`).join('');
}

function setPage(page) {
  const validPage = ['overview', 'containers', 'images', 'networks', 'volumes', 'activity', 'monitor', 'events', 'cleanup', 'settings', 'about'].includes(page) ? page : 'overview';
  state.currentPage = validPage;
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${validPage}`));
  $$('.nav-link[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === validPage));
  const title = validPage.charAt(0).toUpperCase() + validPage.slice(1);
  $('#breadcrumb-current').textContent = title;
  document.title = `${title} · Dockyard`;
  $('#sidebar').classList.remove('open');
  if (validPage === 'containers') renderContainers();
  if (validPage === 'images') renderImages();
  if (validPage === 'networks') renderNetworks();
  if (validPage === 'volumes') renderVolumes();
  if (validPage === 'activity') renderActivity();
  if (validPage === 'settings') syncSettingsForm();
  if (validPage === 'about') renderAbout();
  if (validPage === 'monitor') {
    renderMonitor();
    startMonitorTimer();
  } else if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }
  if (validPage === 'events') renderEvents();
}

function installUtilityViews() {
  const pageContent = $('#page-content');
  if ($('#view-settings')) return;
  pageContent.insertAdjacentHTML('beforeend', `
    <section class="view" id="view-activity">
      <div class="page-heading compact-heading"><div><div class="eyebrow">LOCAL AUDIT TRAIL</div><h1>Activity</h1><p class="heading-subtitle">Recent changes made from this Dockyard browser.</p></div><button class="button button-outline" id="clear-activity">Clear history</button></div>
      <section class="panel list-panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>EVENT</th><th>WHEN</th><th>WORKSPACE</th></tr></thead><tbody id="activity-table"></tbody></table></div><div class="table-footer"><span id="activity-count">0 events</span><span>Stored in this browser only</span></div></section>
    </section>
    <section class="view" id="view-monitor">
      <div class="page-heading compact-heading"><div><div class="eyebrow">LIVE CONTAINER TELEMETRY</div><h1>Resource monitor</h1><p class="heading-subtitle">CPU, memory, and network counters from running containers.</p></div><button class="button button-outline" id="monitor-refresh">↻ Refresh now</button></div>
      <div class="monitor-summary"><article class="settings-section"><span>RUNNING CONTAINERS</span><b id="monitor-running">—</b></article><article class="settings-section"><span>CPU TOTAL</span><b id="monitor-cpu-total">—</b></article><article class="settings-section"><span>MEMORY USED</span><b id="monitor-memory-total">—</b></article><article class="settings-section"><span>NETWORK RX / TX</span><b id="monitor-network-total">—</b></article></div>
      <div class="toolbar monitor-toolbar"><div class="search-field"><span>⌕</span><input id="monitor-search" type="search" placeholder="Filter containers" aria-label="Filter monitor containers"></div><div class="toolbar-right"><select id="monitor-sort" aria-label="Sort resources"><option value="cpu">Sort: CPU</option><option value="memory">Sort: Memory</option><option value="name">Sort: Name</option></select><label class="monitor-auto"><input id="monitor-auto" type="checkbox"> Auto refresh</label></div></div>
      <section class="panel list-panel"><div class="table-wrap"><table class="data-table monitor-table"><thead><tr><th>CONTAINER</th><th>CPU</th><th>MEMORY</th><th>NETWORK RX</th><th>NETWORK TX</th><th>STATE</th></tr></thead><tbody id="monitor-table"></tbody></table></div><div class="table-footer"><span id="monitor-footer">Waiting for Docker Engine</span><span>Stats are sampled when refreshed</span></div></section>
    </section>
    <section class="view" id="view-events">
      <div class="page-heading compact-heading"><div><div class="eyebrow">DOCKER ENGINE JOURNAL</div><h1>Docker events</h1><p class="heading-subtitle">Inspect lifecycle changes emitted by this Engine.</p></div><button class="button button-outline" id="events-export">↓ Export JSON</button></div>
      <div class="toolbar"><div class="search-field"><span>⌕</span><input id="events-search" type="search" placeholder="Filter events" aria-label="Search Docker events"></div><div class="toolbar-right"><select id="events-window" aria-label="Event time range"><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24" selected>Last 24 hours</option><option value="168">Last 7 days</option></select><select id="events-type" aria-label="Filter event type"><option value="all">All resource types</option><option value="container">Containers</option><option value="image">Images</option><option value="network">Networks</option><option value="volume">Volumes</option></select><button class="button button-quiet" id="events-refresh">↻ <span>Refresh</span></button></div></div>
      <section class="panel list-panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>EVENT</th><th>RESOURCE</th><th>TYPE</th><th>TIME</th><th></th></tr></thead><tbody id="events-table"></tbody></table></div><div class="table-footer"><span id="events-count">0 events</span><span>Fetched from Docker Engine</span></div></section>
    </section>
    <section class="view" id="view-settings">
      <div class="page-heading compact-heading"><div><div class="eyebrow">WORKSPACE PREFERENCES</div><h1>Settings</h1><p class="heading-subtitle">Tune color, density, navigation, and refresh behavior.</p></div><button class="button button-outline" id="settings-reset">Reset defaults</button></div>
      <div class="settings-grid">
        <section class="settings-section"><div class="settings-section-head"><span class="settings-icon">◐</span><div><h2>Appearance</h2><p>Color mode and Material color roles</p></div></div>
          <div class="settings-row"><div><b>Color mode</b><small>System follows your device preference.</small></div><select id="setting-mode"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
          <div class="settings-row accent-setting"><div><b>Accent color</b><small>Applied across interactive controls.</small></div><div class="accent-control"><div class="settings-swatches" id="settings-swatches"></div><input id="setting-custom-accent" type="color" aria-label="Choose custom accent color" title="Custom accent"></div></div>
          <div class="settings-row"><div><b>Surface shape</b><small>Corner radius for surfaces and controls.</small></div><select id="setting-shape"><option value="sharp">Tight</option><option value="balanced">Balanced</option><option value="soft">Soft</option></select></div>
        </section>
        <section class="settings-section"><div class="settings-section-head"><span class="settings-icon settings-icon-blue">▤</span><div><h2>Workspace layout</h2><p>Adjust information density and navigation width.</p></div></div>
          <div class="settings-row"><div><b>Information density</b><small>Compact fits more rows on screen.</small></div><select id="setting-density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div>
          <div class="settings-row"><div><b>Sidebar</b><small>Choose the default navigation width.</small></div><select id="setting-sidebar"><option value="expanded">Expanded</option><option value="compact">Compact</option></select></div>
          <div class="settings-row"><div><b>Reduce motion</b><small>Limit transitions and decorative movement.</small></div><label class="switch-control"><input id="setting-motion" type="checkbox"><span></span></label></div>
        </section>
        <section class="settings-section"><div class="settings-section-head"><span class="settings-icon settings-icon-orange">↻</span><div><h2>Refresh & session</h2><p>Manage background updates and local access.</p></div></div>
          <div class="settings-row"><div><b>Automatic refresh</b><small>Refresh Docker resources in the background.</small></div><select id="setting-refresh"><option value="15">Every 15 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every minute</option><option value="0">Off</option></select></div>
          <div class="settings-row"><div><b>Signed in as</b><small id="settings-session-user">Local session</small></div><button class="button button-outline" id="settings-sign-out">Sign out</button></div>
          <div class="settings-row"><div><b>Remember profiles</b><small id="remembered-profile-count">Saved on this browser</small></div><label class="switch-control"><input id="setting-remember-profile" type="checkbox"><span></span></label></div>
          <div class="settings-row"><div><b>Saved accounts</b><small>Remove usernames stored on this device.</small></div><button class="button button-outline" id="clear-profiles">Clear</button></div>
          <p class="settings-security" id="settings-security"></p>
        </section>
      </div>
    </section>
    <section class="view" id="view-about">
      <div class="page-heading compact-heading"><div><div class="eyebrow">DOCKYARD INFORMATION</div><h1>About</h1><p class="heading-subtitle">Build details, local diagnostics, and quick navigation help.</p></div><button class="button button-outline" id="copy-diagnostics">Copy diagnostics</button></div>
      <section class="about-overview panel"><div class="about-product-mark">D</div><div class="about-product-copy"><h2>Dockyard</h2><p>A local-first control surface for Docker Engine.</p><span class="about-version" id="about-version">Loading app version…</span></div><span class="about-local-badge">LOCAL WORKSPACE</span></section>
      <div class="settings-grid about-grid"><section class="settings-section"><div class="settings-section-head"><span class="settings-icon">⌂</span><div><h2>Runtime diagnostics</h2><p>Current Dockyard server environment</p></div></div><div class="about-kv" id="about-diagnostics"><div class="table-placeholder">Loading diagnostics…</div></div></section><section class="settings-section"><div class="settings-section-head"><span class="settings-icon settings-icon-blue">⌘</span><div><h2>Keyboard shortcuts</h2><p>Jump directly to common work</p></div></div><div class="shortcut-list"><div><span>Open command palette</span><kbd>Ctrl / ⌘ K</kbd></div><div><span>Focus current-page search</span><kbd>/</kbd></div><div><span>Close dialog or palette</span><kbd>Esc</kbd></div><div><span>Move through palette actions</span><kbd>↑ ↓ ↵</kbd></div></div><button class="button button-outline about-command-button" data-command-open>Open command palette <span>⌘K</span></button></section></div>
      <p class="about-security-note"><span>i</span><span>Docker socket access is highly privileged. Keep Dockyard bound to loopback and configure <code>DOCKYARD_PASSWORD</code> before exposing it through a network or proxy.</span></p>
    </section>`);
  const swatches = $('#settings-swatches');
  swatches.innerHTML = Object.entries(themes).map(([name, theme]) => `<button class="settings-swatch" data-setting-theme="${name}" style="--swatch:${theme.accent}" title="${theme.label}" aria-label="${theme.label} accent"></button>`).join('');
  $('#setting-mode').addEventListener('change', (event) => { applyColorMode(event.target.value); applyStoredAccent(); });
  $('#setting-density').addEventListener('change', (event) => { document.documentElement.dataset.density = event.target.value; localStorage.setItem('dockyard-density', event.target.value); });
  $('#setting-sidebar').addEventListener('change', (event) => { applySidebarMode(event.target.value); });
  $('#setting-motion').addEventListener('change', (event) => { document.documentElement.dataset.motion = event.target.checked ? 'reduced' : 'full'; localStorage.setItem('dockyard-motion', event.target.checked ? 'reduced' : 'full'); });
  $('#setting-shape').addEventListener('change', (event) => { applyShape(event.target.value); });
  $('#setting-refresh').addEventListener('change', (event) => { applyRefreshInterval(Number(event.target.value)); });
  $('#setting-custom-accent').addEventListener('input', (event) => applyCustomAccent(event.target.value));
  $$('[data-setting-theme]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.settingTheme)));
  $('#settings-reset').addEventListener('click', resetSettings);
  $('#settings-sign-out').addEventListener('click', signOut);
  $('#setting-remember-profile').addEventListener('change', (event) => {
    localStorage.setItem('dockyard-remember-profile', String(event.target.checked));
    $('#remember-user').checked = event.target.checked;
    if (!event.target.checked) {
      localStorage.removeItem('dockyard-last-user');
      localStorage.removeItem('dockyard-saved-profiles');
      renderSavedProfiles();
    }
    syncSettingsForm();
  });
  $('#clear-profiles').addEventListener('click', () => {
    localStorage.removeItem('dockyard-last-user');
    localStorage.removeItem('dockyard-saved-profiles');
    renderSavedProfiles();
    syncSettingsForm();
    toast('Saved profiles cleared');
  });
  $('#clear-activity').addEventListener('click', () => { state.activity = []; localStorage.removeItem('dockyard-activity'); renderActivity(); });
  $('#copy-diagnostics').addEventListener('click', copyDiagnostics);
  $('[data-command-open]').addEventListener('click', () => openCommandPalette());
  $('#monitor-refresh').addEventListener('click', renderMonitor);
  $('#monitor-search').addEventListener('input', renderMonitorTable);
  $('#monitor-sort').addEventListener('change', (event) => { state.monitorSort = event.target.value; renderMonitorTable(); });
  $('#monitor-auto').addEventListener('change', () => startMonitorTimer());
  $('#events-refresh').addEventListener('click', renderEvents);
  $('#events-search').addEventListener('input', renderEventsTable);
  $('#events-type').addEventListener('change', renderEventsTable);
  $('#events-window').addEventListener('change', renderEvents);
  $('#events-export').addEventListener('click', exportEvents);
}

async function renderAbout() {
  $('#about-diagnostics').innerHTML = '<div class="table-placeholder">Loading diagnostics…</div>';
  try {
    state.about = await api('/api/about');
    $('#about-version').textContent = `Version ${state.about.version}`;
    const values = [
      ['Runtime', `${state.about.node} · ${state.about.platform}`],
      ['Docker API', state.about.dockerApi],
      ['Docker socket', state.about.socketConfigured ? 'Path configured' : 'Not configured'],
      ['Engine connection', $('#connection-pill').classList.contains('online') ? 'Connected' : 'Unavailable'],
      ['Password sign-in', state.about.passwordAuth ? 'Enabled' : 'Local preview mode'],
      ['Bind address', state.about.bindAddress],
    ];
    $('#about-diagnostics').innerHTML = values.map(([label, value]) => `<div class="about-kv-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
  } catch (error) {
    $('#about-diagnostics').innerHTML = `<div class="table-placeholder error-placeholder">${escapeHtml(error.message)}</div>`;
  }
}

async function copyDiagnostics() {
  if (!state.about) await renderAbout();
  const diagnostics = state.about ? JSON.stringify(state.about, null, 2) : 'Dockyard diagnostics unavailable';
  try { await navigator.clipboard.writeText(diagnostics); toast('Diagnostics copied'); }
  catch { openOutput('Dockyard diagnostics', 'ABOUT', diagnostics); }
}

function monitorMetrics(stats = {}) {
  const cpu = stats.cpu_stats || {};
  const previousCpu = stats.precpu_stats || {};
  const cpuDelta = Number(cpu.cpu_usage?.total_usage || 0) - Number(previousCpu.cpu_usage?.total_usage || 0);
  const systemDelta = Number(cpu.system_cpu_usage || 0) - Number(previousCpu.system_cpu_usage || 0);
  const cpuCount = Number(cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1);
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? cpuDelta / systemDelta * cpuCount * 100 : 0;
  const memory = stats.memory_stats || {};
  const inactive = Number(memory.stats?.inactive_file || memory.stats?.total_inactive_file || 0);
  const memoryUsed = Math.max(0, Number(memory.usage || 0) - inactive);
  const memoryLimit = Number(memory.limit || 0);
  const interfaces = Object.values(stats.networks || {});
  const rx = interfaces.reduce((sum, network) => sum + Number(network.rx_bytes || 0), 0);
  const tx = interfaces.reduce((sum, network) => sum + Number(network.tx_bytes || 0), 0);
  return { cpuPercent, memoryUsed, memoryLimit, rx, tx };
}

async function renderMonitor() {
  $('#monitor-table').innerHTML = '<tr><td colspan="6" class="table-placeholder">Sampling running containers…</td></tr>';
  try {
    const result = await api('/api/monitor');
    state.monitor = (result.items || []).map((item) => ({ ...item, metrics: monitorMetrics(item.stats || {}) }));
    const cpuTotal = state.monitor.reduce((sum, item) => sum + item.metrics.cpuPercent, 0);
    const memoryTotal = state.monitor.reduce((sum, item) => sum + item.metrics.memoryUsed, 0);
    const rxTotal = state.monitor.reduce((sum, item) => sum + item.metrics.rx, 0);
    const txTotal = state.monitor.reduce((sum, item) => sum + item.metrics.tx, 0);
    $('#monitor-running').textContent = state.monitor.length;
    $('#monitor-cpu-total').textContent = `${cpuTotal.toFixed(1)}%`;
    $('#monitor-memory-total').textContent = formatBytes(memoryTotal);
    $('#monitor-network-total').textContent = `${formatBytes(rxTotal)} / ${formatBytes(txTotal)}`;
    $('#monitor-footer').textContent = result.truncated ? 'Showing first 40 containers' : `Sampled ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    renderMonitorTable();
  } catch (error) {
    state.monitor = [];
    ['#monitor-running', '#monitor-cpu-total', '#monitor-memory-total', '#monitor-network-total'].forEach((selector) => { $(selector).textContent = '—'; });
    $('#monitor-footer').textContent = 'Docker Engine is unavailable';
    $('#monitor-table').innerHTML = `<tr><td colspan="6" class="table-placeholder error-placeholder">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderMonitorTable() {
  const query = ($('#monitor-search')?.value || '').toLowerCase().trim();
  const items = state.monitor.filter(({ container }) => `${resourceName(container)} ${container.Image || ''}`.toLowerCase().includes(query));
  items.sort((left, right) => {
    if (state.monitorSort === 'name') return resourceName(left.container).localeCompare(resourceName(right.container));
    const key = state.monitorSort === 'memory' ? 'memoryUsed' : 'cpuPercent';
    return right.metrics[key] - left.metrics[key];
  });
  if (!items.length) {
    $('#monitor-table').innerHTML = `<tr><td colspan="6" class="table-placeholder">${state.monitor.length ? 'No containers match this filter.' : 'No running containers to sample.'}</td></tr>`;
    return;
  }
  $('#monitor-table').innerHTML = items.map(({ container, metrics }) => {
    const memoryRatio = metrics.memoryLimit ? Math.min(100, metrics.memoryUsed / metrics.memoryLimit * 100) : 0;
    const cpuRatio = Math.min(100, metrics.cpuPercent);
    return `<tr><td><div class="container-name-cell"><span class="resource-glyph">▣</span><span><span class="resource-name">${escapeHtml(resourceName(container))}</span><span class="secondary-text">${escapeHtml(container.Image || shortId(container.Id))}</span></span></div></td><td><div class="metric-cell"><b>${metrics.cpuPercent.toFixed(1)}%</b><span class="metric-track"><i style="width:${cpuRatio}%"></i></span></div></td><td><div class="metric-cell"><b>${escapeHtml(formatBytes(metrics.memoryUsed))}${metrics.memoryLimit ? ` / ${escapeHtml(formatBytes(metrics.memoryLimit))}` : ''}</b><span class="metric-track memory-track"><i style="width:${memoryRatio}%"></i></span></div></td><td>${escapeHtml(formatBytes(metrics.rx))}</td><td>${escapeHtml(formatBytes(metrics.tx))}</td><td>${statusMarkup(container.State)}</td></tr>`;
  }).join('');
}

function startMonitorTimer() {
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  state.monitorTimer = null;
  if ($('#monitor-auto')?.checked) state.monitorTimer = window.setInterval(() => { if (state.currentPage === 'monitor') renderMonitor(); }, 5000);
}

async function renderEvents() {
  const hours = Number($('#events-window').value || 24);
  const since = Math.floor(Date.now() / 1000) - hours * 60 * 60;
  $('#events-table').innerHTML = '<tr><td colspan="5" class="table-placeholder">Loading Docker events…</td></tr>';
  try {
    const result = await api(`/api/events?since=${since}`);
    state.events = result.events || [];
    renderEventsTable();
  } catch (error) {
    state.events = [];
    $('#events-count').textContent = '0 events';
    $('#events-table').innerHTML = `<tr><td colspan="5" class="table-placeholder error-placeholder">${escapeHtml(error.message)}</td></tr>`;
  }
}

function eventTimestamp(event) {
  const timestamp = Number(event.time || event.Time || Math.floor(Number(event.timeNano || event.TimeNano || 0) / 1e9));
  return timestamp ? new Date(timestamp * 1000) : null;
}

function renderEventsTable() {
  const query = ($('#events-search')?.value || '').toLowerCase().trim();
  const type = ($('#events-type')?.value || 'all').toLowerCase();
  const events = state.events.filter((event) => {
    const attributes = event.Actor?.Attributes || {};
    const searchText = `${event.Action || event.status || ''} ${event.Type || ''} ${event.Actor?.ID || ''} ${Object.values(attributes).join(' ')}`.toLowerCase();
    return (type === 'all' || String(event.Type || '').toLowerCase() === type) && (!query || searchText.includes(query));
  }).sort((a, b) => (eventTimestamp(b)?.getTime() || 0) - (eventTimestamp(a)?.getTime() || 0));
  $('#events-count').textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  $('#events-table').innerHTML = events.length ? events.map((event) => {
    const attributes = event.Actor?.Attributes || {};
    const name = attributes.name || attributes.image || event.Actor?.ID?.slice(0, 12) || 'Docker Engine';
    const date = eventTimestamp(event);
    return `<tr><td><div class="event-action"><span class="event-type-mark">${escapeHtml((event.Type || 'D').slice(0, 1).toUpperCase())}</span><b>${escapeHtml(event.Action || event.status || 'event')}</b></div></td><td>${escapeHtml(name)}</td><td>${escapeHtml(event.Type || 'system')}</td><td>${escapeHtml(date ? date.toLocaleString() : '—')}</td><td><button class="row-action" data-event-details="${state.events.indexOf(event)}" title="Event details" aria-label="Event details">⌕</button></td></tr>`;
  }).join('') : `<tr><td colspan="5" class="table-placeholder">${state.events.length ? 'No events match these filters.' : 'No Docker events in this time range.'}</td></tr>`;
}

function exportEvents() {
  const json = JSON.stringify(state.events, null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  link.download = `dockyard-events-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

const commandItems = [
  ...[
    ['overview', 'Overview', 'Host summary and recent containers', 'home dashboard'],
    ['containers', 'Containers', 'Manage workloads and bulk actions', 'workloads'],
    ['images', 'Images', 'Browse, pull, tag, and inspect images', 'registry catalog'],
    ['networks', 'Networks', 'Create networks and attach containers', 'connectivity'],
    ['volumes', 'Volumes', 'Manage persistent data', 'storage'],
    ['activity', 'Activity', 'Review recent browser actions', 'history audit'],
    ['monitor', 'Resource monitor', 'Sample CPU, memory, and network use', 'telemetry metrics stats'],
    ['events', 'Docker events', 'Filter and export Engine events', 'history journal logs'],
    ['cleanup', 'Cleanup', 'Reclaim unused Docker resources', 'prune'],
    ['settings', 'Settings', 'Customize theme and workspace layout', 'preferences appearance'],
    ['about', 'About', 'View app and Docker diagnostics', 'version help shortcuts'],
  ].map(([value, title, description, keywords]) => ({ group: 'Navigate', title, description, keywords, kind: 'page', value })),
  { group: 'Actions', title: 'Create container', description: 'Configure and launch a workload', keywords: 'new run start', kind: 'action', value: 'create-container' },
  { group: 'Actions', title: 'Pull image', description: 'Download from a registry', keywords: 'download registry', kind: 'action', value: 'pull-image' },
  { group: 'Actions', title: 'Create network', description: 'Add an isolated container network', keywords: 'new connectivity', kind: 'action', value: 'create-network' },
  { group: 'Actions', title: 'Create volume', description: 'Add persistent storage', keywords: 'new storage', kind: 'action', value: 'create-volume' },
  { group: 'Actions', title: 'Refresh Docker data', description: 'Reload resources from the Engine', keywords: 'reload sync', kind: 'action', value: 'refresh' },
  { group: 'Actions', title: 'Toggle light / dark mode', description: 'Switch the workspace color mode', keywords: 'theme color appearance', kind: 'action', value: 'toggle-theme' },
  { group: 'Actions', title: 'Appearance options', description: 'Choose an accent color', keywords: 'theme accent', kind: 'action', value: 'appearance' },
];

function openCommandPalette(query = '') {
  if (!state.session) return;
  $('#palette-layer').classList.remove('hidden');
  $('#palette-search').value = query;
  state.paletteIndex = 0;
  renderCommandPalette();
  window.setTimeout(() => $('#palette-search').focus(), 0);
}

function closeCommandPalette() { $('#palette-layer').classList.add('hidden'); }

function renderCommandPalette() {
  const query = $('#palette-search').value.trim().toLowerCase();
  const matches = commandItems.filter((item) => `${item.title} ${item.description} ${item.keywords}`.toLowerCase().includes(query));
  state.paletteResults = matches;
  if (!matches.length) {
    $('#palette-results').innerHTML = '<div class="palette-empty">No matching pages or actions</div>';
    return;
  }
  state.paletteIndex = Math.min(state.paletteIndex, matches.length - 1);
  $('#palette-results').innerHTML = matches.map((item, index) => `<button class="palette-option ${index === state.paletteIndex ? 'active' : ''}" data-command-index="${index}"><span class="palette-option-icon">${item.kind === 'page' ? '◫' : '↗'}</span><span class="palette-option-copy"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.description)}</small></span><span class="palette-option-group">${escapeHtml(item.group)}</span></button>`).join('');
}

function runCommand(item) {
  if (!item) return;
  closeCommandPalette();
  if (item.kind === 'page') {
    location.hash = item.value;
    setPage(item.value);
    return;
  }
  if (item.value === 'create-container') openCreateContainer();
  if (item.value === 'pull-image') openPullImage();
  if (item.value === 'create-network') openCreateNetwork();
  if (item.value === 'create-volume') openCreateVolume();
  if (item.value === 'refresh') refreshAll();
  if (item.value === 'toggle-theme') toggleColorMode();
  if (item.value === 'appearance') openThemePicker();
}

function recordActivity(label) {
  const activity = JSON.parse(localStorage.getItem('dockyard-activity') || '[]');
  activity.unshift({ label, at: Date.now() });
  state.activity = activity.slice(0, 100);
  localStorage.setItem('dockyard-activity', JSON.stringify(state.activity));
  if (state.currentPage === 'activity' && $('#activity-table')) renderActivity();
}

function savedProfiles() {
  try { return JSON.parse(localStorage.getItem('dockyard-saved-profiles') || '[]').filter((name) => typeof name === 'string'); }
  catch { return []; }
}

function rememberProfile(username) {
  const profiles = [username, ...savedProfiles().filter((name) => name.toLowerCase() !== username.toLowerCase())].slice(0, 8);
  localStorage.setItem('dockyard-saved-profiles', JSON.stringify(profiles));
  localStorage.setItem('dockyard-last-user', username);
}

function renderSavedProfiles() {
  $('#saved-user-list').innerHTML = savedProfiles().map((username) => `<option value="${escapeHtml(username)}"></option>`).join('');
  $('#remember-user').checked = localStorage.getItem('dockyard-remember-profile') !== 'false';
}

function renderActivity() {
  state.activity = JSON.parse(localStorage.getItem('dockyard-activity') || '[]');
  $('#activity-count').textContent = `${state.activity.length} ${state.activity.length === 1 ? 'event' : 'events'}`;
  $('#activity-table').innerHTML = state.activity.length ? state.activity.map((entry) => `<tr><td><div class="activity-event"><span class="activity-event-mark">↗</span>${escapeHtml(entry.label)}</div></td><td>${escapeHtml(new Date(entry.at).toLocaleString())}</td><td>Local machine</td></tr>`).join('') : '<tr><td colspan="3" class="table-placeholder">No actions recorded in this browser yet.</td></tr>';
}

function applyColorMode(mode) {
  const selected = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
  const resolved = selected === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : selected;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = selected;
  localStorage.setItem('dockyard-color-mode', selected);
  $('#mode-toggle').textContent = resolved === 'dark' ? '☼' : '◐';
  $('#mode-toggle').title = `Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`;
}

function applyTheme(name) {
  const selected = themes[name] ? name : 'fern';
  const theme = themes[selected];
  const dark = document.documentElement.dataset.theme === 'dark';
  const accent = dark ? ({ fern: '#9ed4b4', ocean: '#a8c9ef', coral: '#ffb4a9', marigold: '#d1bb77', plum: '#edb5cf' }[selected]) : theme.accent;
  setAccent(accent, theme, dark);
  localStorage.setItem('dockyard-theme', selected);
  localStorage.removeItem('dockyard-custom-accent');
  if ($('#setting-custom-accent')) $('#setting-custom-accent').value = theme.accent;
  $$('[data-setting-theme]').forEach((button) => button.classList.toggle('selected', button.dataset.settingTheme === selected));
}

function setAccent(accent, theme, dark) {
  const root = document.documentElement;
  const hex = accent.replace('#', '');
  const normalized = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex;
  const channels = [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const foreground = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2] > .48 ? '#16241b' : '#ffffff';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--md-sys-color-primary', accent);
  root.style.setProperty('--md-sys-color-surface-tint', accent);
  root.style.setProperty('--md-sys-color-on-primary', foreground);
  root.style.setProperty('--md-sys-color-primary-container', dark ? colorMix(accent, '#15251b', 28) : colorMix(accent, '#ffffff', 14));
  root.style.setProperty('--accent-soft', dark ? colorMix(accent, '#15251b', 28) : colorMix(accent, '#ffffff', 14));
  root.style.setProperty('--accent-strong', dark ? colorMix(accent, '#ffffff', 16) : theme?.strong || accent);
  root.style.setProperty('--accent-ink', dark ? colorMix(accent, '#ffffff', 58) : theme?.ink || accent);
  root.style.setProperty('--md-sys-color-on-primary-container', dark ? colorMix(accent, '#ffffff', 60) : theme?.ink || accent);
  root.style.setProperty('--md-sys-color-surface', dark ? colorMix(accent, '#111713', 4) : colorMix(accent, '#f3f5f1', 2));
  root.style.setProperty('--md-sys-color-surface-container-lowest', dark ? colorMix(accent, '#1a211c', 3) : '#ffffff');
  root.style.setProperty('--md-sys-color-surface-container-low', dark ? colorMix(accent, '#171e19', 5) : colorMix(accent, '#fafbf9', 3));
  root.style.setProperty('--md-sys-color-surface-container', dark ? colorMix(accent, '#202821', 6) : colorMix(accent, '#f4f7f3', 5));
  root.style.setProperty('--md-sys-color-surface-container-high', dark ? colorMix(accent, '#29332c', 7) : colorMix(accent, '#edf1ec', 6));
  root.style.setProperty('--md-sys-color-outline-variant', dark ? colorMix(accent, '#3b4840', 12) : colorMix(accent, '#dfe5df', 10));
  root.style.setProperty('--md-sys-color-outline', dark ? colorMix(accent, '#89968c', 12) : colorMix(accent, '#7d8b82', 10));
  root.style.setProperty('--sidebar', dark ? colorMix(accent, '#0d130f', 5) : colorMix(accent, '#17251f', 6));
}

function colorMix(color, other, percentage) { return `color-mix(in srgb, ${color} ${percentage}%, ${other})`; }

function applyCustomAccent(color) {
  setAccent(color, null, document.documentElement.dataset.theme === 'dark');
  localStorage.setItem('dockyard-theme', 'custom');
  localStorage.setItem('dockyard-custom-accent', color);
  $$('[data-setting-theme]').forEach((button) => button.classList.remove('selected'));
}

function applyStoredAccent() {
  const selected = localStorage.getItem('dockyard-theme') || 'fern';
  if (selected === 'custom') applyCustomAccent(localStorage.getItem('dockyard-custom-accent') || themes.fern.accent);
  else applyTheme(selected);
}

function applyShape(shape) {
  const radii = { sharp: ['3px', '5px', '8px'], balanced: ['4px', '8px', '14px'], soft: ['7px', '12px', '20px'] }[shape] || ['4px', '8px', '14px'];
  ['--md-shape-small', '--md-shape-medium', '--md-shape-large'].forEach((token, index) => document.documentElement.style.setProperty(token, radii[index]));
  localStorage.setItem('dockyard-shape', shape);
}

function applySidebarMode(mode) {
  const compact = mode === 'compact';
  $('#sidebar').classList.toggle('compact', compact);
  localStorage.setItem('dockyard-sidebar', compact ? 'compact' : 'expanded');
}

function applyRefreshInterval(seconds) {
  if (state.refreshIntervalTimer) clearInterval(state.refreshIntervalTimer);
  state.refreshIntervalTimer = null;
  if (seconds > 0) state.refreshIntervalTimer = window.setInterval(() => { if (!document.hidden && state.session) refreshAll(); }, seconds * 1000);
  localStorage.setItem('dockyard-refresh', String(seconds));
}

function syncSettingsForm() {
  $('#setting-mode').value = localStorage.getItem('dockyard-color-mode') || 'system';
  $('#setting-density').value = localStorage.getItem('dockyard-density') || 'comfortable';
  $('#setting-sidebar').value = localStorage.getItem('dockyard-sidebar') || 'expanded';
  $('#setting-motion').checked = localStorage.getItem('dockyard-motion') === 'reduced';
  $('#setting-shape').value = localStorage.getItem('dockyard-shape') || 'balanced';
  $('#setting-refresh').value = localStorage.getItem('dockyard-refresh') || '30';
  $('#setting-custom-accent').value = localStorage.getItem('dockyard-custom-accent') || themes[localStorage.getItem('dockyard-theme') || 'fern']?.accent || themes.fern.accent;
  $('#settings-session-user').textContent = state.session?.username || 'Local session';
  $('#setting-remember-profile').checked = localStorage.getItem('dockyard-remember-profile') !== 'false';
  const profileCount = savedProfiles().length;
  $('#remembered-profile-count').textContent = `${profileCount} ${profileCount === 1 ? 'profile' : 'profiles'} saved on this browser`;
  $('#settings-security').textContent = state.session?.configured ? 'Password-protected local sign-in is enabled.' : 'Local preview sign-in is not password-protected. Set DOCKYARD_PASSWORD before exposing this service beyond your machine.';
}

function resetSettings() {
  ['dockyard-color-mode', 'dockyard-density', 'dockyard-sidebar', 'dockyard-motion', 'dockyard-shape', 'dockyard-refresh', 'dockyard-custom-accent'].forEach((key) => localStorage.removeItem(key));
  localStorage.setItem('dockyard-theme', 'fern');
  applyPreferences();
  syncSettingsForm();
  toast('Settings restored');
}

function applyPreferences() {
  applyColorMode(localStorage.getItem('dockyard-color-mode') || 'system');
  const themeName = localStorage.getItem('dockyard-theme') || 'fern';
  if (themeName === 'custom') applyCustomAccent(localStorage.getItem('dockyard-custom-accent') || themes.fern.accent);
  else applyTheme(themeName);
  const density = localStorage.getItem('dockyard-density') || 'comfortable';
  document.documentElement.dataset.density = density;
  document.documentElement.dataset.motion = localStorage.getItem('dockyard-motion') || 'full';
  applyShape(localStorage.getItem('dockyard-shape') || 'balanced');
  applySidebarMode(localStorage.getItem('dockyard-sidebar') || 'expanded');
  applyRefreshInterval(Number(localStorage.getItem('dockyard-refresh') || '30'));
}

function showSignIn(sessionInfo, message = '') {
  state.session = null;
  $('#app-shell').hidden = true;
  $('#login-screen').classList.remove('hidden');
  if (sessionInfo && 'configured' in sessionInfo) state.authConfigured = Boolean(sessionInfo.configured);
  const configured = state.authConfigured;
  $('#login-password-field').classList.toggle('hidden', !configured);
  $('#login-password').required = configured;
  renderSavedProfiles();
  $('#login-username').value = sessionInfo?.loginUser || localStorage.getItem('dockyard-last-user') || '';
  $('#login-mode-note').textContent = configured
    ? 'Password protection is enabled for this Dockyard host.'
    : 'Local preview mode: no Dockyard password is configured. Anyone who can reach this local app can enter.';
  $('#login-security').textContent = configured
    ? 'Your sign-in uses an expiring HttpOnly session cookie.'
    : 'For password-protected sign-in, set DOCKYARD_USER and DOCKYARD_PASSWORD before starting the server.';
  $('#login-error').textContent = message;
  $('#login-error').classList.toggle('hidden', !message);
  $('#login-submit').querySelector('span').textContent = configured ? 'Sign in to workspace' : 'Continue to workspace';
}

function showWorkspace(session) {
  state.session = session;
  state.authConfigured = Boolean(session.configured ?? session.passwordConfigured);
  if (session.rememberMe && session.username) rememberProfile(session.username);
  $('#login-screen').classList.add('hidden');
  $('#app-shell').hidden = false;
  const username = session.username || 'Local operator';
  $('#profile-name').textContent = username;
  $('#profile-avatar').textContent = username.slice(0, 1).toUpperCase();
  $('#settings-session-user')?.replaceChildren(document.createTextNode(username));
  recordActivity('Signed in');
  setPage(location.hash.slice(1) || 'overview');
  refreshAll();
}

async function bootSession() {
  installUtilityViews();
  applyPreferences();
  try {
    const session = await api('/api/session');
    if (session.authenticated) showWorkspace(session);
    else showSignIn(session);
  } catch (error) {
    showSignIn(null, `Cannot reach the Dockyard server: ${error.message}`);
  }
}

async function signOut() {
  try { await api('/api/logout', { method: 'POST' }); }
  finally {
    state.session = null;
    $('#app-shell').hidden = true;
    showSignIn({ configured: state.authConfigured });
  }
}

function toggleColorMode() {
  const current = document.documentElement.dataset.theme;
  const mode = current === 'dark' ? 'light' : 'dark';
  applyColorMode(mode);
  const theme = localStorage.getItem('dockyard-theme') || 'fern';
  if (theme === 'custom') applyCustomAccent(localStorage.getItem('dockyard-custom-accent') || themes.fern.accent);
  else applyTheme(theme);
  if ($('#setting-mode')) $('#setting-mode').value = mode;
}

function openModal({ title, eyebrow = 'DOCKER RESOURCE', content, submit = 'Create', onSubmit, secondary, wide = false }) {
  $('#modal-title').textContent = title;
  $('#modal-eyebrow').textContent = eyebrow;
  $('#modal-content').innerHTML = content;
  $('#modal-actions').innerHTML = `<button class="button button-outline" data-modal-cancel>Cancel</button>${secondary ? `<button class="button button-outline" data-modal-secondary>${escapeHtml(secondary.label)}</button>` : ''}<button class="button button-primary" data-modal-submit>${escapeHtml(submit)}</button>`;
  $('.modal').classList.toggle('wide-modal', wide);
  $('#modal-layer').classList.remove('hidden');
  const firstInput = $('#modal-content input, #modal-content select, #modal-content textarea');
  window.setTimeout(() => firstInput?.focus(), 30);
  $('#modal-actions [data-modal-cancel]').onclick = closeModal;
  $('#modal-actions [data-modal-secondary]')?.addEventListener('click', () => secondary.onClick?.());
  $('#modal-actions [data-modal-submit]').onclick = async () => {
    const button = $('#modal-actions [data-modal-submit]');
    button.disabled = true;
    button.textContent = 'Working…';
    try { await onSubmit?.(); }
    catch (error) { toast(error.message, 'error'); button.disabled = false; button.textContent = submit; }
  };
}

function closeModal() {
  $('#modal-layer').classList.add('hidden');
  if (state.logRefreshInterval) window.clearInterval(state.logRefreshInterval);
  state.logRefreshInterval = null;
  if (state.shellSocket) {
    state.shellSocket.close(1000, 'Terminal closed');
    state.shellSocket = null;
  }
}
function field(label, name, options = {}) {
  const type = options.type || 'text';
  const placeholder = options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : '';
  const value = options.value ? ` value="${escapeHtml(options.value)}"` : '';
  const required = options.required ? ' required' : '';
  const optional = options.optional ? '<span class="optional">Optional</span>' : '';
  const hint = options.hint ? `<span class="form-hint">${escapeHtml(options.hint)}</span>` : '';
  const control = options.select
    ? `<select id="field-${name}" name="${name}">${options.select.map(([value, text]) => `<option value="${escapeHtml(value)}" ${String(value) === String(options.value || '') ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select>`
    : options.textarea
      ? `<textarea id="field-${name}" name="${name}"${placeholder}></textarea>`
      : `<input id="field-${name}" name="${name}" type="${type}"${placeholder}${value}${required}${options.step ? ` step="${options.step}"` : ''}>`;
  return `<div class="form-field ${options.full ? 'full' : ''}"><label for="field-${name}">${label}${optional}</label>${control}${hint}</div>`;
}

function formValues() {
  return Object.fromEntries($$('#modal-content [name]').map((input) => [input.name, input.type === 'checkbox' ? input.checked : input.value.trim()]));
}

function openCreateContainer(imageValue = '') {
  openModal({
    title: 'Create container', eyebrow: 'NEW WORKLOAD', submit: 'Create container',
    content: `<p class="modal-description">Configure a container from a local image. It will be created stopped; start it from the container list when ready.</p><div class="form-grid">${field('Image', 'image', { placeholder: 'nginx:alpine', value: imageValue, required: true, full: true, hint: 'Use an image already pulled locally, or pull it from the Images page.' })}${field('Container name', 'name', { placeholder: 'web-frontend', optional: true })}${field('Restart policy', 'restart', { select: [['no', 'No'], ['unless-stopped', 'Unless stopped'], ['always', 'Always'], ['on-failure', 'On failure']] })}${field('Command', 'command', { placeholder: 'Optional command override', optional: true, full: true })}${field('Ports', 'ports', { placeholder: '8080:80, 8443:443', optional: true, full: true, hint: 'Host:container pairs, comma-separated.' })}${field('Environment', 'environment', { placeholder: 'MODE=production, LOG_LEVEL=info', optional: true, full: true, hint: 'Comma-separated KEY=value pairs.' })}</div>`,
    onSubmit: async () => {
      const values = formValues();
      const hostConfig = { RestartPolicy: { Name: values.restart }, AutoRemove: values.autoRemove };
      const body = { Image: values.image, HostConfig: hostConfig, autoStart: values.startNow };
      if (values.hostname) body.Hostname = values.hostname;
      if (values.workdir) body.WorkingDir = values.workdir;
      if (values.entrypoint) body.Entrypoint = values.entrypoint.split(/\s+/);
      if (values.command) body.Cmd = values.command.split(/\s+/);
      if (values.environment) body.Env = values.environment.split(',').map((item) => item.trim()).filter(Boolean);
      if (values.labels) body.Labels = Object.fromEntries(values.labels.split(',').map((part) => part.trim().split('=').map((item) => item.trim())).filter((pair) => pair.length === 2));
      if (values.network) hostConfig.NetworkMode = values.network;
      if (values.memory) hostConfig.Memory = Number(values.memory) * 1024 * 1024;
      if (values.cpus) hostConfig.NanoCpus = Math.round(Number(values.cpus) * 1e9);
      if (values.mounts) {
        hostConfig.Binds = values.mounts.split(',').map((mount) => mount.trim()).filter(Boolean);
        for (const mount of hostConfig.Binds) {
          const parts = mount.split(':');
          if (parts.length < 2 || !parts[1].startsWith('/')) throw new Error(`Invalid mount: ${mount}. Use volume:/container/path or /host/path:/container/path:ro.`);
        }
      }
      const ports = (values.ports || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (ports.length) {
        body.ExposedPorts = {};
        body.HostConfig.PortBindings = {};
        for (const port of ports) {
          const match = port.match(/^(\d+):(\d+)(?:\/(tcp|udp))?$/);
          if (!match) throw new Error(`Invalid port mapping: ${port}. Use host:container, for example 8080:80.`);
          const protocol = match[3] || 'tcp';
          body.ExposedPorts[`${match[2]}/${protocol}`] = {};
          body.HostConfig.PortBindings[`${match[2]}/${protocol}`] = [{ HostPort: match[1] }];
        }
      }
      const name = values.name ? `?name=${encodeURIComponent(values.name)}` : '';
      const result = await api(`/api/containers/create${name}`, { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      if (values.startNow && result.Started === false) {
        toast(`Container ${result.Id?.slice(0, 12) || 'created'} created, but could not start: ${result.StartError || 'Docker did not start it.'}`, 'error');
      } else {
        toast(values.startNow ? 'Container created and started' : 'Container created');
      }
      await refreshAll(); setPage('containers');
    },
  });
  const networkOptions = [['', 'Default bridge'], ...state.networks.map((network) => [network.Name, network.Name])];
  $('#modal-content .form-grid').insertAdjacentHTML('beforeend', `<div class="advanced-divider full"><span>ADVANCED OPTIONS</span></div>${field('Hostname', 'hostname', { placeholder: 'Optional hostname' })}${field('Working directory', 'workdir', { placeholder: '/app', optional: true })}${field('Network', 'network', { select: networkOptions })}${field('Memory limit (MiB)', 'memory', { type: 'number', placeholder: '512', optional: true })}${field('CPU limit', 'cpus', { type: 'number', step: '0.1', placeholder: '1.5', optional: true })}${field('Entrypoint', 'entrypoint', { placeholder: 'Optional executable', optional: true })}${field('Mounts', 'mounts', { placeholder: 'data:/var/lib/app, /host/path:/container/path:ro', optional: true, full: true, hint: 'Comma-separated named volumes or host paths. Add :ro for read-only mounts.' })}${field('Labels', 'labels', { placeholder: 'team=platform, tier=backend', optional: true, full: true })}<div class="form-field full option-checks"><label class="form-check"><input type="checkbox" name="autoRemove"> Remove the container automatically after it stops</label><label class="form-check"><input type="checkbox" name="startNow" checked> Start immediately after creation</label></div>`);
}

function openPullImage() {
  openModal({
    title: 'Pull image', eyebrow: 'IMAGE REGISTRY', submit: 'Pull image',
    content: `<p class="modal-description">Choose a catalog image or enter any image reference from Docker Hub or a configured registry.</p><div class="form-grid">${field('Image reference', 'image', { placeholder: 'nginx:alpine', required: true, full: true, hint: 'Tags are supported, for example postgres:16-alpine or ghcr.io/team/app:v2.' })}</div><div class="catalog-toolbar"><div class="catalog-search"><span>⌕</span><input id="catalog-search" type="search" placeholder="Search catalog" aria-label="Search image catalog"></div><select id="catalog-category" aria-label="Filter catalog category"></select><button type="button" class="catalog-favorite-filter" id="catalog-favorites-toggle" aria-pressed="false">☆ Favorites</button></div><div class="catalog-grid" id="catalog-grid"><div class="catalog-loading">Loading image catalog…</div></div><div class="recent-pulls hidden" id="recent-pulls"></div><section class="pull-progress hidden" id="pull-progress"><div class="pull-progress-head"><span><b id="pull-progress-title">Pulling image</b><small id="pull-progress-summary">Connecting to registry…</small></span><span id="pull-progress-percent">0%</span></div><div class="progress-track"><span id="pull-progress-bar"></span></div><div class="layer-progress-list" id="layer-progress-list"></div><button class="text-button cancel-pull" id="cancel-pull" type="button">Cancel download</button></section>`,
    onSubmit: async () => {
      const imageName = formValues().image;
      if (!imageName) throw new Error('Enter or select an image reference.');
      const lastSlash = imageName.lastIndexOf('/');
      const colon = imageName.lastIndexOf(':');
      const image = colon > lastSlash ? imageName.slice(0, colon) : imageName;
      const tag = colon > lastSlash ? imageName.slice(colon + 1) : 'latest';
      await pullImageWithProgress(image, tag, imageName);
    },
  });
  $('#catalog-search').addEventListener('input', renderCatalogPicker);
  $('#catalog-category').addEventListener('change', (event) => { state.catalogCategory = event.target.value; renderCatalogPicker(); });
  $('#catalog-favorites-toggle').addEventListener('click', (event) => {
    const active = event.currentTarget.getAttribute('aria-pressed') !== 'true';
    event.currentTarget.setAttribute('aria-pressed', String(active));
    event.currentTarget.classList.toggle('selected', active);
    renderCatalogPicker();
  });
  $('#cancel-pull').addEventListener('click', () => state.pullController?.abort());
  loadImageCatalog();
}

function savedSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}

async function loadImageCatalog() {
  try {
    const catalog = await api('/api/catalog');
    state.catalog = Array.isArray(catalog.images) ? catalog.images : [];
    const categories = ['All', ...new Set(state.catalog.map((image) => image.category).filter(Boolean))];
    $('#catalog-category').innerHTML = categories.map((category) => `<option>${escapeHtml(category)}</option>`).join('');
    renderCatalogPicker();
  } catch (error) {
    $('#catalog-grid').innerHTML = `<div class="catalog-loading">Catalog unavailable: ${escapeHtml(error.message)}</div>`;
  }
}

function renderCatalogPicker() {
  const query = ($('#catalog-search')?.value || '').trim().toLowerCase();
  const favoritesOnly = $('#catalog-favorites-toggle')?.getAttribute('aria-pressed') === 'true';
  const favorites = savedSet('dockyard-favorites');
  const images = state.catalog.filter((image) => {
    const searchable = `${image.name} ${image.image} ${image.category} ${image.description} ${(image.tags || []).join(' ')}`.toLowerCase();
    return (state.catalogCategory === 'All' || image.category === state.catalogCategory)
      && (!query || searchable.includes(query))
      && (!favoritesOnly || favorites.has(image.image));
  });
  const recent = JSON.parse(localStorage.getItem('dockyard-recent-pulls') || '[]');
  const recentElement = $('#recent-pulls');
  if (recentElement) {
    recentElement.classList.toggle('hidden', !recent.length);
    recentElement.innerHTML = recent.length ? `<span class="catalog-section-label">RECENT</span>${recent.map((image) => `<button class="recent-chip" data-catalog-use="${escapeHtml(image)}">↻ ${escapeHtml(image)}</button>`).join('')}` : '';
  }
  $('#catalog-grid').innerHTML = images.length ? images.map((image) => {
    const isFavorite = favorites.has(image.image);
    const installed = state.images.some((local) => local.RepoTags?.includes(image.image));
    return `<article class="catalog-card"><span class="catalog-avatar" style="--catalog-tint:${escapeHtml(image.color || '#557c68')}">${escapeHtml((image.name || image.image).slice(0, 1).toUpperCase())}</span><div class="catalog-card-copy"><div class="catalog-card-title"><b>${escapeHtml(image.name || image.image)}</b><span>${escapeHtml(image.category || 'Other')}</span></div><p>${escapeHtml(image.description || '')}</p><code>${escapeHtml(image.image)}</code><div class="catalog-card-foot">${installed ? '<span class="catalog-installed">✓ On this host</span>' : `<span>${escapeHtml((image.tags || []).slice(0, 2).join(' · '))}</span>`}</div></div><div class="catalog-card-actions"><button class="catalog-star ${isFavorite ? 'favorite' : ''}" data-favorite="${escapeHtml(image.image)}" aria-label="${isFavorite ? 'Remove favorite' : 'Add favorite'}" title="${isFavorite ? 'Remove favorite' : 'Add favorite'}">${isFavorite ? '★' : '☆'}</button><button class="catalog-select" data-catalog-use="${escapeHtml(image.image)}" title="Use this image">Use</button></div></article>`;
  }).join('') : '<div class="catalog-loading">No catalog images match. Enter a custom image reference above.</div>';
}

async function pullImageWithProgress(image, tag, displayName) {
  const progress = $('#pull-progress');
  const button = $('#modal-actions [data-modal-submit]');
  progress.classList.remove('hidden');
  button.disabled = true;
  button.textContent = 'Downloading…';
  $('#pull-progress-title').textContent = displayName;
  $('#pull-progress-summary').textContent = 'Connecting to registry…';
  $('#pull-progress-percent').textContent = '0%';
  $('#pull-progress-bar').style.width = '0%';
  $('#layer-progress-list').innerHTML = '';
  const controller = new AbortController();
  state.pullController = controller;
  const layers = new Map();
  try {
    const response = await fetch(`/api/images/pull?image=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`, { method: 'POST', signal: controller.signal });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Pull failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let completed = false;
    while (!completed) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        if (event.id) layers.set(event.id, event);
        if (event.status) $('#pull-progress-summary').textContent = `${event.status}${event.id ? ` · ${event.id}` : ''}`;
        renderPullLayers(layers);
        const percent = pullPercent(layers);
        $('#pull-progress-percent').textContent = percent === null ? '…' : `${percent}%`;
        $('#pull-progress-bar').style.width = `${percent ?? 12}%`;
        if (event.status === 'Pull complete' || event.status === 'Already exists') layers.set(event.id || event.status, { ...(layers.get(event.id) || {}), status: 'Pull complete', progressDetail: { current: 1, total: 1 } });
      }
      completed = done;
    }
    if (pending) {
      const event = JSON.parse(pending);
      if (event.error) throw new Error(event.error);
    }
    $('#pull-progress-percent').textContent = '100%';
    $('#pull-progress-bar').style.width = '100%';
    $('#pull-progress-summary').textContent = 'Download complete';
    const recents = [displayName, ...JSON.parse(localStorage.getItem('dockyard-recent-pulls') || '[]').filter((item) => item !== displayName)].slice(0, 6);
    localStorage.setItem('dockyard-recent-pulls', JSON.stringify(recents));
    button.disabled = false;
    button.textContent = 'Done';
    button.onclick = async () => { closeModal(); toast(`Pulled ${displayName}`); await refreshAll(); setPage('images'); };
  } catch (error) {
    if (error.name === 'AbortError') {
      $('#pull-progress-summary').textContent = 'Download cancelled';
      toast('Image download cancelled');
      button.disabled = false;
      button.textContent = 'Pull again';
    } else {
      $('#pull-progress-summary').textContent = 'Download failed';
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Try again';
    }
  } finally {
    state.pullController = null;
  }
}

function pullPercent(layers) {
  const active = [...layers.values()].filter((layer) => layer.id || layer.progressDetail || layer.status === 'Pull complete');
  const totals = active.map((layer) => Number(layer.progressDetail?.total || 0)).filter((total) => total > 0);
  if (!totals.length) return null;
  const total = active.reduce((sum, layer) => sum + Number(layer.progressDetail?.total || 0), 0);
  const current = active.reduce((sum, layer) => sum + Math.min(Number(layer.progressDetail?.current || (layer.status === 'Pull complete' ? 1 : 0)), Number(layer.progressDetail?.total || 0)), 0);
  return total ? Math.min(99, Math.floor(current / total * 100)) : null;
}

function renderPullLayers(layers) {
  $('#layer-progress-list').innerHTML = [...layers.entries()].slice(-4).map(([id, layer]) => `<div class="layer-progress-row"><span class="layer-state ${layer.status === 'Pull complete' || layer.status === 'Already exists' ? 'done' : ''}">${layer.status === 'Pull complete' || layer.status === 'Already exists' ? '✓' : '·'}</span><span>${escapeHtml(id)}</span><small>${escapeHtml(layer.progress || layer.status || '')}</small></div>`).join('');
}

function openCreateNetwork() {
  openModal({
    title: 'Create network', eyebrow: 'CONTAINER CONNECTIVITY', submit: 'Create network',
    content: `<p class="modal-description">Create an isolated network for containers to communicate with each other.</p><div class="form-grid">${field('Network name', 'name', { placeholder: 'app-network', required: true, full: true })}${field('Driver', 'driver', { select: [['bridge', 'Bridge'], ['overlay', 'Overlay'], ['macvlan', 'Macvlan'], ['ipvlan', 'IPvlan']] })}${field('Scope', 'scope', { select: [['local', 'Local'], ['swarm', 'Swarm']] })}<div class="form-field full"><label class="form-check"><input type="checkbox" name="internal"> Internal network (isolated from external traffic)</label></div></div>`,
    onSubmit: async () => {
      const values = formValues();
      await api('/api/networks/create', { method: 'POST', body: JSON.stringify({ Name: values.name, Driver: values.driver, Scope: values.scope, Internal: values.internal }) });
      closeModal(); toast('Network created'); await refreshAll();
    },
  });
}

function openCreateVolume() {
  openModal({
    title: 'Create volume', eyebrow: 'PERSISTENT STORAGE', submit: 'Create volume',
    content: `<p class="modal-description">Volumes persist independently from containers and are useful for databases and application data.</p><div class="form-grid">${field('Volume name', 'name', { placeholder: 'postgres-data', required: true, full: true })}${field('Driver', 'driver', { select: [['local', 'Local'], ['custom', 'Custom driver']] })}${field('Labels', 'labels', { placeholder: 'team=platform', optional: true })}</div>`,
    onSubmit: async () => {
      const values = formValues();
      const body = { Name: values.name, Driver: values.driver };
      if (values.labels) body.Labels = Object.fromEntries(values.labels.split(',').map((part) => part.trim().split('=').map((item) => item.trim())).filter((pair) => pair.length === 2));
      await api('/api/volumes/create', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Volume created'); await refreshAll();
    },
  });
}

function openThemePicker() {
  const selected = localStorage.getItem('dockyard-theme') || 'fern';
  const swatchColors = { fern: '#267860', ocean: '#39749d', coral: '#bd6251', marigold: '#9a7528', plum: '#9d5876' };
  openModal({
    title: 'Appearance', eyebrow: 'PERSONALIZE YOUR WORKSPACE', submit: 'Done',
    content: `<p class="modal-description">Choose a color accent for buttons, highlights and active navigation. Your choice is saved in this browser.</p><div class="theme-swatches">${Object.entries(themes).map(([key, theme]) => `<button class="theme-choice ${key === selected ? 'selected' : ''}" data-theme-choice="${key}"><span class="theme-swatch" style="background:${swatchColors[key]}"></span>${theme.label}</button>`).join('')}</div>`,
    onSubmit: closeModal,
  });
  $$('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-theme-choice]').forEach((choice) => choice.classList.toggle('selected', choice === button));
    applyTheme(button.dataset.themeChoice);
  }));
}

function openOutput(title, eyebrow, text) {
  openModal({
    title, eyebrow, submit: 'Close', content: `<pre class="code-output">${escapeHtml(text)}</pre>`, onSubmit: closeModal,
  });
}

async function containerAction(action, id) {
  const container = state.containers.find((item) => item.Id === id);
  if (!container) return;
  const name = resourceName(container);
  if (action === 'copy-id') {
    try { await navigator.clipboard.writeText(id); toast('Container ID copied'); }
    catch { openOutput(`${name} · Container ID`, 'CONTAINER IDENTIFIER', id); }
    return;
  }
  if (action === 'shell') {
    openContainerShell(name, id);
    return;
  }
  if (action === 'limits') {
    openContainerLimits(container);
    return;
  }
  if (action === 'copy-config') {
    try {
      const details = await api(`/api/containers/${encodeURIComponent(id)}/inspect`);
      const config = {
        name,
        image: details.Config?.Image,
        command: details.Config?.Cmd,
        entrypoint: details.Config?.Entrypoint,
        environment: details.Config?.Env,
        ports: details.Config?.ExposedPorts,
        mounts: details.Mounts?.map((mount) => ({ source: mount.Name || mount.Source, destination: mount.Destination, mode: mount.Mode })),
        restartPolicy: details.HostConfig?.RestartPolicy,
        networkMode: details.HostConfig?.NetworkMode,
        labels: details.Config?.Labels,
      };
      downloadFile(`${name}-config.json`, JSON.stringify(config, null, 2), 'application/json');
      toast('Container config downloaded');
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'duplicate') {
    openCreateContainer(containerImage(container));
    return;
  }
  if (['remove', 'rename'].includes(action)) {
    if (action === 'remove') {
      openModal({
        title: `Remove ${name}?`, eyebrow: 'PERMANENT ACTION', submit: 'Remove container',
        content: `<p class="modal-description">This permanently removes the container. Its associated anonymous volumes will also be removed. Named volumes are not affected.</p><label class="form-check"><input id="force-remove" type="checkbox"> Force remove a running container</label>`,
        onSubmit: async () => {
          const force = $('#force-remove').checked;
          await api(`/api/containers/${encodeURIComponent(id)}/remove?force=${force ? '1' : '0'}`, { method: 'POST' });
          closeModal(); toast('Container removed'); await refreshAll();
        },
      });
      return;
    }
    openModal({
      title: 'Rename container', eyebrow: 'CONTAINER SETTINGS', submit: 'Save name',
      content: `<p class="modal-description">Choose a unique name for this container.</p>${field('Container name', 'name', { value: name, required: true })}`,
      onSubmit: async () => {
        const newName = formValues().name;
        await api(`/api/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(newName)}`, { method: 'POST' });
        closeModal(); toast('Container renamed'); await refreshAll();
      },
    });
    return;
  }
  if (action === 'logs') {
    openLogs(name, id);
    return;
  }
  if (['inspect', 'stats'].includes(action)) {
    try {
      const result = await api(`/api/containers/${encodeURIComponent(id)}/${action}${action === 'logs' ? '?tail=300' : ''}`);
      const output = action === 'logs' ? String(result || '(No logs available)') : JSON.stringify(result, null, 2);
      openOutput(action === 'logs' ? `${name} · Logs` : action === 'stats' ? `${name} · Live stats` : `${name} · Inspect`, action === 'logs' ? 'CONTAINER OUTPUT' : action === 'stats' ? 'RESOURCE USAGE' : 'CONTAINER DETAILS', output);
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  try {
    await api(`/api/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    toast(`${name}: ${action === 'unpause' ? 'resumed' : `${action}ed`}`);
    await refreshAll();
  } catch (error) { toast(error.message, 'error'); }
}

async function openContainerLimits(container) {
  const id = container.Id;
  const details = await api(`/api/containers/${encodeURIComponent(id)}/inspect`).catch((error) => {
    toast(error.message, 'error');
    return null;
  });
  if (!details) return;
  const host = details.HostConfig || {};
  const memoryMiB = host.Memory ? Math.round(host.Memory / 1024 / 1024) : '';
  const cpus = host.NanoCpus ? (host.NanoCpus / 1e9).toString() : '';
  const restart = host.RestartPolicy?.Name || 'no';
  openModal({
    title: `Update ${resourceName(container)}`, eyebrow: 'RESOURCE & RESTART POLICY', submit: 'Apply settings',
    content: `<p class="modal-description">Update container limits and restart behavior. Leave resource fields blank to keep their current values.</p><div class="form-grid">${field('Memory limit (MiB)', 'memory', { type: 'number', placeholder: 'Unlimited', value: memoryMiB, optional: true })}${field('CPU limit', 'cpus', { type: 'number', step: '0.1', placeholder: 'Unlimited', value: cpus, optional: true })}${field('PID limit', 'pids', { type: 'number', placeholder: 'No limit', value: host.PidsLimit > 0 ? String(host.PidsLimit) : '', optional: true })}${field('Restart policy', 'restart', { select: [['no', 'No'], ['unless-stopped', 'Unless stopped'], ['always', 'Always'], ['on-failure', 'On failure']], value: restart })}${field('CPU shares', 'shares', { type: 'number', placeholder: 'Default', value: host.CpuShares ? String(host.CpuShares) : '', optional: true })}</div>`,
    onSubmit: async () => {
      const values = formValues();
      const update = { RestartPolicy: { Name: values.restart } };
      if (values.memory) update.Memory = Number(values.memory) * 1024 * 1024;
      if (values.cpus) update.NanoCpus = Math.round(Number(values.cpus) * 1e9);
      if (values.pids) update.PidsLimit = Number(values.pids);
      if (values.shares) update.CpuShares = Number(values.shares);
      await api(`/api/containers/${encodeURIComponent(id)}/update`, { method: 'POST', body: JSON.stringify(update) });
      closeModal();
      toast('Container settings updated');
      await refreshAll();
    },
  });
}

function openContainerShell(name, id) {
  openModal({
    title: `${name} · Terminal`, eyebrow: 'INTERACTIVE DOCKER EXEC', submit: 'Close terminal',
    content: `<div class="shell-toolbar"><span class="shell-live-indicator"><i></i> ATTACHED</span><label for="shell-choice">Shell</label><select id="shell-choice"><option value="sh">/bin/sh</option><option value="bash">/bin/bash</option><option value="ash">/bin/ash</option></select><button class="button button-quiet" id="shell-clear">Clear</button></div><pre class="shell-output" id="shell-output" role="log" aria-live="polite">Connecting to ${escapeHtml(name)}…\n</pre><form class="shell-input-row" id="shell-form"><span class="shell-prompt">$</span><input id="shell-input" type="text" autocomplete="off" spellcheck="false" aria-label="Terminal command" placeholder="Type a command and press Enter"><button class="button button-primary" type="submit">Send</button></form><p class="shell-hint">Enter runs a command · ↑/↓ command history · Ctrl+C sends interrupt</p>`,
    onSubmit: closeModal,
  });

  const output = $('#shell-output');
  const input = $('#shell-input');
  const appendOutput = (text) => {
    const safeText = String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    output.textContent += safeText;
    output.scrollTop = output.scrollHeight;
  };
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connectShell = (shell) => {
    if (state.shellSocket) state.shellSocket.close(1000, 'Changing shell');
    const socket = new WebSocket(`${protocol}//${location.host}/api/containers/${encodeURIComponent(id)}/shell?shell=${encodeURIComponent(shell)}`);
    socket.binaryType = 'arraybuffer';
    state.shellSocket = socket;
    socket.addEventListener('open', () => { output.textContent = ''; input.focus(); });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') appendOutput(event.data);
      else appendOutput(new TextDecoder().decode(event.data));
    });
    socket.addEventListener('error', () => appendOutput('\r\n[dockyard] Terminal connection failed. Confirm that the container is running and includes the selected shell.\r\n'));
    socket.addEventListener('close', (event) => {
      if (event.reason !== 'Changing shell') appendOutput(`\r\n[dockyard] Terminal disconnected${event.reason ? `: ${event.reason}` : '.'}\r\n`);
      if (state.shellSocket === socket) state.shellSocket = null;
    });
    return socket;
  };
  let socket = connectShell($('#shell-choice').value);
  $('#shell-choice').addEventListener('change', (event) => { socket = connectShell(event.target.value); });
  $('#shell-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (socket.readyState !== WebSocket.OPEN) return toast('Terminal is not connected yet', 'error');
    const command = input.value;
    if (command.trim()) {
      state.shellHistory.unshift(command);
      state.shellHistory = state.shellHistory.slice(0, 50);
      state.shellHistoryIndex = 0;
    }
    socket.send(`${command}\r`);
    input.value = '';
  });
  input.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (socket.readyState === WebSocket.OPEN) socket.send('\u0003');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (state.shellHistoryIndex < state.shellHistory.length) input.value = state.shellHistory[state.shellHistoryIndex++];
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.shellHistoryIndex = Math.max(0, state.shellHistoryIndex - 1);
      input.value = state.shellHistory[state.shellHistoryIndex] || '';
    }
  });
  $('#shell-clear').addEventListener('click', () => { output.textContent = ''; input.focus(); });
}

async function openLogs(name, id) {
  try {
    let logs = await api(`/api/containers/${encodeURIComponent(id)}/logs?tail=300`);
    openModal({
      title: `${name} · Logs`, eyebrow: 'CONTAINER OUTPUT', submit: 'Close',
      content: `<div class="log-toolbar"><label class="form-check"><input id="logs-follow" type="checkbox"> Follow logs</label><button class="button button-outline" id="logs-copy">Copy</button><button class="button button-outline" id="logs-download">Download .txt</button><button class="button button-quiet" id="logs-refresh">↻ Refresh</button></div><pre class="code-output" id="logs-output">${escapeHtml(String(logs || '(No logs available)'))}</pre>`,
      onSubmit: closeModal,
    });
    const output = $('#logs-output');
    const update = async () => {
      try {
        logs = await api(`/api/containers/${encodeURIComponent(id)}/logs?tail=300`);
        output.textContent = String(logs || '(No logs available)');
        if ($('#logs-follow')?.checked) output.scrollTop = output.scrollHeight;
      } catch (error) { toast(error.message, 'error'); }
    };
    $('#logs-refresh').addEventListener('click', update);
    $('#logs-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(output.textContent);
      toast('Logs copied');
    });
    $('#logs-download').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([output.textContent], { type: 'text/plain' }));
      link.download = `${name}-logs.txt`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
    state.logRefreshInterval = window.setInterval(() => { if ($('#logs-follow')?.checked && !$('#modal-layer').classList.contains('hidden')) update(); }, 2500);
  } catch (error) { toast(error.message, 'error'); }
}

function openImageTag(id) {
  openModal({
    title: 'Tag image', eyebrow: 'IMAGE VERSIONING', submit: 'Add tag',
    content: `<p class="modal-description">Add a repository name and tag to this image. The existing tag will remain unchanged.</p><div class="form-grid">${field('Repository', 'repo', { placeholder: 'my-app', required: true })}${field('Tag', 'tag', { placeholder: 'latest', value: 'latest' })}</div>`,
    onSubmit: async () => {
      const values = formValues();
      await api(`/api/images/${encodeURIComponent(id)}/tag?repo=${encodeURIComponent(values.repo)}&tag=${encodeURIComponent(values.tag || 'latest')}`, { method: 'POST' });
      closeModal(); toast('Image tagged'); await refreshAll();
    },
  });
}

function openImageRemove(id) {
  const image = state.images.find((item) => item.Id === id);
  const name = image?.RepoTags?.[0] || shortId(id);
  openModal({
    title: 'Remove image?', eyebrow: 'PERMANENT ACTION', submit: 'Remove image',
    content: `<p class="modal-description">Remove <b>${escapeHtml(name)}</b> from this host. Images used by existing containers cannot be removed.</p>`,
    onSubmit: async () => {
      await api(`/api/images/${encodeURIComponent(id)}/remove`, { method: 'DELETE' });
      closeModal(); toast('Image removed'); await refreshAll();
    },
  });
}

function openPrune(kind) {
  const labels = { containers: 'stopped containers', images: 'unused images', networks: 'unused networks', volumes: 'unused volumes', build: 'build cache' };
  const label = labels[kind];
  openModal({
    title: `Prune ${label}?`, eyebrow: 'PERMANENT CLEANUP', submit: 'Prune resources',
    content: `<p class="modal-description">Docker will permanently remove ${label} that are not currently in use. This operation cannot be undone. Review the affected resources before continuing.</p>`,
    onSubmit: async () => {
      const result = await api(`/api/prune?kind=${kind}`, { method: 'POST' });
      closeModal();
      const removed = result?.ContainersDeleted?.length ?? result?.ImagesDeleted?.length ?? result?.NetworksDeleted?.length ?? result?.VolumesDeleted?.length ?? 0;
      const reclaimed = result?.SpaceReclaimed ? ` · ${formatBytes(result.SpaceReclaimed)} reclaimed` : '';
      toast(`Cleanup complete · ${removed} removed${reclaimed}`);
      await refreshAll();
    },
  });
}

document.addEventListener('click', (event) => {
  const pageLink = event.target.closest('[data-page]');
  if (pageLink) {
    event.preventDefault();
    const page = pageLink.dataset.page;
    location.hash = page;
    setPage(page);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === 'create-container') openCreateContainer();
    if (action === 'pull-image') openPullImage();
    if (action === 'create-network') openCreateNetwork();
    if (action === 'create-volume') openCreateVolume();
    if (action.startsWith('prune-')) openPrune(action.replace('prune-', ''));
    return;
  }
  const resource = event.target.closest('[data-resource-action]');
  if (resource) {
    resource.closest('details')?.removeAttribute('open');
    containerAction(resource.dataset.resourceAction, resource.dataset.id);
    return;
  }
  const image = event.target.closest('[data-image-action]');
  if (image) {
    const { id, imageAction } = image.dataset;
    if (imageAction === 'run') openCreateContainer(state.images.find((item) => item.Id === id)?.RepoTags?.[0] || '');
    if (imageAction === 'tag') openImageTag(id);
    if (imageAction === 'remove') openImageRemove(id);
    if (imageAction === 'inspect' || imageAction === 'history') api(`/api/images/${encodeURIComponent(id)}/${imageAction}`).then((value) => openOutput(`${shortId(id)} · ${imageAction}`, imageAction === 'inspect' ? 'IMAGE DETAILS' : 'IMAGE LAYERS', JSON.stringify(value, null, 2))).catch((error) => toast(error.message, 'error'));
    return;
  }
  const network = event.target.closest('[data-network-action]');
  if (network) {
    if (network.dataset.networkAction === 'inspect') {
      api(`/api/networks/${encodeURIComponent(network.dataset.id)}`).then((value) => openOutput(`${network.dataset.name || 'Network'} · Details`, 'NETWORK DETAILS', JSON.stringify(value, null, 2))).catch((error) => toast(error.message, 'error'));
      return;
    }
    if (network.dataset.networkAction === 'connect') {
      const options = state.containers.map((container) => `<option value="${escapeHtml(container.Id)}">${escapeHtml(resourceName(container))} · ${escapeHtml(statusKey(container))}</option>`).join('');
      openModal({
        title: `Connect to ${network.dataset.name}`, eyebrow: 'NETWORK ATTACHMENT', submit: 'Connect container',
        content: `<p class="modal-description">Attach a container to this network. Docker keeps existing network attachments in place.</p><div class="form-field"><label for="network-container">Container</label><select id="network-container">${options}</select></div>`,
        onSubmit: async () => {
          await api(`/api/networks/${encodeURIComponent(network.dataset.id)}/connect`, { method: 'POST', body: JSON.stringify({ Container: $('#network-container').value }) });
          closeModal(); toast('Container connected'); await refreshAll();
        },
      });
      return;
    }
    if (network.dataset.networkAction === 'disconnect') {
      api(`/api/networks/${encodeURIComponent(network.dataset.id)}`).then((details) => {
        const attached = Object.entries(details.Containers || {});
        if (!attached.length) { toast('No containers are attached to this network'); return; }
        const options = attached.map(([id, entry]) => `<option value="${escapeHtml(id)}">${escapeHtml(entry.Name || resourceName(state.containers.find((container) => container.Id === id) || {}))}</option>`).join('');
        openModal({
          title: `Disconnect from ${network.dataset.name}`, eyebrow: 'NETWORK ATTACHMENT', submit: 'Disconnect container',
          content: `<p class="modal-description">Remove one container from this network. Its other network connections remain unchanged.</p><div class="form-field"><label for="network-container">Attached container</label><select id="network-container">${options}</select></div>`,
          onSubmit: async () => {
            await api(`/api/networks/${encodeURIComponent(network.dataset.id)}/disconnect`, { method: 'POST', body: JSON.stringify({ Container: $('#network-container').value, Force: true }) });
            closeModal(); toast('Container disconnected'); await refreshAll();
          },
        });
      }).catch((error) => toast(error.message, 'error'));
      return;
    }
    openModal({
      title: `Remove ${network.dataset.name}?`, eyebrow: 'NETWORK MANAGEMENT', submit: 'Remove network',
      content: '<p class="modal-description">Containers attached to this network may need to be disconnected before it can be removed.</p>',
      onSubmit: async () => {
        await api(`/api/networks/${encodeURIComponent(network.dataset.id)}`, { method: 'DELETE' });
        closeModal(); toast('Network removed'); await refreshAll();
      },
    });
    return;
  }
  const volume = event.target.closest('[data-volume-action]');
  if (volume) {
    if (volume.dataset.volumeAction === 'inspect') {
      api(`/api/volumes/${encodeURIComponent(volume.dataset.id)}`).then((value) => openOutput(`${volume.dataset.id} · Details`, 'VOLUME DETAILS', JSON.stringify(value, null, 2))).catch((error) => toast(error.message, 'error'));
      return;
    }
    openModal({
      title: 'Remove volume?', eyebrow: 'PERMANENT DATA DELETION', submit: 'Remove volume',
      content: `<p class="modal-description">Permanently remove volume <b>${escapeHtml(volume.dataset.id)}</b> and all data stored in it. This cannot be undone.</p>`,
      onSubmit: async () => {
        await api(`/api/volumes/${encodeURIComponent(volume.dataset.id)}`, { method: 'DELETE' });
        closeModal(); toast('Volume removed'); await refreshAll();
      },
    });
  }
});

document.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-container-select]');
  if (!checkbox) return;
  if (checkbox.checked) state.selectedContainers.add(checkbox.dataset.containerSelect);
  else state.selectedContainers.delete(checkbox.dataset.containerSelect);
  updateBulkToolbar();
  const selectAll = $('#select-all-containers');
  const visible = $$('#containers-table [data-container-select]');
  selectAll.checked = visible.length > 0 && visible.every((item) => state.selectedContainers.has(item.dataset.containerSelect));
  selectAll.indeterminate = visible.some((item) => state.selectedContainers.has(item.dataset.containerSelect)) && !selectAll.checked;
});

document.addEventListener('click', (event) => {
  const eventDetails = event.target.closest('[data-event-details]');
  if (eventDetails) {
    const dockerEvent = state.events[Number(eventDetails.dataset.eventDetails)];
    if (dockerEvent) openOutput(`${dockerEvent.Type || 'Docker'} · ${dockerEvent.Action || 'Event'}`, 'ENGINE EVENT', JSON.stringify(dockerEvent, null, 2));
    return;
  }
  const bulkButton = event.target.closest('[data-bulk-action]');
  if (bulkButton) runBulkAction(bulkButton.dataset.bulkAction);
  const catalogChoice = event.target.closest('[data-catalog-use]');
  if (catalogChoice) $('#field-image').value = catalogChoice.dataset.catalogUse;
  const favoriteButton = event.target.closest('[data-favorite]');
  if (favoriteButton) {
    const favorites = savedSet('dockyard-favorites');
    favorites.has(favoriteButton.dataset.favorite) ? favorites.delete(favoriteButton.dataset.favorite) : favorites.add(favoriteButton.dataset.favorite);
    localStorage.setItem('dockyard-favorites', JSON.stringify([...favorites]));
    renderCatalogPicker();
  }
});

$('#refresh-button').addEventListener('click', refreshAll);
$('#top-refresh').addEventListener('click', refreshAll);
$('#retry-button').addEventListener('click', refreshAll);
$('#container-refresh').addEventListener('click', refreshAll);
$('#image-refresh').addEventListener('click', refreshAll);
$('#network-refresh').addEventListener('click', refreshAll);
$('#volume-refresh').addEventListener('click', refreshAll);
$('#theme-open').addEventListener('click', openThemePicker);
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#modal-close').addEventListener('click', closeModal);
$('#modal-layer').addEventListener('click', (event) => { if (event.target === $('#modal-layer')) closeModal(); });
$('#palette-search').addEventListener('input', () => { state.paletteIndex = 0; renderCommandPalette(); });
$('#palette-results').addEventListener('click', (event) => {
  const option = event.target.closest('[data-command-index]');
  if (option) runCommand(state.paletteResults[Number(option.dataset.commandIndex)]);
});
$('#palette-layer').addEventListener('click', (event) => { if (event.target === $('#palette-layer')) closeCommandPalette(); });
document.addEventListener('keydown', (event) => {
  const paletteOpen = !$('#palette-layer').classList.contains('hidden');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
    return;
  }
  if (paletteOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const count = state.paletteResults.length;
    if (count) state.paletteIndex = (state.paletteIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    renderCommandPalette();
    return;
  }
  if (paletteOpen && event.key === 'Enter') {
    event.preventDefault();
    runCommand(state.paletteResults[state.paletteIndex]);
    return;
  }
  if (event.key === 'Escape') { closeCommandPalette(); closeModal(); }
  if (event.key === '?' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { openCommandPalette(); return; }
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    const search = $(`#${state.currentPage.slice(0, -1)}-search`) || $(`#${state.currentPage}-search`);
    search?.focus();
  }
});
$('#container-search').addEventListener('input', renderContainers);
$('#container-filter').addEventListener('change', renderContainers);
$('#image-search').addEventListener('input', renderImages);
$('#network-search').addEventListener('input', renderNetworks);
$('#volume-search').addEventListener('input', renderVolumes);
ensureBulkToolbar();
$$('[data-sort]').forEach((button) => button.addEventListener('click', () => {
  const key = button.dataset.sort;
  state.sort = { key, descending: state.sort.key === key ? !state.sort.descending : key === 'created' };
  renderContainers();
}));
window.addEventListener('hashchange', () => setPage(location.hash.slice(1)));

$$('.nav-link').forEach((link) => { link.title = link.textContent.trim(); });
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-submit');
  button.disabled = true;
  button.querySelector('span').textContent = 'Signing in…';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#login-username').value.trim(), password: $('#login-password').value, rememberMe: $('#remember-user').checked }) });
    if (result.rememberMe) rememberProfile(result.username);
    else localStorage.removeItem('dockyard-last-user');
    $('#login-password').value = '';
    showWorkspace({ ...result, configured: state.authConfigured });
  } catch (error) {
    showSignIn({ configured: state.authConfigured }, error.message);
  } finally {
    button.disabled = false;
  }
});
$('#password-toggle').addEventListener('click', (event) => {
  const input = $('#login-password');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? 'Hide' : 'Show';
  event.currentTarget.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} password`);
});
$('#logout-button').addEventListener('click', signOut);
$('#mode-toggle').addEventListener('click', toggleColorMode);
$('#login-theme-toggle').addEventListener('click', toggleColorMode);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (localStorage.getItem('dockyard-color-mode') === 'system') {
    applyColorMode('system');
    applyStoredAccent();
  }
});
bootSession();