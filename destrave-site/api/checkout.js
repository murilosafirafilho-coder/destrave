// Abre a compra do desafio no Mercado Pago (Checkout Pro) e devolve o link do pagamento.
// O app chama com a sessão da pessoa; o preço vem do servidor, nunca do app.
const S = require("../lib/servidor.js");

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const LINK_VALE_HORAS = 20; // reaproveita o mesmo link por algumas horas, em vez de criar um pedido a cada toque

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const falha = (status, code, message) => { console.error(`[api/checkout] ${status} ${code}: ${message || code}`); return res.status(status).json({ code, message: message || code }); };
  if (req.method !== "POST") return falha(405, "invalid_request", "Use POST.");
  const faltam = S.faltando(["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "MP_ACCESS_TOKEN"]);
  if (faltam.length) return falha(500, "nao_configurado", "Pagamento ainda não configurado: faltam " + faltam.join(", ") + " na Vercel.");

  let usuario;
  try { usuario = await S.usuarioDoToken(S.tokenDe(req)); } catch (e) { return falha(502, "upstream_error", "Não foi possível conferir a sessão."); }
  if (!usuario) return falha(401, "not_granted", "Sem sessão.");

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const email = EMAIL.test(String(body.email || "").trim()) ? String(body.email).trim().toLowerCase() : null;
  const site = S.siteUrl(req);
  if (!site) return falha(500, "nao_configurado", "Não foi possível descobrir o endereço do site: defina SITE_URL na Vercel.");

  try {
    const pedidos = await S.pedidosDe(usuario.id);
    if (pedidos.some(p => p.status === "pago")) return res.status(200).json({ pago: true });

    // Reaproveita um link recente ainda não pago.
    const valor = S.preco();
    const recente = pedidos.find(p => p.mp_link && (p.status === "criado" || p.status === "pendente") &&
      S.centavos(p.valor) === S.centavos(valor) && Date.now() - new Date(p.criado_em).getTime() < LINK_VALE_HORAS * 3600e3);
    if (recente) return res.status(200).json({ url: recente.mp_link, pedido: recente.id });

    const criado = await S.supa("pedidos", {
      method: "POST",
      body: { usuario: usuario.id, valor, email },
      prefer: "return=representation",
    });
    const pedido = criado && criado[0];
    if (!pedido) return falha(502, "upstream_error", "Não foi possível registrar o pedido.");

    const retorno = `${site}/?pagamento=retorno`;
    const preferencia = {
      items: [{
        id: "desafio-7-dias",
        title: "Destrave o Sucesso em 7 Dias",
        description: "Desafio de 7 dias com plano pessoal",
        category_id: "services",
        quantity: 1,
        currency_id: "BRL",
        unit_price: valor,
      }],
      external_reference: pedido.id,
      back_urls: { success: retorno, pending: retorno, failure: retorno },
      auto_return: "approved",
      notification_url: `${site}/api/mp-webhook`,
      statement_descriptor: "DESTRAVE",
      // Boleto leva até 3 dias úteis: fica de fora para a liberação ser imediata (Pix e cartão).
      payment_methods: { excluded_payment_types: [{ id: "ticket" }] },
      metadata: { pedido: pedido.id },
    };
    if (email) preferencia.payer = { email };

    const r = await S.mp("/checkout/preferences", { method: "POST", body: preferencia, idempotencia: pedido.id });
    const link = r.dados && (r.dados.init_point || r.dados.sandbox_init_point);
    if (!r.ok || !link) {
      const msg = (r.dados && (r.dados.message || r.dados.error)) || `status ${r.status}`;
      await S.atualizarPedido(pedido.id, { status: "recusado" }).catch(() => {});
      if (r.status === 401 || r.status === 403) return falha(500, "nao_configurado", "Mercado Pago recusou o Access Token: confira MP_ACCESS_TOKEN.");
      return falha(502, "upstream_error", "O Mercado Pago não abriu o pagamento: " + msg);
    }
    await S.atualizarPedido(pedido.id, { mp_preferencia: String(r.dados.id || ""), mp_link: link });
    return res.status(200).json({ url: link, pedido: pedido.id });
  } catch (e) {
    return falha(502, "upstream_error", String(e && e.message || e));
  }
};
