importScripts('party.js');

// --- AnimeFillerList (fork: detecção de fillers) ---------------------------
// Só lê páginas públicas do animefillerlist.com. Nada é enviado para lá além do GET.
const AFL_ORIGIN = 'https://www.animefillerlist.com';
const AFL_CACHE = 'afl-v1';
const AFL_TTL = { index: 7 * 24 * 3600 * 1000, show: 24 * 3600 * 1000 };
const AFL_TYPES = {
  manga_canon: 'canon',
  anime_canon: 'anime_canon',
  'mixed_canon/filler': 'mixed',
  filler: 'filler',
};

function aflDecode(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : entity;
      }
      return named[code.toLowerCase()] ?? entity;
    })
    .trim();
}

function aflParseIndex(html) {
  const seen = new Set();
  const shows = [];
  for (const [, slug, title] of html.matchAll(/<a href="\/shows\/([a-z0-9-]+)">([^<]+)<\/a>/g)) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    shows.push({ slug, title: aflDecode(title) });
  }
  return shows;
}

function aflParseShow(html) {
  const episodes = [];
  for (const [, classes, number, row] of html.matchAll(/<tr class="([^"]*)" id="eps-(\d+)">([\s\S]*?)<\/tr>/g)) {
    const type = AFL_TYPES[classes.split(/\s+/)[0]];
    if (!type) continue;
    const [, title = ''] = row.match(/<td class="Title">([\s\S]*?)<\/td>/) || [];
    episodes.push({ n: +number, type, title: aflDecode(title) });
  }
  const [, heading = ''] = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [];
  return { title: aflDecode(heading).replace(/\s*Filler List$/i, ''), episodes };
}

async function aflCached(key, ttl, load) {
  const cache = await caches.open(AFL_CACHE);
  const request = new Request(`${AFL_ORIGIN}/__ic_cache__/${key}`);
  let stale;
  const hit = await cache.match(request);
  if (hit) {
    stale = await hit.json();
    if (Date.now() - stale.at < ttl) return stale.data;
  }
  try {
    const data = await load();
    await cache.put(request, new Response(JSON.stringify({ at: Date.now(), data })));
    return data;
  } catch (err) {
    if (stale) return stale.data; // offline / site fora do ar: usa o que tiver
    throw err;
  }
}

