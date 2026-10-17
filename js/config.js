/* Supabase-Zugang für die Cloud-Sicherung (gleiches Projekt wie die Leichtathletik-App, Tabelle wp_records).
   url und anonKey: Supabase-Dashboard → Project Settings → API Keys (Publishable key). Der Key ist für den
   Browser gedacht; die Daten schützt die Zeilen-Sicherheit (Row Level Security) aus supabase/migrations/.
   Leer = Cloud-Sicherung ausgeschaltet. */
window.WP_CLOUD = {
  url: "https://hdtukcemlnhaoirdxitc.supabase.co",
  anonKey: "sb_publishable_mZEjHvyn3YdOXH5TLJWLwQ_TXnXkWyn",
};
