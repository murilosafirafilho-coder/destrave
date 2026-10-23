// Entrega o brinde (PDF) só para quem comprou o desafio.
// O arquivo fica em /privado, fora do alcance direto do navegador (vercel.json redireciona /privado).
const fs = require("fs");
const path = require("path");
const S = require("../lib/servidor.js");

const ARQUIVO = path.join(__dirname, "..", "privado", "50-prompts-destrave.pdf");
const NOME = "50-Prompts-para-Destravar-sua-Vida.pdf";
// O desafio dura 7 dias no calendário: o brinde só sai a partir do 7º dia contado da data do pagamento
// (data de São Paulo, pelo relógio do servidor; mudar o relógio do celular não adianta).
const DIAS_MINIMOS = 6;
const diaSP = ts => new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const falha = (status, code, message) => { console.error(`[api/brinde] ${status} ${code}: ${message || code}`); return res.status(status).json({ code, message: message || code }); };
  // GET = só confere se o arquivo está no servidor (não entrega nada).
  if (req.method === "GET") {
    let bytes = 0;
    try { bytes = fs.statSync(ARQUIVO).size; } catch (e) {}
    return res.status(200).json({ arquivo: bytes > 0, bytes });
  }
  if (req.method !== "POST") return falha(405, "invalid_request", "Use POST.");
  const faltam = S.faltando(["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  if (faltam.length) return falha(500, "nao_configurado", "Faltam " + faltam.join(", ") + " na Vercel.");

  let usuario;
  try { usuario = await S.usuarioDoToken(S.tokenDe(req)); } catch (e) { return falha(502, "upstream_error", "Não foi possível conferir a sessão."); }
  if (!usuario) return falha(401, "not_granted", "Sem sessão.");

  try {
    const pedidos = await S.pedidosDe(usuario.id);
    const pago = pedidos.find(p => p.status === "pago");
    if (!pago) return falha(403, "nao_pago", "O brinde é liberado para quem comprou o desafio.");
    const inicio = diaSP(pago.pago_em || pago.atualizado_em || pago.criado_em);
    const passados = diasEntre(inicio, diaSP(Date.now()));
    if (passados < DIAS_MINIMOS) {
      const libera = new Date(Date.parse(inicio) + DIAS_MINIMOS * 864e5).toISOString().slice(0, 10);
      res.setHeader("cache-control", "no-store");
      return res.status(403).json({ code: "antes_do_dia7", message: "O brinde libera no fim do desafio.", liberaEm: libera });
    }
  } catch (e) {
    return falha(502, "upstream_error", String(e && e.message || e));
  }

  let pdf;
  try { pdf = fs.readFileSync(ARQUIVO); } catch (e) { return falha(500, "sem_arquivo", "O arquivo do brinde não foi encontrado no servidor."); }
  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", `attachment; filename="${NOME}"`);
  res.setHeader("content-length", String(pdf.length));
  return res.status(200).send(pdf);
};
