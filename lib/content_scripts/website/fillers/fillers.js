// Fork: detecção de episódios filler/canon via AnimeFillerList (animefillerlist.com).
//
// Como funciona:
//  1. Casa a série do Crunchyroll com um show do AFL pelo título (índice /shows do AFL).
//     Dá para corrigir manualmente por série (clique no selo do episódio).
//  2. Calcula o número "absoluto" do episódio juntando as temporadas do Crunchyroll
//     (temporadas que reiniciam em 1 são somadas; temporadas já numeradas em sequência ficam como estão).
//     Um deslocamento manual por série cobre os casos em que a contagem do Crunchyroll difere da do AFL.
//  3. Classifica como canon / anime canon / misto / filler e, conforme a configuração, oferece ou faz o skip
//     direto para o próximo episódio que não deve ser pulado.

const Fillers = new (class {
  AFL_ORIGIN = 'https://www.animefillerlist.com';
  OVERRIDES_KEY = 'filler_overrides';
  SKIPPED_KEY = 'ic_filler_last_skip';
  ALLOW_KEY = 'ic_filler_allow';

  TYPES = {
    canon: { label: 'fillerTypeCanon', setting: null },
    anime_canon: { label: 'fillerTypeAnimeCanon', setting: 'skip_anime_canon' },
    mixed: { label: 'fillerTypeMixed', setting: 'skip_mixed' },
    filler: { label: 'fillerTypeFiller', setting: 'skip_filler' },
  };

  #memo = new Map();

  t(key, vars = {}) {
    return Object.entries(vars).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      chrome.i18n.getMessage(key) || key,
    );
  }

  typeLabel(type) {
    return type ? this.t(this.TYPES[type].label) : this.t('fillerNoData');
  }

  skipMode(type) {
    const setting = this.TYPES[type]?.setting;
    return setting ? +chromeStorage[setting] || 0 : 0;
  }

  anySkip() {
    return Object.keys(this.TYPES).some((type) => this.skipMode(type) > 0);
  }

  #once(key, factory) {
    if (!this.#memo.has(key)) {
      const promise = factory();
      promise.catch(() => this.#memo.delete(key));
      this.#memo.set(key, promise);
    }
    return this.#memo.get(key);
  }

  forget(prefix) {
    [...this.#memo.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => this.#memo.delete(key));
  }

  #afl(data) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(chrome.runtime.id, { type: 'afl', data }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.ok) return resolve(response.data);
        reject(new Error(response?.error || 'AFL indisponível'));
      });
    });
  }

  index() {
    return this.#once('afl:index', () => this.#afl({ action: 'index' }));
  }

  show(slug) {
    return this.#once(`afl:show:${slug}`, () =>
      this.#afl({ action: 'show', slug }).then((show) => {
        if (!show) return null;
        return { ...show, slug, byNumber: new Map(show.episodes.map((episode) => [episode.n, episode])) };
      }),
    );
  }

  normalize(text) {
    return (text || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\([^)]*\b(dub|dublado|legendado|sub)\b[^)]*\)/g, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  slugFromInput(input) {
    const value = (input || '').trim();
    const fromUrl = value.match(/animefillerlist\.com\/shows\/([a-z0-9-]+)/i);
    const slug = (fromUrl ? fromUrl[1] : value).toLowerCase();
    return /^[a-z0-9-]+$/.test(slug) ? slug : null;
  }

  getOverrides() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [this.OVERRIDES_KEY]: {} }, (items) => resolve(items[this.OVERRIDES_KEY] || {}));
    });
  }

  async setOverride(seriesId, patch) {
    const overrides = await this.getOverrides();
    const next = patch === null ? undefined : { ...overrides[seriesId], ...patch };
    if (next && Object.keys(next).length) overrides[seriesId] = next;
    else delete overrides[seriesId];
    await chrome.storage.local.set({ [this.OVERRIDES_KEY]: overrides });
    this.forget(`series:${seriesId}`);
  }

  // -> { slug: string|null, offset: number, manual: boolean }
  resolveSeries(seriesId, titles) {
    return this.#once(`series:${seriesId}`, async () => {
      const override = (await this.getOverrides())[seriesId] || {};
      const offset = Number.isFinite(+override.offset) ? +override.offset : 0;
      if (override.slug) return { slug: override.slug, offset, manual: true };

      const index = await this.index();
      for (const title of titles) {
        const wanted = this.normalize(title);
        if (!wanted) continue;
        const match =
          index.find(({ title }) => this.normalize(title) === wanted) ||
          index.find(({ slug }) => slug === wanted.replaceAll(' ', '-'));
        if (match) return { slug: match.slug, offset, manual: Boolean(override.offset) };
      }
      return { slug: null, offset, manual: Boolean(override.offset) };
    });
  }

  // Lista ordenada de todos os episódios da série no Crunchyroll, com número absoluto.
  track(seriesId, audioLocale) {
    return this.#once(`track:${seriesId}:${audioLocale || ''}`, async () => {
      let seasons = [...new Map((await API.seasons(seriesId)).map((season) => [season.id, season])).values()];
      if (audioLocale) {
        const sameAudio = seasons.filter((season) => season.audio_locale === audioLocale);
        if (sameAudio.length) seasons = sameAudio;
      }
      seasons.sort((a, b) => a.season_sequence_number - b.season_sequence_number);
      const lists = await Promise.all(seasons.map((season) => API.episodes(season.id).catch(() => [])));

      const entries = [];
      let counter = 0;
      seasons.forEach((season, i) => {
        const episodes = [...lists[i]].sort((a, b) => a.sequence_number - b.sequence_number);
        const numbered = episodes.filter(({ episode_number }) => Number.isInteger(episode_number));
        const extra = /\b(specials?|ovas?|movies?|films?|filmes?|especia(l|is))\b/i.test(season.title || '');
        const base = counter;
        const continues = numbered.length > 0 && numbered[0].episode_number > base;
        episodes.forEach((episode) => {
          let absolute = null;
          if (!extra && Number.isInteger(episode.episode_number)) {
            absolute = continues ? episode.episode_number : base + episode.episode_number;
            counter = Math.max(counter, absolute);
          }
          const versions = (episode.versions || []).map(({ guid, audio_locale }) => ({ guid, audio_locale }));
          entries.push({
            id: episode.id,
            ids: [episode.id, ...versions.map(({ guid }) => guid)],
            versions,
            absolute,
            slug: episode.slug_title || '',
          });
        });
      });
      return entries;
    });
  }

  aflEpisode(info, entry) {
    if (!info.show || !entry || entry.absolute === null) return null;
    return info.show.byNumber.get(entry.absolute + info.series.offset) || null;
  }

  aflUrl(info, entry) {
    if (!info.series.slug) return `${this.AFL_ORIGIN}/shows`;
    const episode = this.aflEpisode(info, entry);
    return `${this.AFL_ORIGIN}/shows/${info.series.slug}${episode ? `#eps-${episode.n}` : ''}`;
  }

  async episodeInfo(mediaId) {
    const [object] = await API.objects(mediaId);
    const meta = object?.episode_metadata;
    if (!meta) throw new Error('episódio sem metadados');
    const series = await this.resolveSeries(meta.series_id, [meta.series_title, meta.series_slug_title]);
    const [track, show] = await Promise.all([
      this.track(meta.series_id, meta.audio_locale),
      series.slug ? this.show(series.slug).catch(() => null) : null,
    ]);
    const index = track.findIndex(({ ids }) => ids.includes(mediaId));
    return { mediaId, meta, series, show, track, index, entry: track[index] };
  }

  // Próximo episódio que não deve ser pulado, e a lista do que foi pulado até ele.
  nextWatchable(info) {
    const skipped = [];
    for (let i = info.index + 1; i < info.track.length; i++) {
      const entry = info.track[i];
      if (entry.absolute === null) continue; // especiais sem número
      const type = this.aflEpisode(info, entry)?.type;
      if (this.skipMode(type) > 0) {
        skipped.push(entry);
        continue;
      }
      return { target: entry, skipped };
    }
    return { target: null, skipped };
  }

  watchUrl(entry, audioLocale) {
    const id = entry.versions.find((version) => version.audio_locale === audioLocale)?.guid || entry.id;
    const prefix = location.pathname.match(/^(\/[a-z-]+)?(?=\/watch\/)/)?.[0] || '';
    return `${location.origin}${prefix}/watch/${id}/${entry.slug}`;
  }

  #session(key, fallback) {
    try {
      return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  isAllowed(mediaId) {
    return this.#session(this.ALLOW_KEY, []).includes(mediaId);
  }

  allow(mediaId) {
    const allowed = this.#session(this.ALLOW_KEY, []);
    if (!allowed.includes(mediaId)) allowed.push(mediaId);
    sessionStorage.setItem(this.ALLOW_KEY, JSON.stringify(allowed.slice(-50)));
  }

  rememberSkip(record) {
    sessionStorage.setItem(this.SKIPPED_KEY, JSON.stringify(record));
  }

  takeSkip(ids) {
    const record = this.#session(this.SKIPPED_KEY, null);
    if (!record || !ids.includes(record.to)) return null;
    sessionStorage.removeItem(this.SKIPPED_KEY);
    return Date.now() - record.at < 5 * 60 * 1000 ? record : null;
  }

  waitFor(selector, owner, timeout = 15000) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) done(element);
      });
      const timer = setTimeout(() => done(null), timeout);
      const done = (element) => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      };
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      owner.onDestroy(() => done(null));
    });
  }

  ICONS = {
    skip: 'M5 18.5 13.5 12 5 5.5zM15.5 5.5h2.5v13h-2.5z',
    skipped: 'M3 18 11.5 12 3 6zm9.5 0L21 12l-8.5-6z',
  };

  banner({ type, toast, icon, title, detail, actions }) {
    const banner = new Renderer('div').addClass('ic-filler-banner', ...(toast ? ['toast'] : []));
    if (type) banner.setAttribute('data-type', type);
    return banner.appendChildren(
      new Renderer('span')
        .addClass('ic-filler-banner-icon')
        .appendChildren(
          new SvgRenderer('svg')
            .setAttribute('viewBox', '0 0 24 24')
            .appendChildren(new SvgRenderer('path').setAttribute('d', this.ICONS[icon])),
        ),
      new Renderer('div')
        .addClass('ic-filler-banner-text')
        .appendChildren(new Renderer('strong').setText(title), new Renderer('span').setText(detail)),
      new Renderer('div').addClass('ic-filler-banner-actions').appendChildren(
        ...actions.map(({ label, primary, icon, title, onClick }) => {
          const button = new Renderer('button')
            .addClass(...[primary && 'primary', icon && 'icon'].filter(Boolean))
            .setText(label)
            .addEventListener('click', onClick);
          if (title) button.setAttribute('title', title);
          return button;
        }),
      ),
    );
  }

  tag(type) {
    return new Renderer('span')
      .addClass('ic-filler-tag')
      .setAttribute('data-type', type || 'unknown')
      .setText(this.typeLabel(type));
  }
})();

