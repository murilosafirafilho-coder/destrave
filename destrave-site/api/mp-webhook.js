// Aviso do Mercado Pago quando um pagamento muda (aprovado, pendente, recusado, estornado).
// Por segurança, o conteúdo do aviso não é usado: pegamos só o número do pagamento e
// consultamos a API do Mercado Pago com o nosso Access Token. Um aviso falso não libera nada.
const S = require("../lib/servidor.js");

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ ok: false });
  if (S.faltando(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MP_ACCESS_TOKEN"]).length) {
    console.error("[api/mp-webhook] servidor sem configuração de pagamento");
    return res.status(500).json({ ok: false });
  }
  const q = req.query || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const tipo = String(q.type || q.topic || body.type || body.topic || "");
  const id = String(q["data.id"] || (body.data && body.data.id) || (tipo === "payment" ? q.id || "" : "") || "");

  // Avisos de outros tipos (pedido do comerciante, etc.) são só confirmados.
  if (tipo && tipo !== "payment") return res.status(200).json({ ok: true, ignorado: tipo });
  if (!/^\d{1,20}$/.test(id)) return res.status(200).json({ ok: true, ignorado: "sem id" });

  try {
    const pg = await S.buscarPagamento(id);
    if (!pg) return res.status(200).json({ ok: true, ignorado: "pagamento não encontrado" });
    const r = await S.aplicarPagamento(pg);
    if (!r.ok) console.error(`[api/mp-webhook] pagamento ${id}: ${r.motivo}`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    // Erro nosso ou do Mercado Pago: responde 500 para o Mercado Pago tentar de novo mais tarde.
    console.error(`[api/mp-webhook] pagamento ${id}: ${e && e.message || e}`);
    return res.status(500).json({ ok: false });
  }
};
