// Situação da compra da pessoa. O app chama ao voltar do Mercado Pago (com payment_id)
// e de tempos em tempos enquanto um Pix está pendente.
// Nunca confia no que vem na URL: confere o pagamento na API do Mercado Pago.
const S = require("../lib/servidor.js");

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const falha = (status, code, message) => { console.error(`[api/pagamento] ${status} ${code}: ${message || code}`); return res.status(status).json({ code, message: message || code }); };
  if (req.method !== "POST") return falha(405, "invalid_request", "Use POST.");
  const faltam = S.faltando(["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "MP_ACCESS_TOKEN"]);
  if (faltam.length) return falha(500, "nao_configurado", "Pagamento ainda não configurado: faltam " + faltam.join(", ") + " na Vercel.");

  let usuario;
  try { usuario = await S.usuarioDoToken(S.tokenDe(req)); } catch (e) { return falha(502, "upstream_error", "Não foi possível conferir a sessão."); }
  if (!usuario) return falha(401, "not_granted", "Sem sessão.");
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    let pedidos = await S.pedidosDe(usuario.id);
    if (pedidos.some(p => p.status === "pago")) return res.status(200).json(S.resumo(pedidos));

    // 1) Voltou do Mercado Pago com o número do pagamento.
    if (body.payment_id) {
      const pg = await S.buscarPagamento(body.payment_id);
      if (pg) await S.aplicarPagamento(pg, { usuarioEsperado: usuario.id });
    } else {
      // 2) Sem número: procura pagamentos dos pedidos recentes ainda em aberto.
      const abertos = pedidos.filter(p => p.status === "criado" || p.status === "pendente").slice(0, 3);
      for (const p of abertos) {
        const lista = await S.pagamentosDoPedido(p.id);
        const melhor = lista.find(x => x.status === "approved") || lista[0];
        if (melhor) await S.aplicarPagamento(melhor, { usuarioEsperado: usuario.id });
      }
    }
    pedidos = await S.pedidosDe(usuario.id);
    return res.status(200).json(S.resumo(pedidos));
  } catch (e) {
    return falha(502, "upstream_error", String(e && e.message || e));
  }
};
