> **Fork com detecção de fillers.** Este fork adiciona um selo canon/filler/misto (dados do
> [AnimeFillerList](https://www.animefillerlist.com)) na página do episódio e nos cards da série, e uma opção
> de pular fillers (perguntar ou automático) em *Integrações → Fillers*. A série é casada pelo título; se errar,
> clique no selo do episódio para apontar o link certo do AFL ou ajustar a numeração. Única permissão extra:
> leitura de `https://www.animefillerlist.com/*`.
>
> **Watch party.** Salas para assistir junto (*Watch party* no popup): cada pessoa usa a própria conta do
> Crunchyroll e o líder controla play, pausa, avanço, velocidade e troca de episódio — inclusive os skips de
> abertura e de filler. Ao trocar de episódio, o play espera todo mundo carregar. O relay é um Cloudflare
> Worker em [`party-server/`](party-server/); pelo servidor passam só o ID do episódio, posição, play/pause,
> velocidade e apelidos — nenhum cookie, token ou dado da conta.

# Improve Crunchyroll

#### [Chrome Web Store](https://chrome.google.com/webstore/detail/crunchyroll-bigger-player/elmhfjhlecffodalffipmgpploaihjgh)

#### [Edge Addons](https://microsoftedge.microsoft.com/addons/detail/improve-crunchyroll/jkdpkopdoookfdobegpdbacmbnlacgjk)

#### [Firefox Addons](https://addons.mozilla.org/en-US/firefox/addon/improve-crunchyroll) (firefox branch)

### Descriptions

- [English](docs/en/description.md)
- [Español](docs/es/description.md)
- [Français](docs/fr/description.md)
- [Português (Brasil)](docs/pt_BR/description.md)
- [Deutsch](docs/de/description.md)

### Translations

- [English](_locales/en/messages.json)
- [Español](_locales/es/messages.json)
- [Français](_locales/fr/messages.json)
- [Português (Brasil)](_locales/pt_BR/messages.json)
- [Deutsch](_locales/de/messages.json)

### Manual/Development installation instructions

1. Clone this repository.
2. In Chrome, go to chrome://extensions.
3. In the top right corner, click the "Developer Mode" checkbox.
4. Click the now-visible "Load unpacked" button. Navigate to the directory where you jusrt cloned the repository.
5. The _Improve Crunchyroll_ extension should now be visible in your extensions list.
