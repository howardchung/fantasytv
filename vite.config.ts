import fs from "node:fs";

const keyFile = process.env.SSL_KEY_FILE || "./certs/key.pem";
const certFile = process.env.SSL_CERT_FILE || "./certs/cert.pem";
const https =
  fs.existsSync(keyFile) && fs.existsSync(certFile)
    ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
    : undefined;

export default {
  server: {
    allowedHosts: true,
    https,
  },
};