async function aflFetch(path) {
  const response = await fetch(`${AFL_ORIGIN}${path}`, { credentials: 'omit' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AFL ${response.status}`);
  return response.text();
}

function aflHandle({ action, slug, refresh }) {
  if (action === 'index') {
    return aflCached('index', refresh ? 0 : AFL_TTL.index, async () => aflParseIndex((await aflFetch('/shows')) || ''));
  }
  if (action === 'show') {
    if (!/^[a-z0-9-]{1,120}$/.test(slug || '')) return Promise.reject(new Error('slug inválido'));
    return aflCached(`show/${slug}`, refresh ? 0 : AFL_TTL.show, async () => {
      const html = await aflFetch(`/shows/${slug}`);
      return html === null ? null : aflParseShow(html);
    });
  }
  return Promise.reject(new Error('ação inválida'));
}
// ---------------------------------------------------------------------------

function fetchSkipEvents(mediaId) {
  return fetch(`https://static.crunchyroll.com/skip-events/production/${mediaId}.json`)
    .then((response) => response.json())
    .then((data) => {
      return Object.entries(data).reduce((acc, [type, { start, end }]) => {
        if (typeof start === 'number' && typeof end === 'number') {
          acc.push({ start, end, native: true, type });
        }
        return acc;
      }, []);
    });
}

chrome.runtime.onMessage.addListener(function ({ type, data }, sender, sendResponse) {
  const tabId = sender.tab?.id;
  switch (type) {
    case 'party':
      partyHandle(data, sender)
        .then((info) => sendResponse({ ok: true, info }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case 'afl':
      aflHandle(data || {})
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case 'message':
      chrome.tabs.sendMessage(tabId, data);
      return true;
    case 'anilist':
      const { query } = data;
      fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }).then((response) => response
        .json()
        .then((json) => sendResponse(json)),
      );
      return true;
    case 'skippers':
      const {
        metadata: { id: mediaId, duration, episode_number, title },
        subtitles,
      } = data;
      Promise.all([
        new Promise((resolve) => {
          chrome.tabs.sendMessage(
            tabId,
            {
              type,
              data: { mediaId, episode_number, title, subtitles },
            },
            ([currentSubtitles, previousSubtitles]) => {
              let urls;
              const enUSInCurrentSubtitle = 'en-US' in currentSubtitles;
              if (enUSInCurrentSubtitle && 'en-US' in previousSubtitles) {
                urls = [currentSubtitles['en-US'].url, previousSubtitles['en-US'].url];
              } else {
                const currentSubtitlesKeys = Object.keys(currentSubtitles);
                const key = currentSubtitlesKeys.find((language) => {
                  return language in previousSubtitles;
                });
                if (key) {
                  urls = [currentSubtitles[key].url, previousSubtitles[key].url];
                } else {
                  if (enUSInCurrentSubtitle) {
                    urls = [currentSubtitles['en-US'].url];
                  } else if (currentSubtitlesKeys.length > 0) {
                    urls = [currentSubtitles[currentSubtitlesKeys[0]].url];
                  } else {
                    return resolve([]);
                  }
                }
              }
              return Promise.all(
                urls.map((url) =>
                  chrome.tabs.sendMessage(tabId, {
                      type: 'fetch',
                      data: {
                        url,
                      },
                    })
                    .then((text) => {
                      return (text.match(/Dialogue:.*/g) ?? []).reduce((acc, dialogue) => {
                        const [layer, startText, endText, style, name, marginL, marginR, marginV, effect, ...texts] =
                          dialogue.split(',');
                        const [start, end] = [startText, endText].map((text) =>
                          text
                            .split(':')
                            .reverse()
                            .reduce((acc, v, i) => acc + ~~v * Math.pow(60, i), 0),
                        );
                        const type = `${style}-${name}`;
                        if (!type.match(/title|sign|show/i)) {
                          acc.push({
                            start,
                            end,
                            key: `${type}-${texts.join().replaceAll(/({[^}]*})|(\\.)/g, '')}`,
                          });
                        }
                        return acc;
                      }, []);
                    }),
                ),
              ).then((subs) => {
                const MIN_DURATION = 75;
                const currentSub = subs.shift();
                const durationInSeconds = duration / 1000;
                const MAX_DURATION = durationInSeconds / 4;
                const fake = {
                  start: durationInSeconds,
                  end: durationInSeconds,
                };
                currentSub.push(fake, fake);
                const keys = new Set(subs.map((sub) => sub.map((s) => s.key)).flat());
                let lastGroup;
                let lastValue = { end: 0 };
                resolve(
                  currentSub.reduce((acc, value) => {
                    if (keys.has(value.key) || value.start - lastValue.end >= MIN_DURATION) {
                      if (!lastGroup) {
                        lastGroup = {
                          start: lastValue.end,
                          end: value.start,
                        };
                      }
                    } else {
                      if (lastGroup) {
                        if (lastGroup.end !== lastValue.start) {
                          lastGroup.end = value.start;
                        }
                        const lastGroupDuration = lastGroup.end - lastGroup.start;
                        if (MIN_DURATION <= lastGroupDuration && lastGroupDuration <= MAX_DURATION) {
                          acc.push(lastGroup);
                        }
                        lastGroup = undefined;
                      }
                    }
                    lastValue = value;
                    return acc;
                  }, []),
                );
              });
            },
          );
        }).catch((err) => []),
        fetchSkipEvents(mediaId).catch((err) => []),
      ])
        .then(([skippers, nativeSkippers]) =>
          nativeSkippers.length
            ? [
              ...skippers.filter(
                ({ start, end }) =>
                  !nativeSkippers.some(
                    ({ start: nativeStart, end: nativeEnd }) =>
                      (nativeStart <= start && start <= nativeEnd) || (start <= nativeStart && nativeStart <= end),
                  ),
              ),
              ...nativeSkippers,
            ].sort((a, b) => a.start - b.start)
            : skippers,
        )
        .then((data) => {
          sendResponse(data);
        })
        .catch(() => {
          sendResponse([]);
        });
      return true;
    case 'nativeSkippers': {
      const { mediaId } = data;
      fetchSkipEvents(mediaId)
        .then((data) => {
          sendResponse(data);
        })
        .catch(() => {
          sendResponse([]);
        });
      return true;
    }
    default:
      sendResponse();
  }
});
