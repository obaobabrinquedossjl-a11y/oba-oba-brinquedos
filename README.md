# Dashboard Oba Oba Brinquedos

Sistema local em HTML, CSS e JavaScript para gerenciar brinquedos, orçamentos e eventos aprovados.

## Como abrir

Abra o arquivo `public/index.html` no navegador ou execute `npm run dev`. Não é necessário instalar dependências além do Wrangler usado para desenvolvimento e publicação.

## Site publicado

O dashboard está hospedado gratuitamente no Cloudflare Workers:

https://oba-oba-brinquedos.oba-oba-brinquedos.workers.dev

Para publicar novas alterações, execute `npm install` uma vez e depois `npm run deploy`.

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
- persistência local no navegador (`localStorage`).

## Observação

Esta versão é totalmente local. A futura entrada automática de pedidos via WhatsApp/IA exigirá um backend, banco de dados e integração oficial com a API do WhatsApp.
