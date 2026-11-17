# Brazilian Portuguese glossary

The words the Brazilian Portuguese catalog (`pt_BR`) and core's phrasebook (`packages/core/src/bug-phrases.pt.ts`)
use for the terms that come back everywhere. The tone is the one of `store/amo-description.pt_BR.md`: plain sentences,
`você`, and the technical words Brazilian developers use as they are (*locator*, *test id*, *page object*, *branch*).
This is a draft: no native reader has reviewed it yet.

| English | Brazilian Portuguese | Notes |
| --- | --- | --- |
| locator | locator (masculino) | `o locator`, `os locators`; never *seletor*, which is a CSS selector |
| locator index | índice de locators | |
| selector (CSS) | seletor | only for CSS or XPath selectors |
| test id | test id | code, kept as it is |
| run | execução | |
| flaky | instável | |
| passed / failed | aprovado / com falha | `um teste com falha` |
| step | passo | `Passos para reproduzir`, as bug trackers say it |
| assertion | asserção (feminino) | |
| page object | page object | as Brazilian developers say it |
| helper function | função auxiliar | |
| test function | função de teste | |
| recording / to record | gravação / gravar | |
| bug report | relatório de bug | |
| to report (a bug) | relatar | |
| to replay | reproduzir | `Reproduzir um relatório de bug`; the verdict's "reproduced" is the same verb |
| screenshot | captura de tela | `fazer uma captura de tela` |
| tested elements | elementos testados | the tool's name, capitalized as a title: *Elementos testados* |
| URL pattern | padrão de endereço | the settings section's name, in the plural: *Padrões de endereço* |
| watch (a locator's stability level) | a observar | the level between stable and brittle, *Watch* in the dashboard |
| branch | branch (feminino) | `a branch`, `todas as branches` |
| instance (Piwi) | instância | `sua instância do Piwi` |
| team instance | instância da equipe | `sua instância da equipe`; Piwi Runner's word for the instance that sends it run requests |
| run request | pedido de execução | `o pedido`; *requisição* stays for an HTTP request |
| linked folder / to link, to unlink | pasta vinculada / vincular, desvincular | `a pasta vinculada a esse projeto` |
| tray (system tray) | área de notificação | `na área de notificação`; the tray menu is its menu |
| local host (Piwi Runner's) | servidor local | the Node process that serves Runner's window; not the code word `localhost` |
| worker (Playwright) | worker (masculino) | `o worker`, `os workers`, as the Runs window says it |
| stop (a test stopped at a line) | parada | `esta parada`; the state is `Parado em um ponto de interrupção` |
| breakpoint | ponto de interrupção | |
| live view / share live | visualização ao vivo / compartilhar ao vivo | `Parar de compartilhar` |
| sign-in (on the instance) / to allow (an app) | login / autorizar | `O login na instância expirou`, `autorize o Piwi Runner` |
| API key | chave de API | |
| settings | configurações | the gear button and the settings page |
| dashboard | painel | `o painel do Piwi` |
| popup | este menu | when a text must name it; mostly avoided |
| background worker | processo em segundo plano | |
| to pick (an element) | escolher | |
| to hover | passar o mouse | |
| badge (on a box) | selo | the toolbar's badge is not named |
| to download | baixar | |
| to save | salvar | |
| to type (in a field) | digitar | |
| hidden / disabled | oculto / desabilitado | agree with the noun: `a imagem … oculta` |

## Tool names

The popup's tiles, and the same names in the panels, the store description and the phrasebook.

| English | Brazilian Portuguese |
| --- | --- |
| Pick an element | Escolher elemento |
| Hover-inspect | Inspecionar |
| Locator console | Console |
| Multi-pick | Multisseleção |
| Lint overlay | Verificação |
| Assertions | Asserções |
| Session | Sessão |
| Agent context | Contexto de IA |
| Test functions | Funções de teste |
| Record | Gravar |
| Replay | Reproduzir |
| Check an element | Verificar um elemento |
| Tested elements | Elementos testados |

## Typography

- `“ ”` around a quoted text, with no space inside: `o botão “Apply coupon”`.
- No space before `:`, `;`, `!` or `?`.
- `…` rather than three dots.
- `em` contracts with the article: `no botão`, `na lista`, `em um elemento`; `de` likewise: `do campo`, `da página`.
- Numbers are formatted by the code: `1.234`. A percentage has no space: `40%`.
