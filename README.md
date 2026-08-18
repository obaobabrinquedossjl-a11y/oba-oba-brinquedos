# Dashboard Oba Oba Brinquedos

Sistema local em HTML, CSS e JavaScript para gerenciar brinquedos, orçamentos e eventos aprovados.

## Como abrir

Abra o arquivo `public/index.html` no navegador ou execute `npm run dev`. Não é necessário instalar dependências além do Wrangler usado para desenvolvimento e publicação.

## Site publicado

O dashboard está hospedado gratuitamente no Cloudflare Workers:

https://oba-oba-brinquedos.oba-oba-brinquedos.workers.dev

Para publicar novas alterações, execute `npm install` uma vez e depois `npm run deploy`.

## Banco de dados

Os dados do dashboard são compartilhados pelo Cloudflare D1 `oba-oba-brinquedos-db`. A API roda no mesmo Worker em `/api/state`, e o navegador mantém uma cópia local de segurança para períodos sem conexão.

Fluxo de desenvolvimento:

```bash
npm install
npm run db:migrate:local
npm run dev
```

Publicação:

```bash
npm run db:migrate:remote
npm run typecheck
npm run deploy
```

## O que já funciona

- cadastro, edição e exclusão de brinquedos;
- cadastro completo de clientes com contato, documento, endereço e observações;
- múltiplos endereços identificados por cliente, selecionáveis durante o orçamento;
- perfil individual do cliente com métricas e histórico de orçamentos;
- upload e compressão de fotos;
- preço por diária e quantidade em estoque;
- criação de orçamento selecionando um cliente cadastrado, com cálculo automático de total, sinal e saldo;
- prévia no padrão visual do orçamento de referência;
- impressão ou salvamento em PDF pelo navegador;
- status de rascunho, enviado e aprovado;
- aprovação com validação de estoque para a data escolhida;
- calendário mensal com vários eventos no mesmo dia;
- dados da empresa personalizáveis;
- persistência compartilhada no Cloudflare D1 com cópia local de segurança (`localStorage`).

## Observação

A futura entrada automática de pedidos via WhatsApp/IA poderá utilizar a API do Worker, mas ainda exigirá autenticação e integração oficial com a API do WhatsApp.
