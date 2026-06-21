export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Supabase URL and anon/publishable key are SAFE to expose to the browser by design —
  // Row Level Security on the database is what actually protects user data, not key secrecy.
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
