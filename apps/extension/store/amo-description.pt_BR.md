*Esta tradução é um rascunho: nenhum falante nativo a revisou ainda. Encontrou um erro? [Sugira uma correção](https://github.com/PiwiTests/piwi/issues/new?template=translation.yml).*

O Piwi Picker dá a você o locator do Playwright a usar para qualquer elemento da página em que você está. Cada candidato é pontuado pela estabilidade e depois executado na página como ela está, para que o primeiro encontre exatamente um elemento. Percorra um fluxo clicando e a extensão escreve o teste; reproduza um bug e ela escreve o teste que falha e o relatório.

**Pelo botão da barra de ferramentas, em qualquer página**

- **Escolher elemento**: os locators classificados de um elemento, conferidos de novo na página, para copiar sozinhos, como linha de ação ou como asserção. Quando vários elementos têm o mesmo nome, limite o locator a um elemento pai estável.
- **Gravar**: cliques, digitação e escolhas nas páginas de um site, transformados em um teste TypeScript pronto para rodar. As senhas nunca são gravadas.
- **Relatar um bug**: grave os passos, marque o que está errado na página e receba um teste que falha, um relatório em Markdown e um arquivo .piwibug com os erros do console e as requisições que falharam. **Reproduzir um relatório de bug** executa os passos dele de novo em uma aba.
- **Verificação**: os elementos que nenhum locator estável encontra sozinho, cada um com um data-testid sugerido.
- **Multisseleção**, **Asserções** e **Contexto de IA**: o padrão comum às linhas de uma lista, linhas expect(...) para um elemento e um bloco sobre um elemento para um agente de código.

**No DevTools do navegador**

Os locators classificados do elemento selecionado em Elementos, um console de locators com o veredito do modo estrito, os elementos que você nomeia exportados como page object, mocks de rede, uma requisição atrasada ou com falha, o viewport de um projeto do Playwright e Salvar o login para os testes.

**Privado por padrão**

Escolher e gravar nunca usam a rede. Nada é coletado, nada é enviado a lugar algum.

**Opcional: conectar sua própria instância do Piwi**

O Piwi é um painel auto-hospedado para os resultados do Playwright. Conectada à sua instância (o endereço dela e uma chave de API, nas configurações), a extensão também destaca os elementos da página que seus testes alcançam, mostra quais das suas funções de teste funcionam nela e grava os fluxos como chamadas a essas funções. Ela lê a sua instância e só envia uma coisa para ela: um relatório de bug, quando você clica em Enviar na prévia que mostra exatamente o que vai.

**Permissões**

- A aba que você está vendo, só quando você clica no botão da extensão ou usa o atalho de teclado.
- Um único site, pedido quando você começa a gravar nele, para acompanhar você de uma página a outra. Nada é concedido na instalação.
- Os cookies desse site, pedidos só quando você salva o login dele para os seus testes: eles vão para um arquivo na sua máquina.
- O endereço da sua instância do Piwi, pedido quando você salva uma conexão.

O Piwi Picker fala inglês, francês, alemão, espanhol e português do Brasil.

Documentação (em inglês): [piwitests.dev/features/extension](https://piwitests.dev/features/extension)

O Piwi não é afiliado à Microsoft Corporation, nem endossado ou apoiado por ela. Playwright é uma marca registrada da Microsoft Corporation.