class FillerWatch extends Empty {
  #alive = true;
  #ui = [];

  constructor() {
    super();
    this.mediaId = location.pathname.match(/\/watch\/([A-Z0-9]+)/)?.[1];
    this.onDestroy(() => {
      this.#alive = false;
      this.#clearUi();
    });
    if (!this.mediaId) return;
    chromeStorage.LOADED.then(() => this.run());
  }

  #clearUi() {
    this.#ui.forEach((element) => element.remove());
    this.#ui = [];
  }

  #mount(renderer) {
    this.#ui.push(renderer);
    return renderer;
  }

  async run() {
    this.#clearUi();
    if (!chromeStorage.filler_badges && !Fillers.anySkip()) return;
    let info;
    try {
      info = await Fillers.episodeInfo(this.mediaId);
    } catch (err) {
      console.warn('[Improve Crunchyroll · fillers]', err);
      return;
    }
    if (!this.#alive) return;
    this.info = info;
    this.#arrivalToast();
    if (chromeStorage.filler_badges) this.#badge();
    // Na watch party, quem segue não pula fillers sozinho: vai para onde o líder for.
    const party = typeof PartySync !== 'undefined' ? PartySync : null;
    await party?.ready;
    if (this.#alive && !party?.isFollower()) this.#maybeSkip();
  }

  get #type() {
    return Fillers.aflEpisode(this.info, this.info.entry)?.type || null;
  }

  async #badge() {
    const header = await Fillers.waitFor('.current-media-header', this);
    if (!header || !this.#alive) return;
    const { info } = this;
    const afl = Fillers.aflEpisode(info, info.entry);

    let type;
    let meta = '';
    if (!info.series.slug) type = Fillers.t('fillerShowNotFound');
    else if (!info.show) type = Fillers.t('fillerShowUnavailable');
    else if (afl) {
      type = Fillers.typeLabel(afl.type);
      meta = `AFL #${afl.n}`;
    } else type = Fillers.t('fillerNoData');
    if (info.series.manual) meta = `${meta} ✎`.trim();

    const menu = new Renderer('div')
      .addClass('ic-filler-menu')
      .appendChildren(
        new Renderer('div')
          .addClass('ic-filler-menu-head')
          .appendChildren(
            new Renderer('strong').setText(info.show?.title || Fillers.t('fillerShowNotFound')),
            new Renderer('span').setText(
              afl ? `${Fillers.t('fillerEpisodeN', { n: afl.n })} · “${afl.title}”` : 'AnimeFillerList',
            ),
          ),
      );
    const item = (label, action, muted) =>
      new Renderer('button')
        .addClass('ic-filler-menu-item', ...(muted ? ['muted'] : []))
        .setText(label)
        .addEventListener('click', (event) => {
          event.stopPropagation();
          menu.removeClass('open');
          action();
        });

    menu.appendChildren(
      item(Fillers.t('fillerOpenAfl'), () => window.open(Fillers.aflUrl(info, info.entry), '_blank', 'noopener')),
      item(Fillers.t('fillerFixShow'), () => this.#fixShow()),
      item(Fillers.t('fillerFixOffset'), () => this.#fixOffset()),
    );
    if (info.series.manual) {
      menu.appendChildren(item(Fillers.t('fillerResetFix'), () => this.#apply(null), true));
    }

    const badge = new Renderer('button')
      .addClass('ic-filler-badge')
      .setAttribute('data-type', afl?.type || 'unknown')
      .setAttribute('title', `AnimeFillerList: ${info.show?.title || info.series.slug || '—'}`)
      .appendChildren(
        new Renderer('span').addClass('ic-filler-dot'),
        new Renderer('span').addClass('ic-filler-type').setText(type),
        ...(meta ? [new Renderer('span').addClass('ic-filler-meta').setText(meta)] : []),
        new Renderer('span').addClass('ic-filler-caret'),
      )
      .addEventListener('click', (event) => {
        event.stopPropagation();
        menu.getElement().classList.toggle('open');
      });

    const wrapper = this.#mount(new Renderer('div').addClass('ic-filler-badge-wrapper').appendChildren(badge, menu));
    const close = () => menu.removeClass('open');
    document.addEventListener('click', close);
    this.onDestroy(() => document.removeEventListener('click', close));
    header.append(wrapper.getElement());
  }

  async #apply(patch) {
    await Fillers.setOverride(this.info.meta.series_id, patch);
    this.run();
  }

  #fixShow() {
    const current = this.info.series.slug ? `${Fillers.AFL_ORIGIN}/shows/${this.info.series.slug}` : '';
    const input = prompt(Fillers.t('fillerFixShowPrompt'), current);
    if (input === null) return;
    if (!input.trim()) return this.#apply({ slug: undefined });
    const slug = Fillers.slugFromInput(input);
    if (!slug) return alert(Fillers.t('fillerFixShowInvalid'));
    this.#apply({ slug });
  }

  #fixOffset() {
    const { entry } = this.info;
    const input = prompt(
      Fillers.t('fillerFixOffsetPrompt', {
        crunchyroll: entry?.absolute ?? '?',
        afl: entry?.absolute != null ? entry.absolute + this.info.series.offset : '?',
      }),
      String(this.info.series.offset),
    );
    if (input === null) return;
    const offset = parseInt(input, 10);
    if (!Number.isFinite(offset)) return;
    this.#apply({ offset: offset || undefined });
  }

  #maybeSkip() {
    const type = this.#type;
    const mode = Fillers.skipMode(type);
    if (!mode || Fillers.isAllowed(this.mediaId)) return;

    const { target, skipped } = Fillers.nextWatchable(this.info);
    const fromNumber = Fillers.aflEpisode(this.info, this.info.entry)?.n;
    const toNumber = target ? Fillers.aflEpisode(this.info, target)?.n ?? target.absolute + this.info.series.offset : null;
    const go = () => {
      Fillers.rememberSkip({
        at: Date.now(),
        from: this.mediaId,
        fromUrl: location.href,
        to: target.id,
        fromNumber,
        toNumber,
        count: skipped.length + 1,
      });
      location.assign(Fillers.watchUrl(target, this.info.meta.audio_locale));
    };

    if (mode === 2 && target) return go();

    const banner = this.#mount(
      Fillers.banner({
        type,
        icon: 'skip',
        title: `${Fillers.typeLabel(type)} · AFL #${fromNumber}`,
        detail: Fillers.t(target ? 'fillerBannerAskDetail' : 'fillerBannerNoTargetDetail'),
        actions: [
          ...(target ? [{ label: Fillers.t('fillerSkipTo', { n: toNumber }), primary: true, onClick: go }] : []),
          {
            label: Fillers.t('fillerWatchAnyway'),
            onClick: () => {
              Fillers.allow(this.mediaId);
              banner.remove();
            },
          },
        ],
      }),
    );
    this.#overlay(banner);
  }

  #arrivalToast() {
    const record = Fillers.takeSkip(this.info.entry?.ids || [this.mediaId]);
    if (!record) return;
    const range =
      record.count > 1 && record.toNumber ? `#${record.fromNumber}–#${record.toNumber - 1}` : `#${record.fromNumber}`;
    const toast = this.#mount(
      Fillers.banner({
        toast: true,
        icon: 'skipped',
        title: Fillers.t('fillerSkippedTitle'),
        detail: Fillers.t('fillerSkippedDetail', { count: record.count, range }),
        actions: [
          {
            label: Fillers.t('fillerGoBack'),
            onClick: () => {
              Fillers.allow(record.from);
              location.assign(record.fromUrl);
            },
          },
          { label: '✕', icon: true, title: Fillers.t('fillerClose'), onClick: () => toast.remove() },
        ],
      }),
    );
    this.#overlay(toast);
    const timer = setTimeout(() => toast.remove(), 15000);
    this.onDestroy(() => clearTimeout(timer));
  }

  #overlay(renderer) {
    const place = () => (document.fullscreenElement || document.body).append(renderer.getElement());
    place();
    document.addEventListener('fullscreenchange', place);
    this.onDestroy(() => document.removeEventListener('fullscreenchange', place));
  }
}

