const debug = process.env.VERSIE_DEBUG === "true";

export const logger = {
  debug: (msg: string) => {
    if (debug) console.error(`[versie:debug] ${msg}`);
  },
  info: (msg: string) => {
    console.error(`[versie] ${msg}`);
  },
  error: (msg: string) => {
    console.error(`[versie:error] ${msg}`);
  },
};
