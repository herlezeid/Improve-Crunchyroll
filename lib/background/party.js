// Watch party (fork): conexão com o relay e ponte entre a sala e a aba do Crunchyroll.
//
// A conexão fica aqui no service worker (sobrevive à troca de página na aba). A aba conversa com este
// arquivo por uma porta `chrome.runtime.connect({ name: 'party' })`; o popup, por mensagens `type: 'party'`.
// Nada da conta do Crunchyroll passa por aqui: só ID do episódio, posição, play/pause, velocidade e apelido.

const PARTY_DEFAULT_SERVER = 'wss://ic-watch-party.ic-watch-party.workers.dev';
const PARTY_ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;

const party = {
  ws: null,
  session: null, // { room, name, server }
  secret: null,
  connection: 'offline', // offline | connecting | online | error
  error: null,
  you: null,
  leader: null,
  members: [],
  state: null,
  offset: 0, // relógio do servidor - relógio local (ms)
  bestRtt: Infinity,
  retry: 0,
  retryTimer: null,
  pingTimer: null,
  clockTimer: null,
  ports: new Map(), // tabId -> port
  tabId: null,
  ready: null,
};

function partyRandom(bytes = 16) {
  const array = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function partyCleanServer(server) {
  try {
    const url = new URL((server || '').trim() || PARTY_DEFAULT_SERVER);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) {
      return null;
    }
    return url.origin.replace(/^http/, 'ws');
  } catch {
    return null;
  }
}

function partyRoomFromInput(input) {
  const value = (input || '').trim();
  const fromLink = value.match(/[#&?]icparty=([A-Za-z0-9_-]+)/);
  const room = fromLink ? fromLink[1] : value;
  return PARTY_ROOM_RE.test(room) ? room : null;
}

function partyInfo() {
  const { session } = party;
  return {
    inRoom: Boolean(session),
    room: session?.room || null,
    name: session?.name || null,
    server: session?.server || null,
    defaultServer: PARTY_DEFAULT_SERVER,
    connection: party.connection,
    error: party.error,
    you: party.you,
    leader: party.leader,
    isLeader: Boolean(party.you && party.you === party.leader),
    members: party.members,
    tabId: party.tabId,
    invite: session
      ? `https://www.crunchyroll.com/#icparty=${session.room}` +
        (session.server !== partyCleanServer('') ? `&ics=${encodeURIComponent(session.server)}` : '')
      : null,
  };
}

function partyPortMessage(port, message) {
  try {
    port.postMessage(message);
  } catch {}
}

function partyLocalState() {
  return party.state ? { ...party.state, localAt: party.state.at - party.offset } : null;
}

function partyNotify() {
  const info = partyInfo();
  party.ports.forEach((port, tabId) => partyPortMessage(port, { t: 'room', info: { ...info, active: tabId === party.tabId } }));
  chrome.runtime.sendMessage({ type: 'party_update', info }).catch(() => {});
}

function partySend(message) {
  if (party.ws?.readyState === WebSocket.OPEN) party.ws.send(JSON.stringify(message));
}

function partySyncClock(samples = 5) {
  party.bestRtt = Infinity;
  for (let i = 0; i < samples; i++) {
    setTimeout(() => partySend({ t: 'time', c: Date.now() }), i * 200);
  }
}

function partyStopTimers() {
  clearInterval(party.pingTimer);
  clearInterval(party.clockTimer);
  clearTimeout(party.retryTimer);
}

function partyConnect() {
  const { session } = party;
  if (!session) return;
  partyStopTimers();
  party.connection = 'connecting';
  party.error = null;
  partyNotify();

  const params = new URLSearchParams({ client: party.secret, name: session.name });
  if (session.create) params.set('create', '1');
  const ws = new WebSocket(`${session.server}/room/${session.room}?${params}`);
  party.ws = ws;

  ws.onopen = () => {
    if (party.ws !== ws) return;
    party.retry = 0;
    party.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 20000);
    party.clockTimer = setInterval(() => partySyncClock(3), 5 * 60 * 1000);
  };

  ws.onmessage = ({ data }) => {
    if (party.ws !== ws || data === 'pong') return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        if (party.session?.create) {
          // A reivindicação de criação só vale na primeira conexão.
          delete party.session.create;
          chrome.storage.local.set({ party_session: party.session });
        }
        party.connection = 'online';
        party.you = msg.you;
        party.leader = msg.leader;
        party.members = msg.members;
        party.offset = msg.now - Date.now();
        party.state = msg.state;
        partySyncClock();
        partyNotify();
        if (party.state) partyBroadcastState();
        break;
      case 'time': {
        const now = Date.now();
        const rtt = now - msg.c;
        if (rtt >= 0 && rtt <= party.bestRtt) {
          party.bestRtt = rtt;
          party.offset = msg.s - (msg.c + rtt / 2);
        }
        break;
      }
      case 'members':
        party.leader = msg.leader;
        party.members = msg.members;
        partyNotify();
        break;
      case 'state':
        party.state = msg.state;
        partyBroadcastState();
        break;
      case 'error':
        if (msg.error === 'not_leader') partyNotify();
        break;
    }
  };

  ws.onclose = ({ code }) => {
    if (party.ws !== ws) return;
    party.ws = null;
    partyStopTimers();
    if (!party.session) return;
    if (code === 4000) {
      party.connection = 'error';
      party.error = 'replaced';
      return partyNotify();
    }
    party.connection = 'connecting';
    party.retry = Math.min(party.retry + 1, 6);
    party.retryTimer = setTimeout(partyConnect, Math.min(30000, 1000 * 2 ** (party.retry - 1)));
    partyNotify();
  };

  ws.onerror = () => {
    if (party.ws !== ws) return;
    party.error = 'network';
  };
}

