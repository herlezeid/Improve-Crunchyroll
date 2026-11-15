// Relay das salas de watch party do Improve Crunchyroll (fork).
//
// Cada sala é um Durable Object com WebSockets em hibernação. O servidor não sabe nada da conta
// de ninguém: só repassa o estado do líder (episódio, play/pause, posição, velocidade) e o status
// de cada participante. Só o líder pode mandar estado; quem segue só manda status.

import { DurableObject } from 'cloudflare:workers';

const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MEDIA_RE = /^[A-Z0-9]{5,24}$/;
const PUBLIC_ID_RE = /^[a-f0-9]{12}$/;
const STATUSES = new Set(['idle', 'loading', 'buffering', 'ready', 'blocked', 'unavailable']);
const MAX_MEMBERS = 12;
const MAX_MESSAGE = 2048;
const LEADER_GRACE_MS = 45_000;
const ROOM_TTL_MS = 6 * 3600_000;

const json = (data) => JSON.stringify(data);

function cleanName(name) {
  const value = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 24);
  return value || 'Convidado';
}

function finite(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function cleanState(msg) {
  const mediaId = msg.mediaId === null ? null : String(msg.mediaId || '');
  if (mediaId !== null && !MEDIA_RE.test(mediaId)) return null;
  const position = finite(msg.position, 0, 86400);
  const rate = finite(msg.rate, 0.25, 4);
  if (position === null || rate === null) return null;
  return { mediaId, playing: msg.playing === true, position, rate, seq: Math.trunc(finite(msg.seq, 0, 1e12) ?? 0) };
}

function cleanStatus(msg) {
  const state = String(msg.state || '');
  if (!STATUSES.has(state)) return null;
  const mediaId = msg.mediaId == null ? null : String(msg.mediaId);
  if (mediaId !== null && !MEDIA_RE.test(mediaId)) return null;
  const drift = finite(msg.drift, -86400, 86400);
  return { state, mediaId, drift: drift === null ? null : Math.round(drift * 100) / 100 };
}

async function publicId(room, secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${room}:${secret}`));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      return url.pathname === '/'
        ? new Response('Improve Crunchyroll · watch party relay\n')
        : new Response('not found\n', { status: 404 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket\n', { status: 426 });

    // Só extensões conectam (impede que um site qualquer use o relay a partir do navegador de alguém).
    const origin = request.headers.get('Origin') || '';
    if (!/^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i.test(origin)) {
      return new Response('forbidden\n', { status: 403 });
    }

    const room = match[1];
    const secret = url.searchParams.get('client') || '';
    if (!ROOM_RE.test(room) || !SECRET_RE.test(secret)) return new Response('bad request\n', { status: 400 });

    const headers = new Headers(request.headers);
    headers.set('X-Room', room);
    headers.set('X-Member', await publicId(room, secret));
    headers.set('X-Name', cleanName(url.searchParams.get('name')));
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(request.url, { headers }));
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive da extensão: respondido sem acordar o objeto.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  #sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && ws.deserializeAttachment());
  }

  #members() {
    return this.#sockets()
      .map((ws) => ws.deserializeAttachment())
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  #send(ws, data) {
    try {
      ws.send(json(data));
    } catch {}
  }

  #broadcast(data, except) {
    const message = json(data);
    this.#sockets().forEach((ws) => {
      if (ws !== except) {
        try {
          ws.send(message);
        } catch {}
      }
    });
  }

  async #roster() {
    const leader = await this.ctx.storage.get('leader');
    return this.#members().map(({ id, name, status }) => ({ id, name, status, leader: id === leader }));
  }

  async #broadcastRoster() {
    const leader = await this.ctx.storage.get('leader');
    this.#broadcast({ t: 'members', leader, members: await this.#roster() });
  }

  async #setLeader(id) {
    await this.ctx.storage.put('leader', id);
    await this.ctx.storage.delete('leaderLeftAt');
    await this.#broadcastRoster();
  }

  // Garante que existe um líder: o líder que caiu tem LEADER_GRACE_MS para voltar antes de passar adiante.
  async #ensureLeader() {
    const members = this.#members();
    const leader = await this.ctx.storage.get('leader');
    if (members.some(({ id }) => id === leader)) {
      await this.ctx.storage.delete('leaderLeftAt');
      return;
    }
    if (members.length === 0) return;
    const leftAt = await this.ctx.storage.get('leaderLeftAt');
    if (!leader || (leftAt && Date.now() - leftAt >= LEADER_GRACE_MS)) {
      await this.#setLeader(members[0].id);
    } else if (!leftAt) {
      await this.ctx.storage.put('leaderLeftAt', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + LEADER_GRACE_MS);
    } else {
      await this.ctx.storage.setAlarm(leftAt + LEADER_GRACE_MS);
    }
  }

  async fetch(request) {
    const id = request.headers.get('X-Member');
    const name = request.headers.get('X-Name');

    // Reconexão do mesmo participante substitui o socket antigo.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.id === id) {
        ws.serializeAttachment(null);
        try {
          ws.close(4000, 'replaced');
        } catch {}
      }
    }
    if (this.#members().length >= MAX_MEMBERS) return new Response('room full\n', { status: 403 });

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, joinedAt: Date.now(), status: { state: 'idle', mediaId: null, drift: null } });

    await this.ctx.storage.delete('emptySince');
    await this.#ensureLeader();
    if (!(await this.ctx.storage.get('leader'))) await this.ctx.storage.put('leader', id);

    this.#send(server, {
      t: 'welcome',
      you: id,
      leader: await this.ctx.storage.get('leader'),
      state: (await this.ctx.storage.get('state')) || null,
      members: await this.#roster(),
      now: Date.now(),
    });
    await this.#broadcastRoster();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();
    if (!me || !msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'time':
        return this.#send(ws, { t: 'time', c: finite(msg.c, 0, 1e15) ?? 0, s: Date.now() });

      case 'state': {
        if (me.id !== (await this.ctx.storage.get('leader'))) return this.#send(ws, { t: 'error', error: 'not_leader' });
        const state = cleanState(msg);
        if (!state) return;
        state.at = Date.now();
        await this.ctx.storage.put('state', state);
        return this.#broadcast({ t: 'state', state }, ws);
      }

      case 'status': {
        const status = cleanStatus(msg);
        if (!status) return;
        ws.serializeAttachment({ ...me, status });
        return this.#broadcastRoster();
      }

      case 'promote': {
        if (me.id !== (await this.ctx.storage.get('leader'))) return;
        const to = String(msg.to || '');
        if (!PUBLIC_ID_RE.test(to) || !this.#members().some(({ id }) => id === to)) return;
        return this.#setLeader(to);
      }
    }
  }

  async #left(ws) {
    ws.serializeAttachment(null);
    try {
      ws.close(1000, 'bye');
    } catch {}
    if (this.#members().length === 0) {
      await this.ctx.storage.put('emptySince', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    await this.#ensureLeader();
    await this.#broadcastRoster();
  }

  webSocketClose(ws) {
    return this.#left(ws);
  }

  webSocketError(ws) {
    return this.#left(ws);
  }

  async alarm() {
    if (this.#members().length === 0) {
      const emptySince = await this.ctx.storage.get('emptySince');
      if (!emptySince || Date.now() - emptySince >= ROOM_TTL_MS) return this.ctx.storage.deleteAll();
      return this.ctx.storage.setAlarm(emptySince + ROOM_TTL_MS);
    }
    await this.#ensureLeader();
  }
}
