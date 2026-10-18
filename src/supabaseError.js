/**
 * A one-line version of a Supabase error message. When Supabase can't be
 * reached, Cloudflare answers with a whole HTML error page and supabase-js
 * puts all of it in error.message; keep just the page title instead.
 */
export function supabaseMessage(error) {
  const msg = String(error?.message ?? error ?? "");
  if (!/<html|<!doctype/i.test(msg)) return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
  const title = msg.match(/<title>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  return title ? `HTML error page: ${title}` : "HTML error page (Supabase unreachable)";
}
