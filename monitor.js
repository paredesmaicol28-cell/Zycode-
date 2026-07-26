// monitor.js

// Tokens desde las variables de entorno
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export async function monitor() {
  try {
    const status = {
      project: "ZyCode",
      health: "healthy",

      github: {
        connected: !!GITHUB_TOKEN
      },

      railway: {
        connected: !!RAILWAY_TOKEN
      },

      vercel: {
        connected: !!VERCEL_TOKEN
      },

      supabase: {
        connected: !!SUPABASE_URL && !!SUPABASE_KEY
      },

      logs: [],
      events: []
    };

    return status;

  } catch (error) {
    return {
      project: "ZyCode",
      health: "unknown",
      error: error.message
    };
  }
}
