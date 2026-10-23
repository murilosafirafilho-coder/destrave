// Diagnóstico da configuração. Abra no navegador: https://SEU-SITE/api/diagnostico
// Mostra só o que está certo ou errado, nunca as chaves. Faz uma chamada mínima à IA (custo desprezível).
// Depois que tudo estiver funcionando, pode apagar este arquivo do GitHub.

module.exports = async function handler(req, res) {
  const r = { variaveis: {}, supabase: "", anthropic: {}, conclusao: [] };
  const key = process.env.ANTHROPIC_API_KEY || "", url = process.env.SUPABASE_URL || "", anon = process.env.SUPABASE_ANON_KEY || "";

  r.variaveis.ANTHROPIC_API_KEY = key ? (key.startsWith("sk-ant-") ? "ok" : "preenchida, mas não parece uma chave da Anthropic (deveria começar com sk-ant-)") : "FALTANDO";
  r.variaveis.SUPABASE_URL = url ? (/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) ? "ok" : "formato errado: use https://<projeto>.supabase.co, sem /rest/v1 e sem barra no fim") : "FALTANDO";
  r.variaveis.SUPABASE_ANON_KEY = anon ? (anon.length > 20 ? "ok" : "parece incompleta") : "FALTANDO";
  const servico = process.env.SUPABASE_SERVICE_ROLE_KEY || "", mpToken = process.env.MP_ACCESS_TOKEN || "";
  r.variaveis.SUPABASE_SERVICE_ROLE_KEY = servico ? (servico === anon ? "ERRADA: é a chave anon; use a service_role" : servico.length > 20 ? "ok" : "parece incompleta") : "FALTANDO";
  r.variaveis.MP_ACCESS_TOKEN = mpToken ? (/^(APP_USR|TEST)-/.test(mpToken) ? "ok" : "preenchida, mas não parece um Access Token do Mercado Pago (deveria começar com APP_USR- ou TEST-)") : "FALTANDO";

  // Supabase: a função usar_ia existe? (sem sessão, ela deve recusar; se não existir, o SQL não foi rodado)
  if (url && anon) {
    try {
      const s = await fetch(`${url}/rest/v1/rpc/registrar_uso`, { method: "POST", headers: { apikey: anon, "content-type": "application/json" }, body: JSON.stringify({ p_tipo: "chat" }) });
      const t = await s.text();
      if (/Could not find the function|PGRST202/i.test(t)) r.supabase = "o banco responde, mas a função registrar_uso não existe: rode o supabase.sql novo no SQL Editor";
      else if (s.status === 401 || s.status === 403 || /permission denied/i.test(t)) r.supabase = "ok (banco e função encontrados)";
      else if (s.status >= 500) r.supabase = `o Supabase respondeu com erro ${s.status}`;
      else r.supabase = `resposta inesperada (${s.status}): ${t.slice(0, 160)}`;
    } catch (e) { r.supabase = "não foi possível falar com o Supabase: confira SUPABASE_URL"; }
  } else r.supabase = "não testado (faltam variáveis)";

  // Pagamento: a tabela de pedidos existe e a chave service_role funciona? O Access Token do Mercado Pago vale?
  r.pagamento = {};
  if (url && servico) {
    try {
      const p = await fetch(`${url}/rest/v1/pedidos?select=id&limit=1`, { headers: { apikey: servico, authorization: `Bearer ${servico}` } });
      const t = await p.text();
      if (p.ok) r.pagamento.pedidos = "ok (tabela de pedidos acessível pelo servidor)";
      else if (/does not exist|PGRST205|42P01/i.test(t)) r.pagamento.pedidos = "a tabela pedidos não existe: rode o supabase.sql novo no SQL Editor";
      else if (p.status === 401) r.pagamento.pedidos = "chave service_role recusada: confira SUPABASE_SERVICE_ROLE_KEY";
      else r.pagamento.pedidos = `resposta inesperada (${p.status}): ${t.slice(0, 160)}`;
    } catch (e) { r.pagamento.pedidos = "não foi possível falar com o Supabase"; }
  } else r.pagamento.pedidos = "não testado (falta a chave service_role)";
  if (mpToken) {
    try {
      const m = await fetch("https://api.mercadopago.com/users/me", { headers: { authorization: `Bearer ${mpToken}` } });
      const d = await m.json().catch(() => ({}));
      if (m.ok) r.pagamento.mercado_pago = `ok (conta ${d.nickname || d.id || "encontrada"}${d.site_id ? ", " + d.site_id : ""})`;
      else if (m.status === 401) r.pagamento.mercado_pago = "Access Token recusado: copie de novo em Suas integrações > Credenciais";
      else r.pagamento.mercado_pago = `erro ${m.status}`;
    } catch (e) { r.pagamento.mercado_pago = "não foi possível falar com o Mercado Pago"; }
  } else r.pagamento.mercado_pago = "não testado (falta MP_ACCESS_TOKEN)";
  r.pagamento.site = process.env.SITE_URL ? `SITE_URL = ${process.env.SITE_URL}` : `sem SITE_URL: usando o endereço do pedido (${req.headers.host || "?"})`;

  // Anthropic: uma chamada mínima com cada modelo, do mesmo jeito que o app usa (sem "pensar" antes de responder)
  const modelos = { planos: process.env.MODELO_PADRAO || "claude-sonnet-5-5", suporte: process.env.MODELO_RAPIDO || "claude-haiku-5-5" };
  const pensamento = m => /haiku/i.test(m) ? { type: "disabled" } : /sonnet-5/i.test(m) ? { type: "between_tools" } : undefined;
  r.anthropic = {};
  for (const [uso, modelo] of Object.entries(modelos)) {
    if (!key) { r.anthropic[uso] = "não testado (falta a chave)"; continue; }
    const corpo = { model: modelo, max_tokens: 64, messages: [{ role: "user", content: "Responda só com a palavra ok." }] };
    if (pensamento(modelo)) corpo.thinking = pensamento(modelo);
    try {
      const a = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const d = await a.json().catch(() => ({}));
      const msg = (d.error && d.error.message) || "";
      const texto = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      if (a.ok && texto) r.anthropic[uso] = `ok (${modelo} respondeu com texto)`;
      else if (a.ok) r.anthropic[uso] = `${modelo} respondeu SEM texto (motivo: ${d.stop_reason}; blocos: ${(d.content || []).map(b => b.type).join(",") || "nenhum"})`;
      else if (a.status === 401) r.anthropic[uso] = "chave inválida: crie outra no Console e troque ANTHROPIC_API_KEY";
      else if (/credit balance|billing|credits/i.test(msg)) r.anthropic[uso] = "sem créditos: adicione créditos em Settings > Billing no Console da Anthropic";
      else if (a.status === 404) r.anthropic[uso] = `modelo ${modelo} não encontrado: ${msg}`;
      else r.anthropic[uso] = `${modelo}: erro ${a.status}: ${msg}`;
    } catch (e) { r.anthropic[uso] = "não foi possível falar com a Anthropic"; }
  }

  const ruins = Object.entries(r.variaveis).filter(([, v]) => v !== "ok").map(([k, v]) => `${k}: ${v}`);
  if (ruins.length) r.conclusao.push("Corrija as variáveis na Vercel (Settings > Environment Variables) e depois faça Redeploy: " + ruins.join(" | "));
  if (!r.supabase.startsWith("ok")) r.conclusao.push("Supabase: " + r.supabase);
  for (const [uso, v] of Object.entries(r.anthropic)) if (!String(v).startsWith("ok")) r.conclusao.push(`Anthropic (${uso}): ${v}`);
  for (const k of ["pedidos", "mercado_pago"]) if (!String(r.pagamento[k]).startsWith("ok")) r.conclusao.push(`Pagamento (${k}): ${r.pagamento[k]}`);
  if (!r.conclusao.length) r.conclusao.push("Tudo certo. Se a geração ainda falhar, confira se o login anônimo está ligado no Supabase (Authentication > Providers).");
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(r);
};
