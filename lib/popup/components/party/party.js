// Watch party (fork): criar/entrar/sair de uma sala e ver quem está nela.
core.components.party = () => {
  const root = new Renderer('div').addClass('party');
  const t = (key, vars = {}) =>
    Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), Renderer.translate(key));
  const KNOWN_ERRORS = ['name', 'server', 'room', 'background'];
  let info = null;
  let prefs = { party_name: '', party_server: '' };
  let error = '';
  let busy = false;

  const send = async (data) => {
    const response = await chrome.runtime.sendMessage({ type: 'party', data });
    if (!response?.ok) throw new Error(response?.error || 'error');
    return response.info;
  };

  const run = async (data) => {
    busy = true;
    error = '';
    render();
    try {
      info = await send(data);
    } catch (err) {
      error = t(`partyError_${KNOWN_ERRORS.includes(err.message) ? err.message : 'generic'}`);
    }
    busy = false;
    render();
  };

  const el = (tag, ...classes) => new Renderer(tag).addClass(...classes);
  const text = (tag, className, value) => el(tag, className).setText(value);

  const input = (value, placeholder) =>
    new InputRenderer('input')
      .addClass('party-input')
      .setAttribute('type', 'text')
      .setAttribute('spellcheck', 'false')
      .setAttribute('placeholder', placeholder || '')
      .setValue(value || '');

  const button = (label, action, variant = 'secondary') =>
    new InputRenderer('button')
      .addClass('party-button', variant)
      .setText(label)
      .setDisabled(busy)
      .addEventListener('click', action);

  const card = (...children) => el('div', 'party-card').appendChildren(...children);
  const label = (value) => text('div', 'party-label', value);

  const avatar = (name) => {
    const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
    return el('span', 'party-avatar')
      .setStyle('background', `hsl(${hue} 45% 34%)`)
      .setText((name.trim()[0] || '?').toUpperCase());
  };

  function renderOutside() {
    const name = input(prefs.party_name, t('partyNamePlaceholder')).setAttribute('maxlength', '24');
    const code = input('', t('partyCodePlaceholder'));
    const server = input(prefs.party_server, info?.defaultServer);
    const common = () => ({ name: name.getValue(), server: server.getValue() });

    root.appendChildren(
      el('div', 'party-hero').appendChildren(
        el('span', 'party-hero-icon').appendChildren(
          new SvgRenderer('svg')
            .setAttribute('viewBox', '0 0 24 24')
            .appendChildren(
              new SvgRenderer('path').setAttribute(
                'd',
                'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m7.5-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6M9 13c-3.3 0-7 1.6-7 4v3h14v-3c0-2.4-3.7-4-7-4m7.5-1c-.5 0-1 0-1.6.1 1.3.9 2.1 2.2 2.1 3.9v3h5v-2.5c0-2.4-2.7-4.5-5.5-4.5',
              ),
            ),
        ),
        el('div', 'party-hero-text').appendChildren(
          text('strong', 'party-hero-title', t('partyHeroTitle')),
          text('span', 'party-hero-sub', t('partyIntro')),
        ),
      ),
      label(t('partyName')),
      card(el('div', 'party-card-body').appendChildren(name, button(t('partyCreate'), () => run({ action: 'create', ...common() }), 'primary'))),
      label(t('partyJoinSection')),
      card(
        el('div', 'party-card-body', 'row').appendChildren(
          code,
          button(t('partyJoin'), () => run({ action: 'join', room: code.getValue(), ...common() })),
        ),
      ),
      el('details', 'party-advanced').appendChildren(text('summary', 'party-advanced-summary', t('partyServer')), server),
    );
  }

  function renderInside() {
    const others = info.members.filter(({ id }) => id !== info.you);
    const leader = info.members.find(({ leader }) => leader);
    const ordered = [...info.members].sort(
      (a, b) => b.leader - a.leader || (b.id === info.you) - (a.id === info.you) || a.name.localeCompare(b.name),
    );

    const copy = button(t('partyCopyInvite'), async () => {
      await navigator.clipboard.writeText(info.invite);
      copy.setText(`✓ ${t('partyCopied')}`).addClass('done');
      setTimeout(() => copy.setText(t('partyCopyInvite')).removeClass('done'), 1600);
    }, 'primary');

    const statusLine =
      info.connection === 'online'
        ? info.isLeader
          ? t('partyYouLeadShort')
          : t('partyFollowingShort', { name: leader?.name || '…' })
        : t(`partyConnection_${info.connection}`) + (info.error === 'replaced' ? ` · ${t('partyError_replaced')}` : '');

    const members = el('ul', 'party-members');
    ordered.forEach((member) => {
      const state = member.leader ? 'leader' : member.status?.state || 'idle';
      const row = el('li', 'party-member').setAttribute('data-state', state).appendChildren(
        avatar(member.name),
        el('div', 'party-member-text').appendChildren(
          el('span', 'party-member-name').appendChildren(
            new Renderer('span').setText(member.name),
            ...(member.id === info.you ? [text('span', 'party-you', t('partyYou'))] : []),
          ),
          el('span', 'party-member-status').appendChildren(
            el('i', 'party-status-dot'),
            new Renderer('span').setText(member.leader ? t('partyLeader') : t(`partyStatus_${state}`)),
          ),
        ),
      );
      if (info.isLeader && !member.leader) {
        row.appendChildren(
          button(t('partyPromoteShort'), () => run({ action: 'promote', to: member.id }), 'ghost').setAttribute(
            'title',
            t('partyPromote'),
          ),
        );
      }
      members.appendChildren(row);
    });

    root.appendChildren(
      card(
        el('div', 'party-room').setAttribute('data-connection', info.connection).appendChildren(
          el('div', 'party-room-head').appendChildren(
            el('i', 'party-status-dot'),
            text('strong', 'party-room-title', statusLine),
            text('span', 'party-room-code', `${t('partyRoom')} ${info.room.slice(0, 6)}`),
          ),
          text('p', 'party-room-hint', t(info.isLeader ? 'partyLeaderHint' : 'partyFollowerHint')),
          copy,
        ),
      ),
      label(t('partyMembersTitle', { count: info.members.length })),
      card(members),
      ...(others.length === 0 ? [text('p', 'party-empty', t('partyAlone'))] : []),
      el('div', 'party-footer').appendChildren(
        ...(info.connection === 'error' ? [button(t('partyReconnect'), () => run({ action: 'reconnect' }))] : []),
        button(t('partyLeave'), () => run({ action: 'leave' }), 'danger'),
      ),
    );
  }

  function render() {
    root.removeChildren();
    if (!info) return root.appendChildren(text('p', 'party-empty', '…'));
    if (info.inRoom) renderInside();
    else renderOutside();
    if (error) root.appendChildren(text('p', 'party-error', error));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'party_update' && !busy) {
      info = message.info;
      render();
    }
  });

  chrome.storage.local.get(['party_name', 'party_server'], (items) => {
    prefs = { ...prefs, ...items };
    send({ action: 'get' })
      .then((next) => (info = next))
      .catch(() => (error = t('partyError_background')))
      .finally(render);
  });
  render();
  return root;
};
