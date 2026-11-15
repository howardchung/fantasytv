import fs from "node:fs";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const keyFile = env.SSL_KEY_FILE || process.env.SSL_KEY_FILE;
  const certFile = env.SSL_CERT_FILE || process.env.SSL_CERT_FILE;
  const https =
    keyFile && certFile && fs.existsSync(keyFile) && fs.existsSync(certFile)
      ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
      : undefined;

  return {
    server: {
      allowedHosts: true,
      https,
    },
  };
});
