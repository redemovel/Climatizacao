# Climatização — ARPURO & REDEMÓVEL

Plataforma de gestão de climatização e ventilação mecânica (folhas de obra, agenda dos técnicos, clientes; mais tarde manutenções, stock e guias AT).

- Produção: https://redemovel.github.io/Climatizacao/ (`index.html`, `agenda.html`, `folhas.html`, `clientes.html`, `utilizadores.html`)
- Desenvolvimento: as mesmas páginas com `-dev` (ex.: `index-dev.html`). Usam a mesma base de dados; têm a barra roxa «DEV».

## Estrutura

```
src/layout.html          esqueleto HTML comum
src/shared/core.js       Firebase, sessão/perfis, menu, utilitários (NIF, datas, pesquisa)
src/shared/style.css     estilos (mobile-first)
src/pages/<pagina>.html  corpo de cada página      src/pages/<pagina>.js  código da página
build.js                 gera <pagina>.html e <pagina>-dev.html na raiz (NÃO editar os .html da raiz)
firestore.rules          regras de segurança (publicadas à mão na consola Firebase)
firestore.indexes.json   índices compostos necessários
test/                    simulação do Firebase (fake), dados de exemplo e testes Playwright
```

## Comandos

```
npm install          # só para o teste com o SDK real do Firebase
node build.js        # gera produção + dev   (node build.js --dev → só dev)
node test/run.js     # build + sintaxe + testes no browser   (--capturas grava PNG em test/capturas)
```