class FillerSeriesCards extends Empty {
  #alive = true;

  constructor(seriesId) {
    super();
    this.seriesId = seriesId;
    this.onDestroy(() => {
      this.#alive = false;
      document.querySelectorAll('.ic-filler-tag').forEach((tag) => tag.remove());
    });
    chromeStorage.LOADED.then(() => chromeStorage.filler_badges && this.run());
  }

  async run() {
    let info;
    try {
      const [series] = await API.objects(this.seriesId);
      const resolved = await Fillers.resolveSeries(this.seriesId, [series?.title, series?.slug_title]);
      if (!resolved.slug) return;
      const [track, show] = await Promise.all([Fillers.track(this.seriesId, null), Fillers.show(resolved.slug)]);
      if (!show) return;
      info = { series: resolved, show, track };
    } catch (err) {
      console.warn('[Improve Crunchyroll · fillers]', err);
      return;
    }
    if (!this.#alive) return;

    const byId = new Map();
    info.track.forEach((entry) => entry.ids.forEach((id) => byId.set(id, entry)));

    const decorate = () => {
      document.querySelectorAll('.erc-season-with-navigation .card').forEach((card) => {
        if (card.querySelector('.ic-filler-tag')) return;
        const id = card.querySelector('a[href*="/watch/"]')?.href.match(/\/watch\/([A-Z0-9]+)/)?.[1];
        const episode = id && Fillers.aflEpisode(info, byId.get(id));
        if (!episode) return;
        const body = card.querySelector("[class^='playable-card__body']") || card;
        body.append(Fillers.tag(episode.type).setAttribute('title', `AFL #${episode.n} · ${episode.title}`).getElement());
      });
    };

    let pending;
    const observer = new MutationObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(decorate, 150);
    });
    observer.observe(document.getElementById('content') || document.body, { childList: true, subtree: true });
    this.onDestroy(() => {
      observer.disconnect();
      clearTimeout(pending);
    });
    decorate();
  }
}
