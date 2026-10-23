// Funções compartilhadas pelo servidor do Destrave (Supabase e Mercado Pago).
// Variáveis de ambiente usadas aqui (painel da Vercel > Settings > Environment Variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY   já existiam
//   SUPABASE_SERVICE_ROLE_KEY         secreta: chave service_role do Supabase (só aqui, nunca no config.js)
//   MP_ACCESS_TOKEN                   secreta: Access Token do Mercado Pago (credenciais de produção ou de teste)
//   PRECO                             opcional (padrão 47.90)
//   SITE_URL                          opcional: endereço do site, ex. https://destrave.com.br (padrão: o endereço do pedido)

const PRECO_PADRAO = 47.9;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function preco() {
  const n = Number(String(process.env.PRECO || "").replace(",", "."));
  return n > 0 ? Math.round(n * 100) / 100 : PRECO_PADRAO;
}
const centavos = v => Math.round(Number(v) * 100);

function faltando(nomes) {
  return nomes.filter(n => !process.env[n]);
}

// Endereço público do site, usado nas URLs de retorno e de aviso do Mercado Pago.
function siteUrl(req) {
  const env = String(process.env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  const host = String((req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "").split(",")[0].trim();
  return host ? `https://${host}` : "";
}

function tokenDe(req) {
  return String((req.headers && req.headers.authorization) || "").replace(/^Bearer\s+/i, "").trim();
}

// Quem é a pessoa por trás do token da sessão (o Supabase confere a assinatura).
async function usuarioDoToken(token) {
  if (!token) return null;
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error(`supabase auth ${r.status}`);
  const u = await r.json();
  return u && u.id ? u : null;
}

// Acesso à tabela "pedidos" com a chave service_role (só o servidor tem).
async function supa(caminho, { method = "GET", body, prefer } = {}) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: k, authorization: `Bearer ${k}`, "content-type": "application/json" };
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${caminho}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (!r.ok) throw new Error(`supabase ${method} ${caminho.split("?")[0]} ${r.status}: ${typeof d === "string" ? d : JSON.stringify(d)}`);
  return d;
}

async function pedidosDe(usuario) {
  return (await supa(`pedidos?usuario=eq.${usuario}&order=criado_em.desc&limit=20`)) || [];
}
async function pedidoPorId(id) {
  if (!UUID.test(String(id || ""))) return null;
  const l = await supa(`pedidos?id=eq.${id}&limit=1`);
  return (l && l[0]) || null;
}
async function atualizarPedido(id, campos) {
  const l = await supa(`pedidos?id=eq.${id}`, {
    method: "PATCH",
    body: Object.assign({}, campos, { atualizado_em: new Date().toISOString() }),
    prefer: "return=representation",
  });
  return (l && l[0]) || null;
}

// Chamada à API do Mercado Pago.
async function mp(caminho, { method = "GET", body, idempotencia } = {}) {
  const headers = { authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`, "content-type": "application/json" };
  if (idempotencia) headers["x-idempotency-key"] = idempotencia;
  const r = await fetch(`https://api.mercadopago.com${caminho}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = {};
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, dados: d };
}

// Situação do pagamento no Mercado Pago -> situação do pedido.
function statusDoPedido(pagamentoStatus) {
  if (pagamentoStatus === "approved") return "pago";
  if (["pending", "in_process", "authorized", "in_mediation"].includes(pagamentoStatus)) return "pendente";
  if (["refunded", "charged_back"].includes(pagamentoStatus)) return "estornado";
  if (["rejected", "cancelled"].includes(pagamentoStatus)) return "recusado";
  return null;
}

// Aplica ao pedido o que o Mercado Pago diz sobre um pagamento.
// A fonte da verdade é sempre a API do Mercado Pago, consultada com o nosso Access Token:
// um aviso falso ou um parâmetro de URL alterado não liberam nada.
// usuarioEsperado: quando informado, o pedido precisa ser dessa pessoa.
async function aplicarPagamento(pagamento, { usuarioEsperado } = {}) {
  if (!pagamento || !pagamento.id) return { ok: false, motivo: "pagamento_invalido" };
  const pedido = await pedidoPorId(pagamento.external_reference);
  if (!pedido) return { ok: false, motivo: "pedido_nao_encontrado" };
  if (usuarioEsperado && pedido.usuario !== usuarioEsperado) return { ok: false, motivo: "pedido_de_outra_pessoa" };
  const novo = statusDoPedido(pagamento.status);
  if (!novo) return { ok: true, pedido };

  if (novo === "pago") {
    const valorOk = centavos(pagamento.transaction_amount) >= centavos(pedido.valor);
    const moedaOk = !pagamento.currency_id || pagamento.currency_id === "BRL";
    if (!valorOk || !moedaOk) {
      console.error(`[pagamento] valor ou moeda diferente no pedido ${pedido.id}: ${pagamento.transaction_amount} ${pagamento.currency_id}`);
      return { ok: false, motivo: "valor_divergente", pedido };
    }
  }
  // Um pedido pago só muda se o pagamento que o liberou for estornado.
  if (pedido.status === "pago" && novo !== "estornado") return { ok: true, pedido };
  if (pedido.status === "pago" && novo === "estornado" && pedido.mp_pagamento && pedido.mp_pagamento !== String(pagamento.id)) return { ok: true, pedido };
  if (pedido.status === "estornado" && novo !== "pago") return { ok: true, pedido };

  const campos = {
    status: novo,
    mp_pagamento: String(pagamento.id),
    metodo: pagamento.payment_type_id || pagamento.payment_method_id || null,
  };
  if (novo === "pago") campos.pago_em = pagamento.date_approved || new Date().toISOString();
  if (pagamento.payer && pagamento.payer.email && !pedido.email) campos.email = String(pagamento.payer.email).slice(0, 200);
  const atualizado = await atualizarPedido(pedido.id, campos);
  return { ok: true, pedido: atualizado || pedido };
}

async function buscarPagamento(id) {
  if (!/^\d{1,20}$/.test(String(id || ""))) return null;
  const r = await mp(`/v1/payments/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`mercado pago payments ${r.status}`);
  return r.dados;
}

// Pagamentos do Mercado Pago ligados a um pedido (usado quando a pessoa volta sem o número do pagamento).
async function pagamentosDoPedido(pedidoId) {
  const r = await mp(`/v1/payments/search?external_reference=${encodeURIComponent(pedidoId)}&sort=date_created&criteria=desc`);
  if (!r.ok) throw new Error(`mercado pago search ${r.status}`);
  return Array.isArray(r.dados.results) ? r.dados.results : [];
}

function resumo(pedidos) {
  const pago = pedidos.find(p => p.status === "pago");
  if (pago) return { pago: true, status: "pago", pagoEm: pago.pago_em };
  const ultimo = pedidos[0];
  return { pago: false, status: ultimo ? ultimo.status : "sem_pedido" };
}

module.exports = {
  preco, centavos, faltando, siteUrl, tokenDe, usuarioDoToken, supa, pedidosDe, pedidoPorId,
  atualizarPedido, mp, statusDoPedido, aplicarPagamento, buscarPagamento, pagamentosDoPedido, resumo, UUID,
};
