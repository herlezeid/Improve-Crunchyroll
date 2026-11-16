// Watch party (fork): sincroniza o player desta aba com o líder da sala.
//
// Líder: manda o estado (episódio, play/pause, posição, velocidade) a cada evento do player e a cada 3 s.
//        Ao trocar de episódio, segura o play até todo mundo estar pronto (ou 30 s, ou "Começar agora").
// Quem segue: abre o mesmo episódio (no próprio idioma de áudio), segue play/pause e corrige a diferença:
//        > 2,5 s pula para a posição do líder (no máximo a cada 5 s, mirando à frente o tempo que o pulo
//        costuma levar para carregar); diferenças menores ajustam a velocidade aos poucos, com histerese.
//        Os skips próprios (abertura, filler) ficam desligados: quem decide é o líder.

const PartySync = new (class {
  SEEK_THRESHOLD = 2.5;
  PAUSED_SEEK_THRESHOLD = 0.75;
  SEEK_COOLDOWN = 5000;
  PAUSED_SEEK_COOLDOWN = 1500;
  NUDGE_START = 0.4;
  NUDGE_STOP = 0.12;
  NUDGE_GAIN = 0.12; // velocidade extra por segundo de diferença
  NUDGE_MAX = 0.15;
  SYNCED = 1.0;
  LEADER_STALL_MS = 2000;
  HOLD_TIMEOUT = 30000;
  HEARTBEAT_TICKS = 3;

  port = null;
  info = null;
  state = null;
  video = null;
  mediaId = null;
  ready;
  #resolveReady;
  #detach = [];
  #tick = 0;
  #seq = 0;
  #applyingUntil = 0;
  #nudging = false;
  #seekLead = 0.5;
  #lastSeek = null;
  #stallSince = 0;
  #stallSent = false;
  #blocked = false;
  #hold = null;
  #holdPaused = false;
  #episodes = new Map();
  #navigation = { id: null, at: 0 };
  #lastStatus = { key: '', at: 0 };
  #lastUserInput = 0;
  #toastAt = 0;
  #ui = null;
  #expanded = false;
  #audioFor = null;

  constructor() {
    this.ready = new Promise((resolve) => (this.#resolveReady = resolve));
    setTimeout(() => this.#resolveReady(), 1500);
    ['pointerdown', 'keydown'].forEach((type) =>
      document.addEventListener(type, () => (this.#lastUserInput = Date.now()), true),
    );
    document.addEventListener('fullscreenchange', () => this.#placeUi());
    this.#connect();
    this.#checkInvite();
    this.onPage();
  }

  // ---- papel -------------------------------------------------------------------------------------

  get #active() {
    return Boolean(this.info?.inRoom && this.info.active);
  }

  isLeader() {
    return this.#active && this.info.connection === 'online' && this.info.isLeader;
  }

  isFollower() {
    return this.#active && !this.info.isLeader;
  }

  #t(key, vars = {}) {
    return Object.entries(vars).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      chrome.i18n.getMessage(key) || key,
    );
  }

  // ---- ponte com o background ---------------------------------------------------------------------

  #connect() {
    try {
      this.port = chrome.runtime.connect({ name: 'party' });
    } catch {
      return; // extensão recarregada: este content script ficou órfão
    }
    this.port.onMessage.addListener((msg) => this.#onMessage(msg));
    this.port.onDisconnect.addListener(() => {
      this.port = null;
      setTimeout(() => this.#connect(), 1000);
    });
    this.#post({ t: 'hello' });
  }

  #post(msg) {
    try {
      this.port?.postMessage(msg);
    } catch {}
  }

  #onMessage(msg) {
    if (msg.t === 'room') {
      const wasLeader = this.isLeader();
      this.info = msg.info;
      this.#resolveReady();
      if (!this.#active) {
        this.#hold = null;
        this.#restoreRate();
      } else if (this.isLeader() && !wasLeader) {
        this.#sendState();
      }
      if (this.isFollower()) this.#rememberAudio();
      this.#checkHold();
      this.#renderUi();
    } else if (msg.t === 'state') {
      this.state = msg.state;
      if (this.isFollower()) this.#follow();
    }
  }

  #party(data) {
    return chrome.runtime.sendMessage(chrome.runtime.id, { type: 'party', data });
  }

  #checkInvite() {
    const match = location.hash.match(/icparty=([A-Za-z0-9_-]{16,64})/);
    if (!match) return;
    const server = new URLSearchParams(location.hash.slice(1)).get('ics') || '';
    history.replaceState(history.state, '', location.pathname + location.search);
    chrome.storage.local.get(['party_name', 'party_server'], async ({ party_name, party_server }) => {
      const host = server ? ` (${server.replace(/^wss?:\/\//, '')})` : '';
      const name = prompt(this.#t('partyInvitePrompt', { server: host }), party_name || '');
      if (!name?.trim()) return;
      const response = await this.#party({ action: 'join', room: match[1], name, server: server || party_server || '' });
      if (!response?.ok) alert(this.#t('partyJoinFailed'));
    });
  }

  // ---- página e player ----------------------------------------------------------------------------

  onPage() {
    const mediaId = location.pathname.match(/\/watch\/([A-Z0-9]+)/)?.[1] || null;
    if (mediaId === this.mediaId && (!mediaId || this.video?.isConnected)) return;
    const previous = this.mediaId;
    this.#release();
    this.mediaId = mediaId;
    if (this.isLeader()) {
      const others = this.info.members.filter(({ leader }) => !leader).length;
      this.#hold = mediaId && mediaId !== previous && others > 0 ? { mediaId, until: Date.now() + this.HOLD_TIMEOUT } : null;
      this.#sendState();
    }
    if (mediaId) this.#waitVideo();
    this.#renderUi();
  }

  #release() {
    this.#detach.forEach((fn) => fn());
    this.#detach = [];
    this.video = null;
    this.#nudging = false;
    this.#blocked = false;
    this.#holdPaused = false;
  }

  #waitVideo() {
    const found = document.querySelector('video');
    if (found) return this.#attach(found);
    const observer = new MutationObserver(() => {
      const video = document.querySelector('video');
      if (video) {
        observer.disconnect();
        this.#attach(video);
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    this.#detach.push(() => observer.disconnect());
  }

  #attach(video) {
    this.video = video;
    const on = (type, listener) => {
      video.addEventListener(type, listener);
      this.#detach.push(() => video.removeEventListener(type, listener));
    };
    ['play', 'pause', 'seeked', 'ratechange'].forEach((type) => on(type, (event) => this.#onVideoEvent(event)));
    on('playing', () => this.#onPlaying());
    on('waiting', () => {
      this.#stallSince ||= Date.now();
      if (this.isFollower()) this.#reportStatus('buffering');
    });
    on('canplay', () => this.isFollower() && this.#follow());
    const timer = setInterval(() => this.#onTick(), 1000);
    this.#detach.push(() => clearInterval(timer));
    if (this.isFollower()) this.#rememberAudio();
    this.#onTick();
  }

  #onTick() {
    this.#tick++;
    if (this.isLeader()) {
      this.#checkHold();
      // Travada longa do líder: avisa para todo mundo esperar (as curtas não pausam ninguém).
      const longStall = this.#leaderStalled();
      if (longStall && !this.#stallSent) {
        this.#stallSent = true;
        this.#sendState();
      } else if (this.#tick % this.HEARTBEAT_TICKS === 0) this.#sendState();
    } else if (this.isFollower()) {
      this.#follow();
    }
  }

  #onVideoEvent(event) {
    if (this.isLeader()) return this.#sendState();
    if (!this.isFollower() || Date.now() < this.#applyingUntil) return;
    if (event.type === 'ratechange' && this.#nudging) return;
    if (Date.now() - this.#lastUserInput < 1500 && Date.now() - this.#toastAt > 4000) {
      this.#toastAt = Date.now();
      this.#toast(this.#t('partyLeaderOnly'));
    }
    this.#follow();
  }

  #onPlaying() {
    this.#stallSince = 0;
    this.#stallSent = false;
    if (this.isLeader()) {
      if (this.#hold && this.#hold.mediaId === this.mediaId && this.#pendingMembers().length) {
        this.#holdPaused = true;
        this.video.pause();
        this.#renderUi();
      }
      this.#sendState();
    } else if (this.isFollower()) {
      this.#blocked = false;
      this.#follow();
    }
  }

  // ---- líder ---------------------------------------------------------------------------------------

  #leaderStalled() {
    return Boolean(this.#stallSince && this.video?.readyState < 3 && Date.now() - this.#stallSince > this.LEADER_STALL_MS);
  }

  #sendState() {
    if (!this.isLeader()) return;
    const video = this.mediaId ? this.video : null;
    this.#post({
      t: 'state',
      mediaId: this.mediaId,
      playing: Boolean(video && !video.paused && !video.ended && !this.#leaderStalled()),
      position: video ? video.currentTime || 0 : 0,
      rate: video ? video.playbackRate || 1 : 1,
      seq: ++this.#seq,
    });
  }

  #pendingMembers() {
    if (!this.#hold || !this.info) return [];
    return this.info.members.filter(
      ({ leader, status }) => !leader && !(status?.state === 'ready' && status.mediaId === this.#hold.mediaId),
    );
  }

  #checkHold() {
    if (!this.#hold) return;
    if (!this.isLeader() || this.#hold.mediaId !== this.mediaId) {
      this.#hold = null;
      return this.#renderUi();
    }
    if (!this.#pendingMembers().length || Date.now() > this.#hold.until) this.#releaseHold();
    else this.#renderUi();
  }

  #releaseHold() {
    this.#hold = null;
    if (this.#holdPaused && this.video) {
      this.#holdPaused = false;
      this.video.play().catch(() => {});
    }
    this.#renderUi();
  }

  // ---- quem segue ----------------------------------------------------------------------------------

  async #episode(leaderMediaId) {
    if (!this.#episodes.has(leaderMediaId)) {
      const lookup = (async () => {
        const [object] = await API.objects(leaderMediaId);
        const meta = object?.episode_metadata;
        if (!meta) return null;
        const versions = meta.versions || [];
        return {
          leaderId: leaderMediaId,
          ids: new Set([leaderMediaId, ...versions.map(({ guid }) => guid)]),
          versions,
          slug: object.slug_title || '',
        };
      })().catch(() => null);
      this.#episodes.set(leaderMediaId, lookup);
    }
    return this.#episodes.get(leaderMediaId);
  }

  async #rememberAudio() {
    if (!this.mediaId || this.#audioFor === this.mediaId) return;
    this.#audioFor = this.mediaId;
    try {
      const [object] = await API.objects(this.mediaId);
      const audio = object?.episode_metadata?.audio_locale;
      if (audio) sessionStorage.setItem('ic_party_audio', audio);
    } catch {}
  }

  async #navigate(episode) {
    const now = Date.now();
    if (this.#navigation.id === episode.leaderId && now - this.#navigation.at < 15000) return;
    this.#navigation = { id: episode.leaderId, at: now };
    const audio = sessionStorage.getItem('ic_party_audio') || (await API.PROFILE.catch(() => ({})))?.preferred_content_audio_language;
    const id = episode.versions.find(({ audio_locale }) => audio_locale === audio)?.guid || episode.leaderId;
    this.#reportStatus('loading', this.state?.mediaId);
    const first = location.pathname.split('/')[1];
    const prefix = /^[a-z]{2}(-[a-z]{2})?$/.test(first) ? `/${first}` : '';
    location.assign(`${location.origin}${prefix}/watch/${id}/${episode.slug}`);
  }

  #expected(state) {
    const elapsed = state.playing ? (Math.max(0, Date.now() - state.localAt) / 1000) * state.rate : 0;
    const position = state.position + elapsed;
    return this.video?.duration ? Math.min(position, this.video.duration) : position;
  }

  #apply(action) {
    this.#applyingUntil = Date.now() + 1500;
    return action();
  }

  #seek(time, playing) {
    this.#lastSeek = { at: Date.now(), playing, settled: false };
    this.#apply(() => {
      const slider = this.#sliderWorks !== false && document.querySelector('[data-testid="timeline-controls-container"] input[type="range"]');
      if (slider) {
        // Mesmo caminho do avanço/retrocesso da extensão: passa pela barra do player.
        slider.value = time;
        slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        // Se a barra não levar o vídeo até lá (player novo, passo arredondado), vai direto no vídeo.
        const video = this.video;
        setTimeout(() => {
          if (video !== this.video || video.seeking) return;
          const ok = Math.abs(video.currentTime - time) < 1.5;
          if (this.#sliderWorks === undefined || !ok) this.#sliderWorks = ok;
          if (!ok) this.#apply(() => (video.currentTime = time));
        }, 600);
      } else {
        this.video.currentTime = time;
      }
    });
  }

  #sliderWorks = undefined;

  #setRate(rate, nudging = false) {
    this.#nudging = nudging;
    if (Math.abs(this.video.playbackRate - rate) > 0.001) this.#apply(() => (this.video.playbackRate = rate));
  }

  #restoreRate() {
    if (this.#nudging && this.video) this.#setRate(this.state?.rate || 1);
    this.#nudging = false;
  }

  async #follow() {
    const state = this.state;
    if (!state || !this.isFollower()) return;
    if (!state.mediaId) {
      if (this.video && !this.video.paused) this.#apply(() => this.video.pause());
      return this.#reportStatus('idle', null);
    }

    const episode = await this.#episode(state.mediaId);
    if (state !== this.state || !this.isFollower()) return;
    if (!episode) return this.#reportStatus('unavailable', state.mediaId);
    if (!this.mediaId || !episode.ids.has(this.mediaId)) return this.#navigate(episode);

    const video = this.video;
    if (!video || video.readyState < 2) return this.#reportStatus('loading', state.mediaId);

    if (state.playing && video.paused && !this.#blocked) {
      this.#apply(() =>
        video.play().catch((err) => {
          if (err?.name === 'NotAllowedError') {
            this.#blocked = true;
            this.#reportStatus('blocked', state.mediaId);
            this.#renderUi();
          }
        }),
      );
    } else if (!state.playing && !video.paused) {
      this.#apply(() => video.pause());
    }

    // Durante um pulo ou carregamento a posição não diz nada: espera estabilizar.
    if (video.seeking || (state.playing && video.readyState < 3)) return this.#reportStatus('buffering', state.mediaId);

    const now = Date.now();
    const expected = this.#expected(state);
    const drift = video.currentTime - expected;

    // Primeira leitura estável depois de um pulo: aprende quanto o pulo atrasa e mira melhor no próximo.
    if (this.#lastSeek && !this.#lastSeek.settled) {
      this.#lastSeek.settled = true;
      if (this.#lastSeek.playing && state.playing) {
        this.#seekLead = Math.min(4, Math.max(0, this.#seekLead - drift * 0.7));
      }
    }

    const limit = state.playing ? this.SEEK_THRESHOLD : this.PAUSED_SEEK_THRESHOLD;
    const cooldown = state.playing ? this.SEEK_COOLDOWN : this.PAUSED_SEEK_COOLDOWN;
    const canSeek = !this.#lastSeek || now - this.#lastSeek.at > cooldown;
    if (Math.abs(drift) > limit && canSeek) {
      this.#seek(expected + (state.playing ? this.#seekLead : 0), state.playing);
      this.#setRate(state.rate);
    } else if (state.playing && Math.abs(drift) > (this.#nudging ? this.NUDGE_STOP : this.NUDGE_START)) {
      // Corrige aos poucos, proporcional à diferença (sem ficar ligando e desligando).
      const correction = Math.min(this.NUDGE_MAX, Math.abs(drift) * this.NUDGE_GAIN + 0.02);
      const rate = state.rate * (drift > 0 ? 1 - correction : 1 + correction);
      if (!this.#nudging || Math.abs(video.playbackRate - rate) > 0.02) this.#setRate(rate, true);
    } else {
      this.#setRate(state.rate);
      this.#nudging = false;
    }

    const synced = Math.abs(drift) < this.SYNCED;
    this.#reportStatus(this.#blocked ? 'blocked' : synced ? 'ready' : 'buffering', state.mediaId, drift);
  }

  #reportStatus(state, mediaId = this.state?.mediaId ?? null, drift = null) {
    if (!this.isFollower()) return;
    const key = `${state}|${mediaId}|${drift === null ? '' : Math.round(drift * 2)}`;
    const now = Date.now();
    if (key === this.#lastStatus.key && now - this.#lastStatus.at < 10000) return;
    this.#lastStatus = { key, at: now };
    this.#post({ t: 'status', state, mediaId, drift });
  }

  // ---- interface ------------------------------------------------------------------------------------

  #statusLabel(status) {
    return this.#t(`partyStatus_${status?.state || 'idle'}`);
  }

  #avatar(name) {
    const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
    return new Renderer('span')
      .addClass('ic-party-avatar')
      .setStyle('background', `hsl(${hue} 45% 34%)`)
      .setText((name.trim()[0] || '?').toUpperCase());
  }

  #notice({ text, detail, action, onAction }) {
    return new Renderer('div')
      .addClass('ic-party-notice')
      .appendChildren(
        new Renderer('div')
          .addClass('ic-party-notice-text')
          .appendChildren(new Renderer('strong').setText(text), ...(detail ? [new Renderer('span').setText(detail)] : [])),
        new Renderer('button').addClass('ic-party-primary').setText(action).addEventListener('click', onAction),
      );
  }

  #renderUi() {
    if (!this.#active) {
      this.#ui?.remove();
      this.#ui = null;
      return;
    }
    if (!this.#ui) {
      this.#ui = new Renderer('div').addClass('ic-party');
      this.#placeUi();
    }
    const info = this.info;
    const leader = info.members.find(({ leader }) => leader);
    const ordered = [...info.members].sort(
      (a, b) => b.leader - a.leader || (b.id === info.you) - (a.id === info.you) || a.name.localeCompare(b.name),
    );
    const ui = this.#ui.removeChildren();
    ui.setAttribute('data-connection', info.connection).setAttribute('data-expanded', String(this.#expanded));

    const role =
      info.connection !== 'online'
        ? this.#t('partyReconnectingShort')
        : info.isLeader
          ? this.#t('partyYouLeadShort')
          : this.#t('partyFollowingShort', { name: leader?.name || '…' });

    const pending = this.isLeader() ? this.#pendingMembers() : [];
    if (pending.length) {
      ui.appendChildren(
        this.#notice({
          text: this.#t('partyWaitingTitle'),
          detail: this.#t('partyWaiting', { names: pending.map(({ name }) => name).join(', ') }),
          action: this.#t('partyStartNow'),
          onAction: () => this.#releaseHold(),
        }),
      );
    }
    if (this.isFollower() && this.#blocked) {
      ui.appendChildren(
        this.#notice({
          text: this.#t('partyAutoplayBlocked'),
          action: this.#t('partyClickToSync'),
          onAction: () => {
            this.#blocked = false;
            this.video?.play().catch(() => {});
            this.#follow();
            this.#renderUi();
          },
        }),
      );
    }

    if (this.#expanded) {
      const list = new Renderer('div').addClass('ic-party-panel');
      list.appendChildren(
        new Renderer('div')
          .addClass('ic-party-panel-head')
          .appendChildren(
            new Renderer('strong').setText('Watch party'),
            new Renderer('span').setText(this.#t('partyPeople', { count: info.members.length })),
          ),
      );
      ordered.forEach((member) => {
        const state = member.leader ? 'leader' : member.status?.state || 'idle';
        const row = new Renderer('div')
          .addClass('ic-party-member')
          .setAttribute('data-state', state)
          .appendChildren(
            this.#avatar(member.name),
            new Renderer('div')
              .addClass('ic-party-member-text')
              .appendChildren(
                new Renderer('span')
                  .addClass('ic-party-name')
                  .setText(member.name + (member.id === info.you ? ` · ${this.#t('partyYou')}` : '')),
                new Renderer('span')
                  .addClass('ic-party-status')
                  .appendChildren(
                    new Renderer('i').addClass('ic-party-dot'),
                    new Renderer('span').setText(member.leader ? this.#t('partyLeader') : this.#statusLabel(member.status)),
                  ),
              ),
          );
        if (info.isLeader && !member.leader) {
          row.appendChildren(
            new Renderer('button')
              .addClass('ic-party-ghost')
              .setText(this.#t('partyPromoteShort'))
              .setAttribute('title', this.#t('partyPromote'))
              .addEventListener('click', () => this.#party({ action: 'promote', to: member.id })),
          );
        }
        list.appendChildren(row);
      });
      ui.appendChildren(list);
    }

    ui.appendChildren(
      new Renderer('button')
        .addClass('ic-party-pill')
        .setAttribute('title', 'Watch party')
        .appendChildren(
          new Renderer('span')
            .addClass('ic-party-stack')
            .appendChildren(...ordered.slice(0, 3).map((member) => this.#avatar(member.name))),
          new Renderer('span')
            .addClass('ic-party-pill-text')
            .appendChildren(new Renderer('strong').setText('Watch party'), new Renderer('span').setText(role)),
          new Renderer('i').addClass('ic-party-dot', 'connection'),
        )
        .addEventListener('click', () => {
          this.#expanded = !this.#expanded;
          this.#renderUi();
        }),
    );
  }

  #placeUi() {
    if (this.#ui) (document.fullscreenElement || document.body).append(this.#ui.getElement());
  }

  #toast(text) {
    const toast = new Renderer('div').addClass('ic-party-toast').setText(text);
    (document.fullscreenElement || document.body).append(toast.getElement());
    setTimeout(() => toast.remove(), 3500);
  }
})();
