// Single source of truth for Supabase project credentials.
// New project (fresh schema) — old project's users/data are migrated in later.
export const SUPABASE_URL = 'https://cgtxenthsrgxrsfjjbci.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNndHhlbnRoc3JneHJzZmpqYmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyMjI2NTEsImV4cCI6MjEwMDc5ODY1MX0.mkEf-SR2WKMJCEr2aPtPwIkeH5j-UCgkaDKpHO2mEZE';

// Pages now live either at the site root or one level down in a section
// folder (assessment/, later exam/). Cross-section links (to root pages,
// css/, js/, images/) need this prefix; same-folder links don't.
export function basePath() {
  return /\/(assessment|exam)\//.test(window.location.pathname) ? '../' : '';
}