function partyBroadcastState() {
  const state = partyLocalState();
  const port = party.ports.get(party.tabId);
  if (port && state) partyPortMessage(port, { t: 'state', state });
}

async function partyStart(session, tabId) {
  await partyLeave(false);
  party.session = session;
  party.tabId = tabId ?? null;
  party.state = null;
  party.members = [];
  party.you = party.leader = null;
  await chrome.storage.local.set({ party_session: session, party_name: session.name });
  partyConnect();
}

async function partyLeave(persist = true) {
  partyStopTimers();
  const ws = party.ws;
  party.ws = null;
  party.session = null;
  party.connection = 'offline';
  party.error = null;
  party.you = party.leader = party.state = null;
  party.members = [];
  try {
    ws?.close(1000, 'leave');
  } catch {}
  if (persist) {
    await chrome.storage.local.remove('party_session');
    partyNotify();
  }
}

async function partyActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function partyHandle(data, sender) {
  await party.ready;
  const fromTab = sender.tab?.id;
  switch (data?.action) {
    case 'get':
      return partyInfo();
    case 'create':
    case 'join': {
      const name = String(data.name || '').trim().slice(0, 24);
      if (!name) throw new Error('name');
      const linkServer = String(data.room || '').match(/[#&?]ics=([^&]+)/);
      const server = partyCleanServer(data.server || (linkServer ? decodeURIComponent(linkServer[1]) : ''));
      if (!server) throw new Error('server');
      const room = data.action === 'create' ? partyRandom(16) : partyRoomFromInput(data.room);
      if (!room) throw new Error('room');
      if (data.server !== undefined) await chrome.storage.local.set({ party_server: data.server.trim() });
      await partyStart(
        { room, name, server, ...(data.action === 'create' ? { create: true } : {}) },
        fromTab ?? (await partyActiveTab()),
      );
      return partyInfo();
    }
    case 'leave':
      await partyLeave();
      return partyInfo();
    case 'promote':
      partySend({ t: 'promote', to: String(data.to || '') });
      return partyInfo();
    case 'reconnect':
      if (party.session) partyConnect();
      return partyInfo();
    default:
      throw new Error('action');
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'party' || !port.sender?.tab || port.sender.id !== chrome.runtime.id) return;
  const tabId = port.sender.tab.id;
  party.ports.set(tabId, port);

  port.onMessage.addListener(async (msg) => {
    await party.ready;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      // A aba da sala é a escolhida ao criar/entrar; se ela sumiu, a primeira aba do Crunchyroll que aparecer assume.
      if (party.tabId === null || !party.ports.has(party.tabId)) party.tabId = tabId;
      partyNotify();
      if (tabId === party.tabId) partyBroadcastState();
      return;
    }
    if (tabId !== party.tabId) return;
    if (msg.t === 'state' && party.you && party.you === party.leader) {
      partySend({ t: 'state', mediaId: msg.mediaId, playing: msg.playing, position: msg.position, rate: msg.rate, seq: msg.seq });
    } else if (msg.t === 'status') {
      partySend({ t: 'status', state: msg.state, mediaId: msg.mediaId, drift: msg.drift });
    } else if (msg.t === 'takeover') {
      party.tabId = tabId;
      partyNotify();
      partyBroadcastState();
    }
  });

  port.onDisconnect.addListener(() => {
    if (party.ports.get(tabId) === port) party.ports.delete(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === party.tabId) {
    party.tabId = party.ports.keys().next().value ?? null;
    partyNotify();
  }
});

// Retoma a sala se o service worker reiniciar.
party.ready = chrome.storage.local.get(['party_session', 'party_client_secret']).then(async (items) => {
  party.secret = items.party_client_secret;
  if (!party.secret) {
    party.secret = partyRandom(24);
    await chrome.storage.local.set({ party_client_secret: party.secret });
  }
  if (items.party_session && PARTY_ROOM_RE.test(items.party_session.room || '')) {
    party.session = items.party_session;
    partyConnect();
  }
});
