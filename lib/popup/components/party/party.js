// Watch party (fork): criar/entrar/sair de uma sala e ver quem está nela.
core.components.party = () => {
  const root = new Renderer('div').addClass('party');
  const t = (key) => Renderer.translate(key);
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
      const known = ['name', 'server', 'room', 'background'];
      error = t(`partyError_${known.includes(err.message) ? err.message : 'generic'}`);
    }
    busy = false;
    render();
  };

  const field = (label, input) =>
    new Renderer('label').addClass('party-field').appendChildren(new Renderer('span').setText(t(label)), input);

  const textInput = (value, placeholder) =>
    new InputRenderer('input').addClass('party-input').setAttribute('type', 'text').setAttribute('placeholder', placeholder || '').setValue(value || '');

  const button = (label, action, primary) =>
    new InputRenderer('button')
      .addClass('party-button', ...(primary ? ['primary'] : []))
      .setText(t(label))
      .setDisabled(busy)
      .addEventListener('click', action);

  function renderOutside() {
    const name = textInput(prefs.party_name, t('partyNamePlaceholder')).setAttribute('maxlength', '24');
    const code = textInput('', t('partyCodePlaceholder'));
    const server = textInput(prefs.party_server, info?.defaultServer);
    const common = () => ({ name: name.getValue(), server: server.getValue() });
    root.appendChildren(
      new Renderer('p').addClass('party-hint').setText(t('partyIntro')),
      field('partyName', name),
      button('partyCreate', () => run({ action: 'create', ...common() }), true),
      new Renderer('div').addClass('party-divider').setText(t('partyOr')),
      field('partyCode', code),
      button('partyJoin', () => run({ action: 'join', room: code.getValue(), ...common() })),
      new Renderer('details')
        .addClass('party-advanced')
        .appendChildren(new Renderer('summary').setText(t('partyServer')), server),
    );
  }

  function renderInside() {
    const connection = new Renderer('p')
      .addClass('party-connection')
      .setAttribute('data-connection', info.connection)
      .setText(t(`partyConnection_${info.connection}`) + (info.error === 'replaced' ? ` — ${t('partyError_replaced')}` : ''));
    const invite = textInput(info.invite).setAttribute('readonly', 'readonly');
    const copy = button('partyCopy', async () => {
      await navigator.clipboard.writeText(info.invite);
      copy.setText(t('partyCopied'));
      setTimeout(() => copy.setText(t('partyCopy')), 1500);
    });

    const members = new Renderer('ul').addClass('party-members');
    info.members.forEach((member) => {
      const row = new Renderer('li').appendChildren(
        new Renderer('span').addClass('party-member-name').setText(member.name + (member.id === info.you ? ` (${t('partyYou')})` : '')),
        new Renderer('span')
          .addClass('party-member-status')
          .setText(member.leader ? t('partyLeader') : t(`partyStatus_${member.status?.state || 'idle'}`)),
      );
      if (info.isLeader && !member.leader) {
        row.appendChildren(button('partyPromote', () => run({ action: 'promote', to: member.id })));
      }
      members.appendChildren(row);
    });

    root.appendChildren(
      connection,
      field('partyInvite', new Renderer('div').addClass('party-row').appendChildren(invite, copy)),
      new Renderer('p').addClass('party-hint').setText(t(info.isLeader ? 'partyLeaderHint' : 'partyFollowerHint')),
      members,
      ...(info.connection === 'error' ? [button('partyReconnect', () => run({ action: 'reconnect' }))] : []),
      button('partyLeave', () => run({ action: 'leave' })),
    );
  }

  function render() {
    root.removeChildren();
    if (!info) return root.appendChildren(new Renderer('p').addClass('party-hint').setText('…'));
    if (info.inRoom) renderInside();
    else renderOutside();
    if (error) root.appendChildren(new Renderer('p').addClass('party-error').setText(error));
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
