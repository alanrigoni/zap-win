# ZapWin

Cliente não oficial do WhatsApp Web para Windows, inspirado no [ZapZap](https://rtosta.com/zapzap/).
Instala como um programa normal (menu Iniciar, atalho na área de trabalho, desinstalador em "Aplicativos").

## Recursos

- Várias contas do WhatsApp lado a lado (barra lateral), cada uma com seus próprios dados
- Ícone na bandeja: fechar a janela mantém o app rodando; selo vermelho quando há mensagens não lidas
- Contador de não lidas na barra de tarefas e piscar quando chega mensagem
- Notificações nativas do Windows; clicar abre a conta certa
- Iniciar com o Windows (minimizado na bandeja)
- Corretor ortográfico em português e inglês, zoom por conta, links abrem no navegador

## Atalhos

| Atalho | Ação |
| --- | --- |
| Ctrl+1 … Ctrl+9 | Trocar de conta |
| Ctrl+Shift+N | Nova conta |
| Ctrl+R | Recarregar conta atual |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom |
| Ctrl+W | Ocultar na bandeja |
| Ctrl+Q | Sair |
| Alt | Mostrar a barra de menus |

Clique com o botão direito em uma conta na barra lateral para renomear, trocar a cor ou remover.

## Desenvolvimento

Requer Node.js 20+.

```sh
npm install
npm start          # roda o app
npm run dist       # gera o instalador em dist/
npm run icon       # regenera o ícone
```

> Se `npm start` abrir sem janela dentro do terminal do VS Code, rode `Remove-Item Env:ELECTRON_RUN_AS_NODE` antes
> (o VS Code define essa variável e ela faz o Electron rodar como Node puro).

Os dados ficam em `%APPDATA%\ZapWin`.
