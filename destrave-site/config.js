// Dados do projeto no Supabase (Project Settings > API).
// Estes dois valores são públicos por natureza: a segurança vem das regras da base (supabase.sql).
// NUNCA coloque aqui a chave da Anthropic nem a chave "service_role" do Supabase.
window.DESTRAVE_CONFIG = {
  SUPABASE_URL: "https://jorbovgldhnyistctauj.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpvcmJvdmdsZGhueWlzdGN0YXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0MjQ5MjQsImV4cCI6MjEwODAwMDkyNH0.ATE-gyJRwC6YGMbJx_MsJVZ5EGmeI3RVWOLdNyMkX04",
  // Google Agenda: "ID do cliente" OAuth (tipo Aplicativo da Web) do Google Cloud. É público. Vazio = botão mostra "em preparação".
  GOOGLE_CLIENT_ID: "",
};
